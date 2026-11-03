import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apiDoc, metaDoc, wellKnown } from './test/fixtures.js'
import { KEY, SERVER, fakeInstance, json, rig } from './test/harness.js'

// [[API6]] cycle 1: the CLI against a fake instance (discovery, cache, origins, profiles, binary). The D1 app is cli.integration.test.ts.

const rigs: ReturnType<typeof rig>[] = []
afterEach(() => {
  while (rigs.length) rigs.pop()!.dispose()
})
const setup = (opts: Parameters<typeof fakeInstance>[0] = {}, rigOpts: Partial<Parameters<typeof rig>[0]> = {}) => {
  const inst = fakeInstance({ routes: (req) => (new URL(req.url).pathname === '/meta/v1/me' ? json({ principal: { id: 'p1', kind: 'agent' } }) : undefined), ...opts })
  const r = rig({ fetch: inst.fetch, ...rigOpts })
  rigs.push(r)
  return { inst, r }
}
const login = async (r: ReturnType<typeof rig>, server = SERVER, extra: string[] = [], key = KEY) => {
  const res = await r.run(['login', '--api-key', '--server', server, ...extra], { stdin: key + '\n' })
  expect(res.code).toBe(0)
}
const noKey = (...rs: { stdout: string; stderr: string }[]) => {
  for (const x of rs) {
    expect(x.stdout).not.toContain(KEY)
    expect(x.stderr).not.toContain(KEY)
  }
}
const errBody = (stderr: string) => JSON.parse(stderr).error as { code: string; message: string }
const authed = (r: ReturnType<typeof rig>) => r.seen.filter((s) => s.headers.authorization)

describe('commands come from the live documents', () => {
  it('runs a derived command, and an operation removed from the served document is no longer a command', async () => {
    const { r } = setup()
    await login(r)
    const ok = await r.run(['widgets', 'create', '--name', 'x'])
    expect(ok.code).toBe(1) // derived and sent: the fake instance has no such route (404 JSON from the API)
    expect(errBody(ok.stderr).code).toBe('not_found')

    const api = apiDoc()
    delete api.paths['/api/v1/widgets'].post
    const gone = setup({ api })
    await login(gone.r)
    const res = await gone.r.run(['widgets', 'create', '--name', 'x'])
    expect(res.code).toBe(2)
    expect(authed(gone.r).filter((s) => s.method === 'POST')).toEqual([])
    // the rest of the same resource is still derived
    expect((await gone.r.run(['widgets', 'list'])).code).toBe(1)
  })

  it('a "." or ".." path argument is exit 2 and no request carries the credential', async () => {
    const { r } = setup()
    await login(r)
    for (const bad of ['.', '..']) {
      expect((await r.run(['parts', 'delete', bad, 'p'])).code).toBe(2)
      expect((await r.run(['parts', 'get', 'w', bad])).code).toBe(2)
    }
    expect(authed(r)).toEqual([])
  })

  it('a command that is not in the documents exits 2 even if its name looks plausible', async () => {
    const { r } = setup()
    await login(r)
    const res = await r.run(['widgets', 'frobnicate'])
    expect(res.code).toBe(2)
    expect(errBody(res.stderr).code).toBe('usage')
  })
})

describe('output and exit codes', () => {
  it('prints the response as compact JSON on a pipe and indented on a terminal; an API error is JSON on stderr with exit 1', async () => {
    const { r } = setup({ routes: (req) => (new URL(req.url).pathname === '/meta/v1/me' ? json({ principal: { id: 'p1' } }) : json({ error: { code: 'forbidden', message: 'missing scope' } }, 403)) })
    await login(r)
    const piped = await r.run(['me', 'get'])
    expect(piped.code).toBe(0)
    expect(piped.stdout).toBe('{"principal":{"id":"p1"}}\n')
    const tty = await r.run(['me', 'get'], { tty: true })
    expect(tty.stdout).toBe('{\n  "principal": {\n    "id": "p1"\n  }\n}\n')
    const denied = await r.run(['widgets', 'list'])
    expect(denied.code).toBe(1)
    expect(denied.stdout).toBe('')
    expect(JSON.parse(denied.stderr)).toEqual({ error: { code: 'forbidden', message: 'missing scope' } })
  })

  it('a network failure is exit 1 with a JSON error; a non-JSON error body is wrapped', async () => {
    const { r } = setup({ routes: (req) => { throw new TypeError('connect ECONNREFUSED') } })
    await login(r)
    const net = await r.run(['me', 'get'])
    expect(net.code).toBe(1)
    expect(errBody(net.stderr).code).toBe('network_error')
    const html = setup({ routes: () => new Response('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }) })
    await login(html.r)
    const res = await html.r.run(['me', 'get'])
    expect(res.code).toBe(1)
    expect(errBody(res.stderr).code).toBe('http_502')
  })

  it('a 204 prints nothing and exits 0', async () => {
    const { r } = setup({ routes: () => new Response(null, { status: 204 }) })
    await login(r)
    const res = await r.run(['parts', 'delete', 'w', 'p'])
    expect(res).toMatchObject({ code: 0, stdout: '' })
  })

  it('--help lists the commands of the instance, and a command help lists its flags with their types', async () => {
    const { r } = setup()
    await login(r)
    const top = await r.run(['--help'])
    expect(top.code).toBe(0)
    for (const word of ['widgets', 'parts', 'api-keys', 'login', 'logout', 'config']) expect(top.stdout).toContain(word)
    const one = await r.run(['widgets', 'create', '--help'])
    expect(one.code).toBe(0)
    expect(one.stdout).toContain('Create a widget')
    expect(one.stdout).toContain('--size')
    expect(one.stdout).toContain('integer')
    const res = await r.run(['widgets', '--help'])
    expect(res.stdout).toMatch(/list[\s\S]*List widgets/)
  })
})

describe('cache (D7)', () => {
  it('a second run makes no document fetch inside the hour; after the hour it refetches; --refresh refetches', async () => {
    const { inst, r } = setup()
    await login(r)
    await r.run(['me', 'get'])
    expect(inst.counts).toEqual({ wellKnown: 1, api: 1, meta: 1 })
    await r.run(['me', 'get'])
    await r.run(['widgets', 'list'])
    expect(inst.counts).toEqual({ wellKnown: 1, api: 1, meta: 1 })
    r.advance(59 * 60_000)
    await r.run(['me', 'get'])
    expect(inst.counts).toEqual({ wellKnown: 1, api: 1, meta: 1 })
    r.advance(2 * 60_000)
    await r.run(['me', 'get'])
    expect(inst.counts).toEqual({ wellKnown: 2, api: 2, meta: 2 })
    await r.run(['me', 'get', '--refresh'])
    expect(inst.counts).toEqual({ wellKnown: 3, api: 3, meta: 3 })
  })

  it('an unknown command refreshes exactly once and then exits 2; on a cold cache it does not fetch twice', async () => {
    const { inst, r } = setup()
    await login(r)
    const cold = await r.run(['nope', 'x'])
    expect(cold.code).toBe(2)
    expect(inst.counts).toEqual({ wellKnown: 1, api: 1, meta: 1 })
    const warm = await r.run(['nope', 'x'])
    expect(warm.code).toBe(2)
    expect(inst.counts).toEqual({ wellKnown: 2, api: 2, meta: 2 })
  })

  it('an unknown command that the refreshed documents now define runs', async () => {
    const doc = apiDoc()
    delete doc.paths['/api/v1/widgets'].post
    const inst = fakeInstance({ api: doc, routes: () => json({ ok: true }) })
    const r = rig({ fetch: (req) => inst.fetch(req) })
    rigs.push(r)
    await login(r)
    expect((await r.run(['widgets', 'create'])).code).toBe(2)
    doc.paths['/api/v1/widgets'].post = apiDoc().paths['/api/v1/widgets'].post
    expect((await r.run(['widgets', 'create'])).code).toBe(0)
  })

  it('the cache is per server and holds no credential', async () => {
    const { r } = setup()
    await login(r)
    await r.run(['me', 'get'])
    const files = readdirSync(r.cacheDir).filter((f) => f !== 'config.json')
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) expect(readFileSync(join(r.cacheDir, f), 'utf8')).not.toContain(KEY)
    await login(r, 'http://localhost:9999', ['--profile', 'other'])
    await r.run(['me', 'get', '--profile', 'other'])
    expect(readdirSync(r.cacheDir).filter((f) => f !== 'config.json')).toHaveLength(files.length * 2)
  })
})

describe('missing /.well-known/vibase (D7)', () => {
  it('exits 2 naming the URL tried, and makes no fallback request to a fixed path', async () => {
    const { r } = setup({ wellKnown: () => json({ error: { code: 'not_found', message: 'no such route' } }, 404) })
    await login(r)
    const res = await r.run(['me', 'get'])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain(`${SERVER}/.well-known/vibase`)
    expect(r.seen.map((s) => new URL(s.url).pathname)).toEqual(['/.well-known/vibase'])
    expect(authed(r)).toEqual([])
  })

  it('a discovery document of the wrong shape is exit 2', async () => {
    const { r } = setup({ wellKnown: () => ({ api: 'x' }) })
    await login(r)
    expect((await r.run(['me', 'get'])).code).toBe(2)
  })
})

describe('same-origin rule for credentials (D18)', () => {
  const EVIL = 'https://evil.example'
  it('a document URL on another origin is exit 2 and nothing is sent there; no foreign request carries Authorization', async () => {
    for (const which of ['api', 'meta'] as const) {
      const { r } = setup({
        wellKnown: (origin) => {
          const w = wellKnown(origin)
          w.openapi[which] = `${EVIL}/${which}/openapi.json`
          return w
        },
      })
      await login(r)
      const res = await r.run(['me', 'get'])
      expect(res.code).toBe(2)
      expect(r.seen.filter((s) => s.url.startsWith(EVIL))).toEqual([])
      for (const s of authed(r)) expect(new URL(s.url).origin).toBe(SERVER)
      noKey(res)
    }
  })

  it('a document path that escapes to another origin is refused before any request leaves', async () => {
    const api = apiDoc()
    api.paths['//evil.example/steal'] = { get: { operationId: 'steal.get', summary: 'hostile', responses: { '200': { description: 'ok' } } } }
    const { r } = setup({ api })
    await login(r)
    const res = await r.run(['steal', 'get'])
    expect(res.code).toBe(2)
    expect(r.seen.filter((s) => s.url.includes('evil.example'))).toEqual([])
  })

  it('every request that carries Authorization goes to --server, and the credential is never sent to discovery', async () => {
    const { r } = setup()
    await login(r)
    await r.run(['me', 'get'])
    await r.run(['widgets', 'list'])
    const a = authed(r)
    expect(a.length).toBe(2)
    for (const s of a) expect(new URL(s.url).origin).toBe(SERVER)
    for (const s of r.seen.filter((x) => /well-known|openapi/.test(x.url))) expect(s.headers.authorization).toBeUndefined()
  })

  it('does not follow a redirect carrying the credential', async () => {
    const { r } = setup({ routes: () => new Response(null, { status: 302, headers: { location: `${EVIL}/x` } }) })
    await login(r)
    const res = await r.run(['me', 'get'])
    expect(res.code).toBe(1)
    expect(r.seen.filter((s) => s.url.startsWith(EVIL))).toEqual([])
    // every request the CLI makes refuses redirects
    expect(r.seen.length).toBeGreaterThan(0)
    for (const s of r.seen) expect(s.redirect).toBe('error')
  })

  it('http to a non-loopback host is refused, for --server and for login; https and loopback are accepted', async () => {
    const { r } = setup()
    const bad = await r.run(['login', '--api-key', '--server', 'http://vault.example.com'], { stdin: KEY })
    expect(bad.code).toBe(2)
    expect(existsSync(r.configFile)).toBe(false)
    await login(r)
    const flag = await r.run(['me', 'get', '--server', 'http://vault.example.com'])
    expect(flag.code).toBe(2)
    expect(r.seen.filter((s) => s.url.includes('vault.example.com'))).toEqual([])
    for (const ok of ['https://vault.example.com', 'http://localhost:8787', 'http://127.0.0.1:1']) {
      expect((await r.run(['login', '--api-key', '--server', ok, '--profile', 'p' + ok.length], { stdin: KEY })).code).toBe(0)
    }
  })

  it('--server is an origin: a path, query or userinfo is a usage error', async () => {
    const { r } = setup()
    for (const s of ['https://v.example.com/api', 'https://v.example.com/?x=1', 'https://u:p@v.example.com', 'ftp://v.example.com', 'not a url']) {
      expect((await r.run(['login', '--api-key', '--server', s], { stdin: KEY })).code).toBe(2)
    }
  })

  it('a stored credential is not sent to a different server given by --server', async () => {
    const { r } = setup()
    await login(r)
    const res = await r.run(['me', 'get', '--server', 'http://localhost:9999'])
    expect(res.code).toBe(2)
    expect(authed(r)).toEqual([])
    noKey(res)
  })
})

describe('the key never comes from argv (D10)', () => {
  it('login --api-key reads stdin, stores it, and prints no key', async () => {
    const { r } = setup()
    const res = await r.run(['login', '--api-key', '--server', SERVER], { stdin: `${KEY}\n` })
    expect(res.code).toBe(0)
    noKey(res)
    expect(JSON.parse(readFileSync(r.configFile, 'utf8')).profiles.default.api_key).toBe(KEY)
  })

  it('a key passed as an argument is refused, in every spelling, and is never echoed or stored', async () => {
    const { r } = setup()
    for (const argv of [['login', '--api-key', KEY, '--server', SERVER], ['login', `--api-key=${KEY}`, '--server', SERVER], ['login', '--server', SERVER, '--api-key', '--key', KEY], ['login', KEY, '--api-key', '--server', SERVER]]) {
      // stdin holds a usable key, so only the refusal of the argument can make this exit 2
      const res = await r.run(argv, { stdin: ['vk', 'stdin'.repeat(6)].join('_') })
      expect(res.code).toBe(2)
      noKey(res)
    }
    expect(existsSync(r.configFile)).toBe(false)
  })

  it('an empty stdin or a terminal stdin is a usage error', async () => {
    const { r } = setup()
    expect((await r.run(['login', '--api-key', '--server', SERVER], { stdin: ' \n' })).code).toBe(2)
    expect((await r.run(['login', '--api-key', '--server', SERVER], { stdin: KEY, stdinTTY: true })).code).toBe(2)
    expect(existsSync(r.configFile)).toBe(false)
  })

  it('device login against an instance that accepts API keys only is exit 2 and names --api-key', async () => {
    const { r } = setup()
    const res = await r.run(['login', '--server', SERVER])
    expect(res.code).toBe(2)
    expect(res.stderr).toMatch(/--api-key/)
  })

  it('config get never prints a credential and config set refuses one', async () => {
    const { r } = setup()
    await login(r)
    const get = await r.run(['config', 'get', 'profiles.default.api_key'])
    expect(get.code).toBe(2)
    noKey(get)
    const set = await r.run(['config', 'set', 'profiles.default.api_key', KEY])
    expect(set.code).toBe(2)
    noKey(set)
    const server = await r.run(['config', 'get', 'profiles.default.server'])
    expect(JSON.parse(server.stdout)).toBe(SERVER)
  })

  it('no test run leaks the key on stdout or stderr: a full session', async () => {
    const { r } = setup()
    await login(r)
    for (const argv of [['me', 'get'], ['widgets', 'list'], ['config', 'get', 'default_profile'], ['nope', 'x'], ['--help']]) noKey(await r.run(argv))
  })
})

describe('config file (D10)', () => {
  it('writes mode 0600 by temp file and rename (a new inode), leaving no temp file behind', async () => {
    const { r } = setup()
    await login(r)
    expect(statSync(r.configFile).mode & 0o777).toBe(0o600)
    const before = statSync(r.configFile).ino
    await login(r, SERVER, ['--profile', 'second'])
    expect(statSync(r.configFile).mode & 0o777).toBe(0o600)
    expect(statSync(r.configFile).ino).not.toBe(before)
    expect(readdirSync(join(r.dir, 'vibase')).filter((f) => f.startsWith('config.json'))).toEqual(['config.json'])
    const cfg = JSON.parse(readFileSync(r.configFile, 'utf8'))
    expect(Object.keys(cfg.profiles).sort()).toEqual(['default', 'second'])
    expect(cfg.default_profile).toBe('default')
  })

  it('a group- or world-readable config is exit 2 before any request, for commands and for login; restoring 0600 works', async () => {
    const { r } = setup()
    await login(r)
    for (const mode of [0o644, 0o640, 0o604]) {
      chmodSync(r.configFile, mode)
      r.seen.length = 0
      const res = await r.run(['me', 'get'])
      expect(res.code).toBe(2)
      expect(res.stderr).toMatch(/0600|permission/i)
      expect(r.seen).toEqual([])
      const again = await r.run(['login', '--api-key', '--server', SERVER], { stdin: KEY })
      expect(again.code).toBe(2)
      noKey(res, again)
    }
    chmodSync(r.configFile, 0o600)
    expect((await r.run(['me', 'get'])).code).toBe(0)
  })

  it('a config that is not valid JSON of the expected shape is exit 2', async () => {
    const { r } = setup()
    await login(r)
    writeFileSync(r.configFile, '{not json', { mode: 0o600 })
    expect((await r.run(['me', 'get'])).code).toBe(2)
  })

  describe('precedence: flags, then environment, then the profile', () => {
    const KEY2 = ['vk', 'env'.repeat(12)].join('_')
    it('server: --server over VIBASE_SERVER over the profile', async () => {
      const { r } = setup()
      await login(r, 'http://127.0.0.1:1111')
      const profile = await r.run(['me', 'get'])
      expect(profile.code).toBe(0)
      expect(new URL(authed(r).at(-1)!.url).origin).toBe('http://127.0.0.1:1111')
      // the stored key belongs to its own server: another server needs its own key
      expect((await r.run(['me', 'get'], { env: { VIBASE_SERVER: 'http://127.0.0.1:2222' } })).code).toBe(2)
      const env = await r.run(['me', 'get'], { env: { VIBASE_SERVER: 'http://127.0.0.1:2222', VIBASE_API_KEY: KEY2 } })
      expect(env.code).toBe(0)
      expect(new URL(authed(r).at(-1)!.url).origin).toBe('http://127.0.0.1:2222')
      const flag = await r.run(['me', 'get', '--server', 'http://127.0.0.1:3333'], { env: { VIBASE_SERVER: 'http://127.0.0.1:2222', VIBASE_API_KEY: KEY2 } })
      expect(flag.code).toBe(0)
      expect(new URL(authed(r).at(-1)!.url).origin).toBe('http://127.0.0.1:3333')
    })

    it('key: VIBASE_API_KEY over the profile', async () => {
      const { r } = setup()
      await login(r)
      await r.run(['me', 'get'])
      expect(authed(r).at(-1)!.headers.authorization).toBe(`Bearer ${KEY}`)
      await r.run(['me', 'get'], { env: { VIBASE_API_KEY: KEY2 } })
      expect(authed(r).at(-1)!.headers.authorization).toBe(`Bearer ${KEY2}`)
    })

    it('profile: --profile over VIBASE_PROFILE over default_profile', async () => {
      const { r } = setup()
      const K = (n: string) => ['vk', n.repeat(12)].join('_')
      await login(r, SERVER, ['--profile', 'a'], K('aa'))
      await login(r, SERVER, ['--profile', 'b'], K('bb'))
      await login(r, SERVER, ['--profile', 'c'], K('cc'))
      await r.run(['me', 'get'])
      expect(authed(r).at(-1)!.headers.authorization).toBe(`Bearer ${K('aa')}`)
      await r.run(['me', 'get'], { env: { VIBASE_PROFILE: 'b' } })
      expect(authed(r).at(-1)!.headers.authorization).toBe(`Bearer ${K('bb')}`)
      await r.run(['me', 'get', '--profile', 'c'], { env: { VIBASE_PROFILE: 'b' } })
      expect(authed(r).at(-1)!.headers.authorization).toBe(`Bearer ${K('cc')}`)
      expect((await r.run(['me', 'get', '--profile', 'missing'])).code).toBe(2)
    })

    it('environment only: no config file needed; neither server nor credential is exit 2 before any request', async () => {
      const { r } = setup()
      const ok = await r.run(['me', 'get'], { env: { VIBASE_SERVER: SERVER, VIBASE_API_KEY: KEY } })
      expect(ok.code).toBe(0)
      expect(existsSync(r.configFile)).toBe(false)
      r.seen.length = 0
      expect((await r.run(['me', 'get'])).code).toBe(2)
      expect((await r.run(['me', 'get'], { env: { VIBASE_SERVER: SERVER } })).code).toBe(2)
      expect(authed(r)).toEqual([])
    })
  })

  it('the request carries Authorization: Bearer and User-Agent vibase-cli/<version>', async () => {
    const { r } = setup()
    await login(r)
    await r.run(['me', 'get'])
    const last = authed(r).at(-1)!
    expect(last.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(last.headers['user-agent']).toBe('vibase-cli/0.0.0-test')
    expect(last.headers['x-organization-id']).toBeUndefined()
  })
})

describe('logout (D21, API-key profile)', () => {
  it('removes the profile and its credential, sends no request, and leaves other profiles', async () => {
    const { r } = setup()
    await login(r)
    await login(r, SERVER, ['--profile', 'other'])
    r.seen.length = 0
    const res = await r.run(['logout'])
    expect(res.code).toBe(0)
    expect(r.seen).toEqual([])
    const cfg = JSON.parse(readFileSync(r.configFile, 'utf8'))
    expect(Object.keys(cfg.profiles)).toEqual(['other'])
    expect(readFileSync(r.configFile, 'utf8')).not.toContain('"default":')
    expect(statSync(r.configFile).mode & 0o777).toBe(0o600)
    noKey(res)
  })

  it('afterwards a command has no credential: exit 2', async () => {
    const { r } = setup()
    await login(r)
    await r.run(['logout'])
    const res = await r.run(['me', 'get'])
    expect(res.code).toBe(2)
    expect(authed(r)).toEqual([])
  })

  it('--profile names the profile; an unknown profile is exit 2 and changes nothing', async () => {
    const { r } = setup()
    await login(r)
    await login(r, SERVER, ['--profile', 'other'])
    expect((await r.run(['logout', '--profile', 'nope'])).code).toBe(2)
    expect((await r.run(['logout', '--profile', 'other'])).code).toBe(0)
    expect(Object.keys(JSON.parse(readFileSync(r.configFile, 'utf8')).profiles)).toEqual(['default'])
  })
})

describe('binary operations (D14)', () => {
  const BYTES = new Uint8Array([0, 255, 1, 128, 10, 13, 0, 65])
  const content = (req: Request) =>
    new URL(req.url).pathname === '/api/v1/files/F1/content'
      ? new Response(BYTES, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="../../evil.txt"' } })
      : undefined
  const cmd = ['files', 'content', 'F1']

  it('streams the bytes unchanged to stdout when it is not a terminal', async () => {
    const { r } = setup({ routes: content })
    await login(r)
    const res = await r.run(cmd)
    expect(res.code).toBe(0)
    expect(Array.from(res.stdoutBytes)).toEqual(Array.from(BYTES))
    expect(res.stderr).toBe('')
  })

  it('refuses on a terminal without --output (exit 2, no request), and --output - forces stdout', async () => {
    const { r } = setup({ routes: content })
    await login(r)
    const res = await r.run(cmd, { tty: true })
    expect(res.code).toBe(2)
    expect(res.stdoutBytes.length).toBe(0)
    expect(r.seen.filter((s) => s.url.endsWith('/content'))).toEqual([])
    const forced = await r.run([...cmd, '--output', '-'], { tty: true })
    expect(forced.code).toBe(0)
    expect(Array.from(forced.stdoutBytes)).toEqual(Array.from(BYTES))
  })

  it('--output writes <path>.partial and renames; an existing file is overwritten; the name is never taken from Content-Disposition', async () => {
    const { r } = setup({ routes: content })
    await login(r)
    const out = join(r.dir, 'got.bin')
    writeFileSync(out, 'old')
    const res = await r.run([...cmd, '--output', out], { tty: true })
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('')
    expect(Array.from(readFileSync(out))).toEqual(Array.from(BYTES))
    expect(existsSync(out + '.partial')).toBe(false)
    expect(readdirSync(r.dir).filter((f) => /evil/.test(f))).toEqual([])
    expect(existsSync(join(r.dir, '..', 'evil.txt'))).toBe(false)
    expect(existsSync(join(r.dir, '..', '..', 'evil.txt'))).toBe(false)
  })

  it('an API error writes nothing (not even .partial), leaves an existing file, prints JSON on stderr and exits 1', async () => {
    const { r } = setup({ routes: () => json({ error: { code: 'not_found', message: 'file not found' } }, 404) })
    await login(r)
    const out = join(r.dir, 'keep.bin')
    writeFileSync(out, 'old')
    const res = await r.run([...cmd, '--output', out])
    expect(res.code).toBe(1)
    expect(errBody(res.stderr).code).toBe('not_found')
    expect(readFileSync(out, 'utf8')).toBe('old')
    expect(existsSync(out + '.partial')).toBe(false)
    const fresh = join(r.dir, 'new.bin')
    expect((await r.run([...cmd, '--output', fresh])).code).toBe(1)
    expect(existsSync(fresh)).toBe(false)
    expect(existsSync(fresh + '.partial')).toBe(false)
    const piped = await r.run(cmd)
    expect(piped.code).toBe(1)
    expect(piped.stdoutBytes.length).toBe(0)
  })

  it('a stream that fails midway leaves the destination as it was and removes the partial file', async () => {
    const broken = () => {
      let sent = false
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (!sent) {
            sent = true
            c.enqueue(BYTES)
          } else c.error(new Error('connection reset'))
        },
      })
      return new Response(body, { headers: { 'content-type': 'application/octet-stream' } })
    }
    const { r } = setup({ routes: broken })
    await login(r)
    const out = join(r.dir, 'half.bin')
    writeFileSync(out, 'old')
    const res = await r.run([...cmd, '--output', out])
    expect(res.code).toBe(1)
    expect(readFileSync(out, 'utf8')).toBe('old')
    expect(existsSync(out + '.partial')).toBe(false)
  })

  it('--output on a JSON operation is a usage error', async () => {
    const { r } = setup()
    await login(r)
    expect((await r.run(['me', 'get', '--output', join(r.dir, 'x')])).code).toBe(2)
  })
})

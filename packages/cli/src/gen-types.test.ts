import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { Module } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { topHelp } from './help.js'
import {
  type Docs,
  exists,
  instanceOf,
  projectWithMajor,
  projectWithStub,
  projectWithTool,
  projectWithToolOver,
  projectWithoutTool,
  workspaceDocuments,
} from './test/gen-rig.js'
import { KEY, rig, SERVER } from './test/harness.js'

// DX712: `vibase gen types` (DX694 D1 to D3, D5).
let docs: Docs
// pnpm puts its hoisted store on NODE_PATH, where Node's resolution finds openapi-typescript from anywhere; a developer's shell has no such path.
const nodePath = process.env.NODE_PATH
beforeAll(async () => {
  delete process.env.NODE_PATH
  ;(Module as unknown as { _initPaths(): void })._initPaths()
  docs = await workspaceDocuments()
}, 60_000)
afterAll(() => {
  if (nodePath !== undefined) process.env.NODE_PATH = nodePath
  ;(Module as unknown as { _initPaths(): void })._initPaths()
})

const err = (stderr: string) => JSON.parse(stderr).error as { code: string; message: string }
const setup = (over: Parameters<typeof instanceOf>[1] = {}, document?: Docs) => {
  const inst = instanceOf(document ?? docs, over)
  const r = rig({ fetch: inst.fetch })
  const project = projectWithStub(undefined)
  return { r, inst, project, out: join(project, 'src/vibase') }
}

describe('D1 the command surface', () => {
  it('is listed among the hand commands', () => {
    expect(topHelp(undefined)).toContain('vibase gen types --out <dir>')
  })

  it.each([
    ['no --out', ['gen', 'types', '--server', SERVER], /--out/],
    ['an unknown flag', ['gen', 'types', '--out', 'x', '--server', SERVER, '--bogus'], /--bogus|unknown/i],
    ['the global --refresh', ['gen', 'types', '--out', 'x', '--server', SERVER, '--refresh'], /--refresh|unknown/i],
    ['a positional', ['gen', 'types', 'extra', '--out', 'x', '--server', SERVER], /extra|positional|takes/i],
    ['gen alone', ['gen', '--server', SERVER], /gen types/],
    ['gen <other>', ['gen', 'foo', '--server', SERVER], /gen types/],
  ])('%s is a usage error (exit 2) before any request', async (_name, argv, message) => {
    const { r } = setup()
    const res = await r.run(argv)
    expect(res.code).toBe(2)
    expect(err(res.stderr).code).toBe('usage')
    expect(err(res.stderr).message).toMatch(message)
    expect(res.stdout).toBe('')
    expect(r.seen).toEqual([])
    r.dispose()
  })

  it('prints its usage for --help, with no request', async () => {
    const { r } = setup()
    const res = await r.run(['gen', 'types', '--help', '--server', SERVER])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('vibase gen types --out <dir>')
    expect(res.stdout).toMatch(/Exit 2:.*discovery.*exit 1:.*write/s)
    expect(r.seen).toEqual([])
    r.dispose()
  })

  it('is not shadowed by an instance that offers a gen resource', async () => {
    const shadow = structuredClone(docs.api)
    shadow.paths['/api/v1/gen/types'] = {
      get: { operationId: 'gen.types', responses: { 200: { description: 'ok' } } },
    }
    const { r } = setup({}, { api: shadow, meta: docs.meta })
    const res = await r.run(['gen', 'types', '--server', SERVER])
    expect(res.code).toBe(2)
    expect(err(res.stderr).message).toMatch(/--out/)
    expect(r.seen).toEqual([])
    r.dispose()
  })

  it('prints {server, version, files} on stdout and nothing on stderr', async () => {
    const { r, project, out } = setup()
    const res = await r.run(['gen', 'types', '--out', 'src/vibase', '--server', SERVER], { cwd: project })
    expect(res.stderr).toBe('')
    expect(res.code).toBe(0)
    const body = JSON.parse(res.stdout)
    expect(Object.keys(body)).toEqual(['server', 'version', 'files'])
    expect(body.server).toBe(SERVER)
    expect(body.version).toBe(docs.api.info.version)
    expect(body.files).toEqual([join(out, 'operations.ts'), join(out, 'types.ts')])
    expect(body.files.every(isAbsolute)).toBe(true)
    r.dispose()
  })
})

describe('D2 the documents', () => {
  it('works with --server alone: no profile, no key', async () => {
    const { r, project } = setup()
    const res = await r.run(['gen', 'types', '--out', 'o', '--server', SERVER], { cwd: project })
    expect(res.code).toBe(0)
    expect(r.seen.map((s) => new URL(s.url).pathname)).toEqual([
      '/.well-known/vibase',
      '/api/v1/openapi.json',
      '/meta/v1/openapi.json',
    ])
    r.dispose()
  })

  it('sends no credential on any of the three requests, with a logged-in profile', async () => {
    const { r, project } = setup()
    expect((await r.run(['login', '--api-key', '--server', SERVER, '--profile', 'work'], { stdin: KEY })).code).toBe(0)
    r.seen.length = 0
    const res = await r.run(['gen', 'types', '--out', 'o', '--profile', 'work'], { cwd: project })
    expect(res.code).toBe(0)
    expect(JSON.parse(res.stdout).server).toBe(SERVER)
    expect(r.seen).toHaveLength(3)
    for (const s of r.seen) {
      expect(Object.keys(s.headers).filter((h) => /authorization|cookie|api-key|x-vibase/i.test(h))).toEqual([])
      expect(s.redirect).toBe('error')
    }
    r.dispose()
  })

  it('refuses a document URL on another origin before fetching either document', async () => {
    const { r, project } = setup({
      wellKnown: (origin) => ({
        api: `${origin}/api/v1`,
        openapi: { api: `${origin}/api/v1/openapi.json`, meta: 'http://evil.example/meta/v1/openapi.json' },
      }),
    })
    const res = await r.run(['gen', 'types', '--out', 'o', '--server', SERVER], { cwd: project })
    expect(res.code).toBe(2)
    expect(err(res.stderr).code).toBe('origin_mismatch')
    expect(r.seen.map((s) => new URL(s.url).pathname)).toEqual(['/.well-known/vibase'])
    expect(exists(join(project, 'o'))).toBe(false)
    r.dispose()
  })

  it('refuses a redirect on a document', async () => {
    const { project } = setup()
    const inner = instanceOf(docs)
    const r = rig({
      fetch: async (req) =>
        new URL(req.url).pathname === '/meta/v1/openapi.json'
          ? new Response(null, { status: 302, headers: { location: 'http://evil.example/x' } })
          : inner.fetch(req),
    })
    const res = await r.run(['gen', 'types', '--out', 'o', '--server', SERVER], { cwd: project })
    expect(res.code).not.toBe(0)
    expect(err(res.stderr).code).toBe('network_error')
    expect(r.seen.every((s) => s.redirect === 'error')).toBe(true)
    expect(exists(join(project, 'o'))).toBe(false)
    r.dispose()
  })

  it.each([
    ['an array', []],
    ['a string', 'not a document'],
    ['an object without paths', { openapi: '3.1.0' }],
    ['paths that are not an object', { paths: 'x' }],
  ])('refuses a document that is %s as discovery_failed', async (_name, body) => {
    const { r, project } = setup({}, { api: body as never, meta: docs.meta })
    const res = await r.run(['gen', 'types', '--out', 'o', '--server', SERVER], { cwd: project })
    expect(res.code).toBe(2)
    expect(err(res.stderr).code).toBe('discovery_failed')
    expect(exists(join(project, 'o'))).toBe(false)
    r.dispose()
  })

  it('neither reads nor writes the command cache', async () => {
    const { r, project } = setup()
    mkdirSync(r.cacheDir, { recursive: true })
    const file = join(r.cacheDir, `discovery-${createHash('sha256').update(SERVER).digest('hex').slice(0, 16)}.json`)
    writeFileSync(file, JSON.stringify({ version: 1, server: SERVER, fetched_at: r.now(), ops: [] }))
    const old = new Date('2020-01-01T00:00:00Z')
    utimesSync(file, old, old)
    const before = { bytes: readFileSync(file), mtime: statSync(file).mtimeMs, names: readdirSync(r.cacheDir) }
    const res = await r.run(['gen', 'types', '--out', 'o', '--server', SERVER], { cwd: project })
    expect(res.code).toBe(0)
    expect(r.seen).toHaveLength(3) // a fresh cache would have answered a derived command with no request
    expect(readFileSync(file).equals(before.bytes)).toBe(true)
    expect(statSync(file).mtimeMs).toBe(before.mtime)
    expect(readdirSync(r.cacheDir)).toEqual(before.names)
    r.dispose()
  })
})

describe('D3 the translator is loaded from the working directory, before any request', () => {
  const refusal = async (project: string, over: { out?: string } = {}) => {
    const { r } = setup()
    const res = await r.run(['gen', 'types', '--out', over.out ?? 'o', '--server', SERVER], { cwd: project })
    const out = {
      code: res.code,
      error: res.stderr ? err(res.stderr) : undefined,
      seen: r.seen.length,
      stdout: res.stdout,
    }
    r.dispose()
    return out
  }
  const install = 'npm i -D openapi-typescript@7'

  it('not found: names the directory searched and the install line', async () => {
    const project = projectWithoutTool()
    const res = await refusal(project)
    expect(res).toMatchObject({ code: 2, seen: 0, stdout: '' })
    expect(res.error!.code).toBe('missing_dependency')
    expect(res.error!.message).toContain(project)
    expect(res.error!.message).toContain(install)
    expect(exists(join(project, 'o'))).toBe(false)
  })

  it.each(['6.7.5', '8.0.1'])('major %s found: names the version and the install line', async (version) => {
    const project = projectWithMajor(version)
    const res = await refusal(project)
    expect(res).toMatchObject({ code: 2, seen: 0 })
    expect(res.error!.code).toBe('missing_dependency')
    expect(res.error!.message).toContain(version)
    expect(res.error!.message).toContain(install)
    expect(exists(join(project, 'o'))).toBe(false)
  })

  it('typescript 7 (no compiler API): names the typescript found and says it needs typescript 5', async () => {
    const project = projectWithToolOver('7')
    const res = await refusal(project)
    expect(res).toMatchObject({ code: 2, seen: 0 })
    expect(res.error!.code).toBe('missing_dependency')
    expect(res.error!.message).toContain('typescript 7.0.2')
    expect(res.error!.message).toMatch(/needs typescript 5/)
    expect(exists(join(project, 'o'))).toBe(false)
  })

  it('no typescript at all: says so and that it needs typescript 5', async () => {
    const project = projectWithToolOver('none')
    const res = await refusal(project)
    expect(res).toMatchObject({ code: 2, seen: 0 })
    expect(res.error!.code).toBe('missing_dependency')
    expect(res.error!.message).toMatch(/no typescript/i)
    expect(res.error!.message).toMatch(/needs typescript 5/)
  })

  it('found and good: loads, requests and writes', async () => {
    const project = projectWithTool()
    const { r } = setup()
    const res = await r.run(['gen', 'types', '--out', 'o', '--server', SERVER], { cwd: project })
    expect(res.code).toBe(0)
    expect(r.seen).toHaveLength(3)
    expect(exists(join(project, 'o/operations.ts'))).toBe(true)
    r.dispose()
  }, 60_000)
})

describe('D5 write safety', () => {
  it('creates --out with its parents and leaves other files in it alone', async () => {
    const { r, project, out } = setup()
    expect((await r.run(['gen', 'types', '--out', 'a/b/c', '--server', SERVER], { cwd: project })).code).toBe(0)
    expect(readdirSync(join(project, 'a/b/c')).sort()).toEqual(['operations.ts', 'types.ts'])
    writeFileSync(join(out.replace('src/vibase', 'a/b/c'), 'mine.ts'), 'keep')
    expect((await r.run(['gen', 'types', '--out', 'a/b/c', '--server', SERVER], { cwd: project })).code).toBe(0)
    expect(readFileSync(join(project, 'a/b/c/mine.ts'), 'utf8')).toBe('keep')
    r.dispose()
  })

  it('refuses an --out that exists and is not a directory (exit 2), changing nothing', async () => {
    const { r, project } = setup()
    writeFileSync(join(project, 'out.txt'), 'file')
    const res = await r.run(['gen', 'types', '--out', 'out.txt', '--server', SERVER], { cwd: project })
    expect(res.code).toBe(2)
    expect(err(res.stderr).code).toBe('usage')
    expect(err(res.stderr).message).toContain('out.txt')
    expect(readFileSync(join(project, 'out.txt'), 'utf8')).toBe('file')
    expect(r.seen).toEqual([])
    r.dispose()
  })

  it('an --out that cannot be created (a parent is a file) is write_failed, exit 1, after the fetch', async () => {
    const { r, project } = setup()
    writeFileSync(join(project, 'blocker'), 'file')
    const res = await r.run(['gen', 'types', '--out', 'blocker/sub', '--server', SERVER], { cwd: project })
    expect(res.code).toBe(1)
    expect(err(res.stderr).code).toBe('write_failed')
    expect(err(res.stderr).message).toContain('blocker/sub')
    expect(r.seen).toHaveLength(3)
    expect(readFileSync(join(project, 'blocker'), 'utf8')).toBe('file')
    r.dispose()
  })

  const snapshot = (dir: string) =>
    Object.fromEntries(readdirSync(dir).map((n) => [n, readFileSync(join(dir, n), 'utf8')]))

  it('an analysis refusal is generation_failed (exit 1) and leaves the previous files and an unrelated file intact', async () => {
    const { r, project, out } = setup()
    expect((await r.run(['gen', 'types', '--out', 'src/vibase', '--server', SERVER], { cwd: project })).code).toBe(0)
    writeFileSync(join(out, 'unrelated.ts'), 'mine')
    const before = snapshot(out)
    const op = (id: string) => ({ get: { operationId: id, responses: { 200: { description: 'ok' } } } })
    const clash = {
      api: { openapi: '3.1.0', info: { title: 'a', version: '1' }, paths: { '/a': op('x.list') } },
      meta: { openapi: '3.1.0', info: { title: 'm', version: '1' }, paths: { '/b': op('x.list') } },
    }
    const bad = rig({ fetch: instanceOf(clash).fetch })
    const res = await bad.run(['gen', 'types', '--out', 'src/vibase', '--server', SERVER], { cwd: project })
    expect(res.code).toBe(1)
    expect(err(res.stderr).code).toBe('generation_failed')
    expect(err(res.stderr).message).toContain('x.list')
    expect(res.stdout).toBe('')
    expect(snapshot(out)).toEqual(before)
    r.dispose()
    bad.dispose()
  })

  it('writes nothing when the second document fails to translate: previous files intact, no temp sibling', async () => {
    // the previous files come from an older release, so a rewrite of either one would show
    const old = structuredClone(docs)
    old.api.info.version = '0.0.0-old'
    const { r, project, out } = setup({}, old)
    expect((await r.run(['gen', 'types', '--out', 'src/vibase', '--server', SERVER], { cwd: project })).code).toBe(0)
    expect(readFileSync(join(out, 'operations.ts'), 'utf8')).toContain('0.0.0-old')
    const before = snapshot(out)
    const failing = projectWithStub(2)
    mkdirSync(join(failing, 'src'), { recursive: true })
    // the same out directory, a project whose translator refuses the second document
    const now = rig({ fetch: instanceOf(docs).fetch })
    const res = await now.run(['gen', 'types', '--out', out, '--server', SERVER], { cwd: failing })
    expect(res.code).toBe(1)
    expect(err(res.stderr).code).toBe('generation_failed')
    expect(err(res.stderr).message).toContain('document 2 refused')
    expect(snapshot(out)).toEqual(before)
    expect(readdirSync(out).sort()).toEqual(['operations.ts', 'types.ts'])
    r.dispose()
    now.dispose()
  })
})

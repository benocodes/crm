// [[OPS494]] D1-D5, D7: `vibase-server init` writes a new instance's secrets file. Everything runs on the instance kit's fake world (a temp config home, no
// network, no wrangler): inputs by flag and by typed answer, the file's creation rules, its contents, and what is printed. The round trip through setup's own
// loaders and the Gmail switch (D6) are in `init-setup.test.ts`.
import * as fs from 'node:fs'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseEnv } from 'node:util'
import { isValidPushVar, parseGmailConfig } from '@vibase/api'
import { afterEach, describe, expect, it } from 'vitest'
import { loadBetterAuth } from '../setup/better-auth.js'
import { createSecretsFile, runInit } from './init.js'
import { ABORT_LINE } from './prompt.js'
import { runStatus } from './status.js'
import { runSetup } from './setup.js'
import { parseInstanceSetupArgs } from './setup-args.js'
import { cleanup, makeWorld, mkTmp, validSettings, type World, type WorldOptions } from './test-kit.js'

afterEach(() => cleanup())

const HOST = 'api.demo.invalid'
const OWNER = 'o@x.com'
const GOOD = {
  env: ['--env', 'demo'],
  host: ['--api-host', HOST],
  email: ['--owner-email', OWNER],
  auth: ['--auth', 'clerk'],
  mail: ['--email', 'gmail'],
}
const ALL = Object.values(GOOD).flat()
const without = (...keys: (keyof typeof GOOD)[]) =>
  Object.entries(GOOD)
    .filter(([k]) => !keys.includes(k as never))
    .flatMap(([, v]) => v)

const mk = (o: WorldOptions = {}) => makeWorld({ settings: null, secretsMode: null, ...o })
const run = async (w: World, argv: string[]) => runInit(argv, w.deps)
const text = (w: World) => readFileSync(w.secretsPath, 'utf8')
const GENERATED = ['AUTH_SECRET', 'CREDENTIALS_KEY', 'OAUTH_STATE_SECRET']
const mask = (t: string) => t.replace(new RegExp(`^(${GENERATED.join('|')})=.+$`, 'gm'), '$1=<generated>')
const valueOf = (t: string, name: string) => parseEnv(t)[name]
const baseline = async () => {
  const w = mk()
  expect(await run(w, [...ALL, '--yes']), w.all()).toBe(0)
  return mask(text(w))
}

describe('inputs (D1)', () => {
  it('each input, by flag and by typed answer, ends in the same file', async () => {
    const base = await baseline()
    const typed: Record<keyof typeof GOOD, string> = {
      env: 'demo',
      host: HOST,
      email: OWNER,
      auth: 'clerk',
      mail: 'gmail',
    }
    for (const key of Object.keys(GOOD) as (keyof typeof GOOD)[]) {
      const w = mk({ terminal: true, answers: [typed[key]] })
      expect(await run(w, [...without(key), '--yes']), `${key}: ${w.all()}`).toBe(0)
      expect(w.asked, key).toHaveLength(1)
      expect(mask(text(w)), key).toBe(base)
    }
    const all = mk({ terminal: true, answers: Object.values(typed) })
    expect(await run(all, ['--yes']), all.all()).toBe(0)
    expect(all.asked).toHaveLength(5)
    expect(mask(text(all))).toBe(base)
  })

  const BAD: [keyof typeof GOOD, string, string, RegExp][] = [
    ['env', '--env', 'Bad_Name', /lower-case/],
    ['env', '--env', 'a'.repeat(52), /63/],
    ['host', '--api-host', 'https://x.example', /bare host/],
    ['host', '--api-host', 'vb.sub.workers.dev', /workers\.dev/],
    ['email', '--owner-email', 'no-at', /email address/],
    ['auth', '--auth', 'okta', /better-auth/],
    ['mail', '--email', 'outlook', /gmail/],
  ]
  it.each(BAD)('a bad %s flag value (%s %s) exits 2 naming the flag and writes nothing', async (key, flag, value) => {
    const w = mk()
    const argv = [...without(key), flag, value, '--yes']
    expect(await run(w, argv)).toBe(2)
    expect(w.err.join('\n')).toContain(flag)
    expect(existsSync(w.secretsPath)).toBe(false)
  })
  it.each(BAD.filter(([, , v]) => v.length < 40))(
    'the same bad %s value typed (%s %s) prints the rule and asks again, then a good answer goes on',
    async (key, _flag, value, rule) => {
      const good = { env: 'demo', host: HOST, email: OWNER, auth: 'clerk', mail: 'gmail' }[key]
      const w = mk({ terminal: true, answers: [value, good] })
      expect(await run(w, [...without(key), '--yes']), w.all()).toBe(0)
      expect(w.asked).toHaveLength(2)
      expect(w.err.join('\n')).toMatch(rule)
      expect(mask(text(w))).toBe(await baseline())
    },
  )

  it('with no terminal each missing required flag exits 2 naming it; auth and email take their defaults', async () => {
    for (const [argv, flag] of [
      [[], '--env'],
      [GOOD.env, '--api-host'],
      [[...GOOD.env, ...GOOD.host], '--owner-email'],
    ] as const) {
      const w = mk()
      expect(await run(w, [...argv, '--yes'])).toBe(2)
      expect(w.err.join('\n')).toContain(flag)
      expect(w.asked).toEqual([])
      expect(existsSync(w.secretsPath)).toBe(false)
    }
    const w = mk()
    expect(await run(w, [...GOOD.env, ...GOOD.host, ...GOOD.email]), w.all()).toBe(0)
    const t = text(w)
    expect(valueOf(t, 'AUTH_SECRET')).toBeTruthy()
    expect(valueOf(t, 'CREDENTIALS_KEY')).toBeTruthy()
    expect(t).toContain('AUTH_GOOGLE_CLIENT_ID=')
  })
  it('the owner email may be omitted under --auth none', async () => {
    const w = mk()
    expect(await run(w, [...GOOD.env, ...GOOD.host, '--auth', 'none']), w.all()).toBe(0)
    expect(existsSync(w.secretsPath)).toBe(true)
  })
  it('end of input mid-prompts prints the abort line, exits 0 and writes nothing', async () => {
    for (const answers of [[], ['demo'], ['demo', HOST, OWNER]]) {
      const w = mk({ terminal: true, answers })
      expect(await run(w, []), w.all()).toBe(0)
      expect(w.out.join('\n')).toContain(ABORT_LINE)
      expect(existsSync(w.secretsPath)).toBe(false)
    }
  })
  it('--gcp-project without Gmail is refused naming the flag', async () => {
    const w = mk()
    expect(await run(w, [...ALL.filter((a) => a !== 'gmail'), 'none', '--gcp-project', 'p1', '--yes'])).toBe(2)
    expect(w.err.join('\n')).toContain('--gcp-project')
  })
  it('an unknown flag says Unknown option (the docs test probes it)', async () => {
    const w = mk()
    expect(await run(w, ['--nope'])).toBe(2)
    expect(w.err.join('\n')).toMatch(/Unknown option/)
  })
})

describe('the file (D3)', () => {
  it('is created at the default path with mode 600 even under a permissive umask, the parent made as needed', async () => {
    const cfg = join(mkTmp(), 'cfg')
    const w = mk({ processEnv: { XDG_CONFIG_HOME: cfg } })
    const old = process.umask(0)
    try {
      expect(await run(w, [...ALL, '--yes']), w.all()).toBe(0)
    } finally {
      process.umask(old)
    }
    const path = join(cfg, 'vibase', 'instances', 'demo.env')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
  })
  it('--secrets-file names the file, its parent made', async () => {
    const w = mk()
    const path = join(mkTmp(), 'a', 'b', 'x.env')
    const old = process.umask(0)
    try {
      expect(await run(w, [...ALL, '--secrets-file', path, '--yes']), w.all()).toBe(0)
    } finally {
      process.umask(old)
    }
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(existsSync(w.secretsPath)).toBe(false)
  })
  it('an existing file exits 2, named, its bytes unchanged', async () => {
    const w = mk({ secretsMode: 0o600, secretsText: 'KEEP=me\n' })
    expect(await run(w, [...ALL, '--yes'])).toBe(2)
    expect(w.err.join('\n')).toContain(w.secretsPath)
    expect(readFileSync(w.secretsPath, 'utf8')).toBe('KEEP=me\n')
  })
  it('an existing settings file exits 2 with no secrets file written', async () => {
    const w = mk({ settings: validSettings() })
    expect(await run(w, [...ALL, '--yes'])).toBe(2)
    expect(w.err.join('\n')).toContain(w.settingsPath)
    expect(existsSync(w.secretsPath)).toBe(false)
  })
  it('a file that appears while the question is open is never overwritten (the create is exclusive)', async () => {
    const w = mk()
    w.deps.question = {
      interactive: true,
      ask: async () => {
        writeFileSync(w.secretsPath, 'KEEP=me\n', { mode: 0o600 })
        return 'y'
      },
    }
    expect(await run(w, ALL)).toBe(2)
    expect(readFileSync(w.secretsPath, 'utf8')).toBe('KEEP=me\n')
  })
  it('a write that fails part-way leaves no file behind', () => {
    const path = join(mkTmp(), 'x.env')
    const ops = {
      ...fs,
      writeSync: () => {
        throw new Error('disk full')
      },
    }
    expect(() => createSecretsFile(path, 'A=1\n', ops as never)).toThrow(/disk full/)
    expect(existsSync(path)).toBe(false)
  })
})

describe('the contents (D4)', () => {
  const COMBOS: [string, string[]][] = [
    ['better-auth + gmail', [...GOOD.env, ...GOOD.host, ...GOOD.email, '--auth', 'better-auth']],
    ['clerk + gmail', ALL],
    ['none + none', [...GOOD.env, ...GOOD.host, '--auth', 'none', '--email', 'none']],
  ]
  const make = async (argv: string[]) => {
    const w = mk()
    expect(await run(w, [...argv, '--yes']), w.all()).toBe(0)
    return { w, t: text(w) }
  }
  it('names exactly the groups of the choice, with the person-supplied values empty', async () => {
    const names = async (argv: string[]) => Object.keys(parseEnv((await make(argv)).t)).sort()
    expect(await names(COMBOS[0]![1])).toEqual(
      [
        'CLOUDFLARE_ACCOUNT_ID',
        'CLOUDFLARE_API_TOKEN',
        'AUTH_SECRET',
        'AUTH_GOOGLE_CLIENT_ID',
        'AUTH_GOOGLE_CLIENT_SECRET',
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
        'CREDENTIALS_KEY',
        'OAUTH_STATE_SECRET',
      ].sort(),
    )
    expect(await names(COMBOS[1]![1])).toEqual(
      [
        'CLOUDFLARE_ACCOUNT_ID',
        'CLOUDFLARE_API_TOKEN',
        'CLERK_SECRET_KEY',
        'CLERK_PUBLISHABLE_KEY',
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
        'CREDENTIALS_KEY',
        'OAUTH_STATE_SECRET',
      ].sort(),
    )
    expect(await names(COMBOS[2]![1])).toEqual(['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'])
    const t = (await make(COMBOS[0]![1])).t
    for (const n of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'GOOGLE_CLIENT_ID', 'AUTH_GOOGLE_CLIENT_SECRET'])
      expect(valueOf(t, n), n).toBe('')
    expect(t).not.toContain(OWNER)
  })
  it('the generated values pass setup and the Worker, and differ between runs', async () => {
    const [a, b] = [await make(COMBOS[0]![1]), await make(COMBOS[0]![1])]
    for (const n of GENERATED) {
      expect(valueOf(a.t, n)).toBeTruthy()
      expect(valueOf(a.t, n), n).not.toBe(valueOf(b.t, n))
    }
    const key = valueOf(a.t, 'CREDENTIALS_KEY')!
    expect(parseGmailConfig({ CREDENTIALS_KEY: key }).problems).not.toContain('CREDENTIALS_KEY')
    expect(() =>
      loadBetterAuth(
        parseInstanceSetupArgs(['--env', 'demo', '--api-host', HOST, '--owner-email', OWNER]).opts,
        a.t,
        'f',
      ),
    ).not.toThrow()
    expect(loadBetterAuth({ auth: 'better-auth' }, a.t, 'f')?.authSecret).toBe(valueOf(a.t, 'AUTH_SECRET'))
  })
  it('the push values are commented with <project-id> unless --gcp-project, then live and valid', async () => {
    const off = (await make(COMBOS[0]![1])).t
    expect(parseEnv(off).GMAIL_TOPIC_NAME).toBeUndefined()
    expect(off).toContain('# GMAIL_TOPIC_NAME=projects/<project-id>/topics/gmail.watch.demo')
    expect(off).toContain('# GMAIL_PUSH_SUBSCRIPTION=projects/<project-id>/subscriptions/gmail.push.demo')
    expect(off).toContain('# GMAIL_PUSH_SERVICE_ACCOUNT=gmail-push@<project-id>.iam.gserviceaccount.com')
    const on = (await make([...COMBOS[0]![1], '--gcp-project', 'p1'])).t
    const env = parseEnv(on)
    expect(env.GMAIL_TOPIC_NAME).toBe('projects/p1/topics/gmail.watch.demo')
    expect(env.GMAIL_PUSH_SUBSCRIPTION).toBe('projects/p1/subscriptions/gmail.push.demo')
    expect(env.GMAIL_PUSH_SERVICE_ACCOUNT).toBe('gmail-push@p1.iam.gserviceaccount.com')
    for (const n of ['GMAIL_TOPIC_NAME', 'GMAIL_PUSH_SUBSCRIPTION', 'GMAIL_PUSH_SERVICE_ACCOUNT'] as const)
      expect(isValidPushVar(n, env[n]!), n).toBe(true)
  })
  it('each Google redirect URI is named, with the host filled in', async () => {
    const t = (await make(COMBOS[0]![1])).t
    expect(t).toContain(`https://${HOST}/auth/callback/google`)
    expect(t).toContain(`https://${HOST}/oauth/callback/google`)
    const clerk = (await make(COMBOS[1]![1])).t
    expect(clerk).not.toContain('/auth/callback/google')
    expect(clerk).toContain(`https://${HOST}/oauth/callback/google`)
  })
})

describe('output and the question (D2, D5)', () => {
  it.each([
    ['better-auth + gmail', ALL.map((a) => (a === 'clerk' ? 'better-auth' : a))],
    ['none + none', [...GOOD.env, ...GOOD.host, '--auth', 'none', '--email', 'none']],
  ])('%s: no generated value reaches stdout or stderr', async (_n, argv) => {
    const w = mk()
    expect(await run(w, [...argv, '--yes']), w.all()).toBe(0)
    const t = text(w)
    for (const n of GENERATED) {
      const v = valueOf(t, n)
      if (v) expect(w.all(), n).not.toContain(v)
    }
    expect(w.out.join('\n')).toContain(`wrote ${w.secretsPath} (mode 600)`)
  })
  it('the summary precedes proceed? and n writes nothing and exits 0; y writes', async () => {
    const n = mk({ terminal: true, answers: ['n'] })
    expect(await run(n, ALL)).toBe(0)
    expect(n.asked).toHaveLength(1)
    expect(n.asked[0]!.prompt).toBe('proceed? [Y/n] ')
    expect(n.asked[0]!.out).toBeGreaterThan(0)
    const summary = n.out.slice(0, n.asked[0]!.out).join('\n')
    for (const part of [n.secretsPath, 'demo', HOST, OWNER, 'clerk', 'gmail']) expect(summary).toContain(part)
    expect(n.out.join('\n')).toContain(ABORT_LINE)
    expect(existsSync(n.secretsPath)).toBe(false)
    const y = mk({ terminal: true, answers: [''] })
    expect(await run(y, ALL)).toBe(0)
    expect(existsSync(y.secretsPath)).toBe(true)
  })
  it('--yes on a terminal, and no terminal, never ask', async () => {
    const a = mk({ terminal: true })
    expect(await run(a, [...ALL, '--yes'])).toBe(0)
    expect(a.asked).toEqual([])
    const b = mk()
    expect(await run(b, ALL)).toBe(0)
    expect(b.asked).toEqual([])
  })
  const nextLine = (w: World) => w.out.find((l) => l.trim().startsWith('vibase-server setup'))?.trim()
  it('prints the short setup command; --secrets-file only when given; never --auth, --api-host, --owner-email or --dry-run (OPS501 D7)', async () => {
    const a = mk()
    expect(await run(a, ALL)).toBe(0)
    expect(a.out).toContain('next:')
    expect(nextLine(a)).toBe('vibase-server setup --env demo')
    const path = join(mkTmp(), 'x.env')
    const b = mk()
    expect(await run(b, [...GOOD.env, ...GOOD.host, '--auth', 'none', '--secrets-file', path])).toBe(0)
    expect(nextLine(b)).toBe(`vibase-server setup --env demo --secrets-file ${path}`)
  })
  it('a --secrets-file path that needs quoting is shell-quoted in the printed command', async () => {
    const path = join(mkTmp(), "it's here.env")
    const w = mk()
    expect(await run(w, [...GOOD.env, ...GOOD.host, '--auth', 'none', '--secrets-file', path])).toBe(0)
    expect(nextLine(w)).toBe(`vibase-server setup --env demo --secrets-file '${path.replaceAll("'", `'\\''`)}'`)
  })
  it('prints wrote <settings path> after the secrets line', async () => {
    const w = mk()
    expect(await run(w, ALL)).toBe(0)
    const i = w.out.indexOf(`wrote ${w.secretsPath} (mode 600)`)
    expect(i).toBeGreaterThanOrEqual(0)
    expect(w.out).toContain(`wrote ${w.settingsPath}`)
  })
  it('the CREDENTIALS_KEY backup reminder appears only when it was generated', async () => {
    const a = mk()
    await run(a, ALL)
    expect(a.out.join('\n')).toMatch(/CREDENTIALS_KEY.*back it up/i)
    const b = mk()
    await run(b, [...without('mail'), '--email', 'none'])
    expect(b.out.join('\n')).not.toMatch(/CREDENTIALS_KEY|back it up/i)
  })
  it('names the values to fill in', async () => {
    const w = mk()
    await run(w, ALL)
    const line = w.out.find((l) => l.startsWith('fill in'))!
    for (const n of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY'])
      expect(line).toContain(n)
  })
})

describe('a missing secrets file points at init (D7)', () => {
  it('setup and status name `vibase-server init --env <env>`', async () => {
    const w = mk({ settings: validSettings() })
    expect(await runSetup(['--env', 'demo', '--api-host', HOST, '--owner-email', OWNER, '--dry-run'], w.deps)).toBe(2)
    expect(w.err.join('\n')).toContain('vibase-server init --env demo')
    const s = mk({ settings: validSettings() })
    expect(await runStatus(['--env', 'demo'], s.deps)).toBe(2)
    expect(s.err.join('\n')).toContain('vibase-server init --env demo')
  })
})

// [[OPS501]] D1, D2: init also writes the settings file.
describe('init writes the settings file (OPS501 D1, D2)', () => {
  const settingsOf = (w: World) => JSON.parse(readFileSync(w.settingsPath, 'utf8')) as Record<string, unknown>
  it.each([
    [
      'better-auth with an email',
      ['--auth', 'better-auth', ...GOOD.email],
      { auth: 'better-auth', owner_email: OWNER },
    ],
    ['clerk', ['--auth', 'clerk', ...GOOD.email], { auth: 'clerk', owner_email: OWNER }],
    ['none without an email', ['--auth', 'none'], { auth: 'none' }],
  ])('%s: exactly the D1 keys, pretty JSON', async (_n, flags, extra) => {
    const w = mk()
    expect(await run(w, [...GOOD.env, ...GOOD.host, ...flags, '--yes']), w.all()).toBe(0)
    expect(settingsOf(w)).toEqual({ version: 1, env: 'demo', stage: 'init', api_host: HOST, ...extra })
    expect(readFileSync(w.settingsPath, 'utf8')).toBe(`${JSON.stringify(settingsOf(w), null, 2)}\n`)
  })
  it('nothing is written when proceed? is declined', async () => {
    const w = mk({ terminal: true, answers: ['n'] })
    expect(await run(w, ALL)).toBe(0)
    expect(existsSync(w.settingsPath)).toBe(false)
    expect(existsSync(w.secretsPath)).toBe(false)
  })
  it('a secrets file present refuses (exit 2), leaving both paths as they were', async () => {
    const w = mk({ secretsMode: 0o600, secretsText: 'KEEP=me\n' })
    expect(await run(w, [...ALL, '--yes'])).toBe(2)
    expect(existsSync(w.settingsPath)).toBe(false)
    expect(readFileSync(w.secretsPath, 'utf8')).toBe('KEEP=me\n')
  })
  it('a full record present refuses (exit 2), both paths unchanged', async () => {
    const w = mk({ settings: validSettings() })
    const before = readFileSync(w.settingsPath, 'utf8')
    expect(await run(w, [...ALL, '--yes'])).toBe(2)
    expect(w.err.join('\n')).toMatch(/already set up/)
    expect(readFileSync(w.settingsPath, 'utf8')).toBe(before)
    expect(existsSync(w.secretsPath)).toBe(false)
  })
  it('an unparseable settings file refuses (exit 2), named, both paths unchanged', async () => {
    const w = mk({ settings: null })
    writeFileSync(w.settingsPath, '{nope')
    expect(await run(w, [...ALL, '--yes'])).toBe(2)
    expect(w.err.join('\n')).toContain(w.settingsPath)
    expect(readFileSync(w.settingsPath, 'utf8')).toBe('{nope')
    expect(existsSync(w.secretsPath)).toBe(false)
  })
  it('an init-written settings file is replaced, whatever its content, and the summary says so', async () => {
    const w = mk({ settings: { version: 1, env: 'demo', stage: 'init', api_host: 'old.demo.invalid', auth: 'none' } })
    expect(await run(w, [...ALL, '--yes']), w.all()).toBe(0)
    expect(w.out.join('\n')).toContain(`will replace ${w.settingsPath} (written by init)`)
    expect(settingsOf(w)).toMatchObject({ stage: 'init', api_host: HOST, auth: 'clerk', owner_email: OWNER })
    expect(existsSync(w.secretsPath)).toBe(true)
  })
  it('a secrets-file write that fails leaves the settings file init-written, so a rerun succeeds', async () => {
    const w = mk()
    const blocker = join(mkTmp(), 'a-file')
    writeFileSync(blocker, 'x')
    await expect(run(w, [...ALL, '--secrets-file', join(blocker, 'x.env'), '--yes'])).rejects.toThrow()
    expect(settingsOf(w)).toMatchObject({ stage: 'init' })
    expect(await run(w, [...ALL, '--yes']), w.all()).toBe(0)
    expect(existsSync(w.secretsPath)).toBe(true)
  })
})

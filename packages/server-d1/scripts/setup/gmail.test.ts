// The Gmail group of `setup:remote` ([[OPS150]], [[OPS65]] D41), against fakes only: cycle 1's fake world, the fake Clerk, recorded wrangler argv.
// Every value below is an obviously fake sentinel standing for the contents of `.env.<env>`; none may reach argv (secrets travel on stdin),
// a log line, a result, a diff or a message. No network, no remote call.
import { readFileSync } from 'node:fs'
import { parse } from 'jsonc-parser'
import { parsePushConfig } from '@vibase/api'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openWorkerD1, type WorkerD1 } from '../../src/test/kit.js'
import { reconcileEnvBlock } from './config-editor.js'
import { runSetup, type SetupOutcome } from './run.js'
import { ISSUER, OWNER_EMAIL, PK_TEST, SK_TEST, makeClerk, type FakeClerk } from './test/clerk-world.js'
import { FIXTURE_CONFIG_PATH, makeWorld, type World, type WorldOptions } from './test/world.js'

const CONFIRM = { CONFIRM_REMOTE: '1' }
const NONE = ['--env', 'acme', '--auth', 'none', '--api-host', 'api.acme.vibase.ai']
const CLERK = ['--env', 'acme', '--api-host', 'api.acme.vibase.ai', '--owner-email', OWNER_EMAIL]
const realConfig = readFileSync(FIXTURE_CONFIG_PATH, 'utf8')
const states = (o: SetupOutcome) => o.results.map((r) => `${r.step}:${r.status}`)
const KEY32 = Buffer.alloc(32, 7).toString('base64')

const SECRETS = ['GOOGLE_CLIENT_SECRET', 'OAUTH_STATE_SECRET', 'CREDENTIALS_KEY'] as const
const VARS = ['GOOGLE_CLIENT_ID', 'GMAIL_TOPIC_NAME', 'GMAIL_PUSH_SUBSCRIPTION', 'GMAIL_PUSH_SERVICE_ACCOUNT', 'PUBLIC_BASE_URL', 'CONNECT_RETURN_URL', 'CREDENTIALS_KEY_VERSION', 'GMAIL_BACKFILL_DAYS', 'ATTACHMENT_MAX_BYTES'] as const
const CORE = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OAUTH_STATE_SECRET', 'CREDENTIALS_KEY']

/** Twelve fake values, each unmistakable in any output. */
const FULL: Record<string, string> = {
  GOOGLE_CLIENT_ID: 'sentinel-client-id.apps.example.test',
  GOOGLE_CLIENT_SECRET: 'SENTINEL_CLIENT_SECRET_VALUE',
  OAUTH_STATE_SECRET: 'SENTINEL_STATE_SECRET_VALUE',
  CREDENTIALS_KEY: KEY32,
  GMAIL_TOPIC_NAME: 'projects/sentinel-proj/topics/sentinel-topic',
  GMAIL_PUSH_SUBSCRIPTION: 'projects/sentinel-proj/subscriptions/sentinel-sub',
  GMAIL_PUSH_SERVICE_ACCOUNT: 'sentinel-push@sentinel-proj.iam.example.test',
  PUBLIC_BASE_URL: 'https://sentinel-public.example.test',
  CONNECT_RETURN_URL: 'https://sentinel-return.example.test/done',
  CREDENTIALS_KEY_VERSION: '7771',
  GMAIL_BACKFILL_DAYS: '4545',
  ATTACHMENT_MAX_BYTES: '1234567',
}
const file = (v: Record<string, string | undefined>, extra = '') =>
  Object.entries(v)
    .filter(([, x]) => x !== undefined)
    .map(([k, x]) => `${k}=${x}`)
    .join('\n') + `\n${extra}`
const without = (...names: string[]) => Object.fromEntries(Object.entries(FULL).filter(([k]) => !names.includes(k)))
const clerkPair = `CLERK_SECRET_KEY=${SK_TEST}\nVITE_CLERK_PUBLISHABLE_KEY=${PK_TEST}\n`

let db: WorkerD1
beforeAll(async () => {
  db = await openWorkerD1()
})
afterAll(async () => {
  await db.dispose()
})
beforeEach(async () => {
  await db.reset()
})

const D1S = [{ uuid: '0f5a1c2e-3b4d-4e6f-8a9b-1c2d3e4f5a6b', name: 'vb-crm-acme' }, { uuid: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', name: 'vb-control-acme' }]
const R2S = ['vb-bodies-acme']
function setup(gmail: Record<string, string | undefined> | null, o: Partial<WorldOptions> = {}, clerk = false): { w: World; clerk: FakeClerk } {
  const fake = makeClerk()
  const text = gmail === null ? (clerk ? clerkPair : null) : `${clerk ? clerkPair : ''}${file(gmail)}`
  return { clerk: fake, w: makeWorld({ d1: db.d1, d1s: D1S, r2s: R2S, clerk: fake, clerkEnvText: text, ...o }) }
}
/** `env.acme` as a clerk first run writes it (so `config:write` has the CLI client id without the clerk step). */
const clerkConfig = () =>
  reconcileEnvBlock(realConfig, {
    env: 'acme', workerName: 'vb-acme', d1Name: 'vb-crm-acme', d1Id: D1S[0]!.uuid, controlD1Name: 'vb-control-acme', controlD1Id: D1S[1]!.uuid, r2Name: 'vb-bodies-acme', apiHost: 'api.acme.vibase.ai', corsOrigins: '',
    authVars: { AUTH_PROVIDER: 'clerk', CLERK_ISSUER: ISSUER, CLERK_PUBLISHABLE_KEY: PK_TEST, CLERK_AUTHORIZED_PARTIES: 'https://api.acme.vibase.ai', AUTH_CLI_CLIENT_ID: 'client_1' },
  }).text
const ARGS = { none: NONE, clerk: CLERK } as const
const STEPS_ONLY = ['--only', 'config:write,secrets']
const configVars = (w: World) => (parse(w.state.configText) as { env: { acme: { vars: Record<string, string> } } }).env.acme.vars
const bulkPayloads = (w: World) => w.secretInputs.map((s) => JSON.parse(s) as Record<string, string>)
/** A real run, then its re-run after the config write stopped the first ([[OPS65]] D10). */
async function twice(w: World, args: string[]): Promise<SetupOutcome> {
  await runSetup([...args, '--only', 'config:write'], CONFIRM, w.deps)
  return runSetup([...args, '--only', 'secrets'], CONFIRM, w.deps)
}
const SENTINELS = Object.values(FULL)

describe('group absent: skipped', () => {
  it('--auth none with no env file: the report says skipped, no Gmail var is written, no secret bulk is issued', async () => {
    const { w } = setup(null)
    const first = await runSetup([...NONE, '--only', 'config:write'], CONFIRM, w.deps)
    expect(first.exitCode).toBe(0)
    expect(w.logs.join('\n')).toMatch(/gmail.*skipped/i)
    expect(Object.keys(configVars(w)).filter((k) => [...VARS, ...SECRETS].includes(k as never))).toEqual([])
    await runSetup([...NONE, '--only', 'secrets'], CONFIRM, w.deps)
    expect(w.secretInputs).toEqual([])
  })

  it('a file without the names (clerk keys only): skipped, and the clerk secrets are the only ones in the bulk', async () => {
    const { w } = setup(null, { configText: clerkConfig() }, true)
    const o = await runSetup([...CLERK, ...STEPS_ONLY], CONFIRM, w.deps)
    expect(o.exitCode).toBe(0)
    expect(w.logs.join('\n')).toMatch(/gmail.*skipped/i)
    expect(bulkPayloads(w).map((p) => Object.keys(p).sort())).toEqual([['CLERK_JWT_KEY', 'CLERK_SECRET_KEY']])
    expect(Object.keys(configVars(w))).not.toContain('PUBLIC_BASE_URL')
  })

  it('a none file with unrelated names only is skipped too, and its unknown names pass nowhere', async () => {
    const { w } = setup({ SOME_OTHER_SETTING: 'sentinel-unknown-value', AWS_SECRET: 'sentinel-aws' })
    await runSetup([...NONE, '--only', 'config:write'], CONFIRM, w.deps)
    expect(w.logs.join('\n')).toMatch(/gmail.*skipped/i)
    expect(w.state.configText).not.toContain('sentinel-unknown')
  })
})

describe('partial core set: refused before any command', () => {
  const partials: [string, Record<string, string>, string[]][] = [
    ['only the client id', { GOOGLE_CLIENT_ID: FULL.GOOGLE_CLIENT_ID! }, ['GOOGLE_CLIENT_SECRET', 'OAUTH_STATE_SECRET', 'CREDENTIALS_KEY']],
    ['everything but the key', without('CREDENTIALS_KEY'), ['CREDENTIALS_KEY']],
    ['optional vars but no core name but one', { GOOGLE_CLIENT_SECRET: FULL.GOOGLE_CLIENT_SECRET!, GMAIL_BACKFILL_DAYS: '30' }, ['GOOGLE_CLIENT_ID', 'OAUTH_STATE_SECRET', 'CREDENTIALS_KEY']],
  ]
  for (const mode of ['none', 'clerk'] as const)
    for (const dry of [false, true])
      it.each(partials)(`${mode}${dry ? ' dry run' : ''}: %s`, async (_n, vars, missing) => {
        const { w, clerk } = setup(vars, {}, mode === 'clerk')
        const o = await runSetup([...ARGS[mode], ...(dry ? ['--dry-run'] : [])], CONFIRM, w.deps)
        expect(o.exitCode).toBe(1)
        expect(w.argv).toEqual([])
        expect(w.fetched).toEqual([])
        expect(clerk.requests).toEqual([])
        const line = w.logs.find((l) => /missing/i.test(l))!
        expect(line).toBeDefined()
        const named = CORE.filter((n) => line.includes(n))
        expect(named.sort()).toEqual([...missing].sort())
        for (const s of Object.values(vars)) expect(w.logs.join('\n')).not.toContain(s)
      })
})

describe('validation: each rule refuses its bad case, by variable name, before any command', () => {
  const bad: [string, Record<string, string>][] = [
    ['CREDENTIALS_KEY of 31 bytes', { CREDENTIALS_KEY: Buffer.alloc(31, 7).toString('base64') }],
    ['CREDENTIALS_KEY of 33 bytes', { CREDENTIALS_KEY: Buffer.alloc(33, 7).toString('base64') }],
    ['CREDENTIALS_KEY unpadded (43 characters)', { CREDENTIALS_KEY: KEY32.replace(/=+$/, '') }],
    ['CREDENTIALS_KEY in the URL-safe alphabet', { CREDENTIALS_KEY: Buffer.alloc(32, 0xfb).toString('base64').replace(/\+/g, '-').replace(/\//g, '_') }],
    ['CREDENTIALS_KEY_VERSION of 10 digits', { CREDENTIALS_KEY_VERSION: '1234567890' }],
    ['CREDENTIALS_KEY that is not base64', { CREDENTIALS_KEY: 'not base64 at all !!!' }],
    ['CREDENTIALS_KEY_VERSION zero', { CREDENTIALS_KEY_VERSION: '0' }],
    ['CREDENTIALS_KEY_VERSION not an integer', { CREDENTIALS_KEY_VERSION: '1.5' }],
    ['GMAIL_BACKFILL_DAYS negative', { GMAIL_BACKFILL_DAYS: '-3' }],
    ['GMAIL_BACKFILL_DAYS words', { GMAIL_BACKFILL_DAYS: 'thirty' }],
    ['ATTACHMENT_MAX_BYTES zero', { ATTACHMENT_MAX_BYTES: '0' }],
    // [[CHN149]] D71: only the Worker's own parser refuses a ten-digit value (setup's former rule allowed sixteen digits).
    ['GMAIL_BACKFILL_DAYS of 10 digits', { GMAIL_BACKFILL_DAYS: '1234567890' }],
    ['ATTACHMENT_MAX_BYTES of 10 digits', { ATTACHMENT_MAX_BYTES: '1234567890' }],
    ['PUBLIC_BASE_URL over http', { PUBLIC_BASE_URL: 'http://sentinel-public.example.test' }],
    ['PUBLIC_BASE_URL relative', { PUBLIC_BASE_URL: '/sentinel/path' }],
    ['CONNECT_RETURN_URL over http', { CONNECT_RETURN_URL: 'http://sentinel-return.example.test' }],
    ['CONNECT_RETURN_URL not a URL', { CONNECT_RETURN_URL: 'sentinel return' }],
    ['GMAIL_TOPIC_NAME without the topics path', { GMAIL_TOPIC_NAME: 'sentinel-proj/sentinel-topic' }],
    ['GMAIL_TOPIC_NAME that is a subscription path', { GMAIL_TOPIC_NAME: 'projects/sentinel-proj/subscriptions/sentinel-sub' }],
    ['GMAIL_PUSH_SUBSCRIPTION that is a topic path', { GMAIL_PUSH_SUBSCRIPTION: 'projects/sentinel-proj/topics/sentinel-topic' }],
    ['GMAIL_PUSH_SERVICE_ACCOUNT not an email', { GMAIL_PUSH_SERVICE_ACCOUNT: 'sentinel-not-an-email' }],
  ]
  for (const mode of ['none', 'clerk'] as const)
    it.each(bad)(`${mode}: %s`, async (name, override) => {
      const { w, clerk } = setup({ ...FULL, ...override }, {}, mode === 'clerk')
      const o = await runSetup(ARGS[mode], CONFIRM, w.deps)
      expect(o.exitCode).toBe(1)
      expect(w.argv).toEqual([])
      expect(w.fetched).toEqual([])
      expect(clerk.requests).toEqual([])
      const varName = name.split(' ')[0]!
      expect(w.logs.join('\n')).toContain(varName)
      for (const s of [...Object.values(override), ...SENTINELS]) expect(w.logs.join('\n')).not.toContain(s)
    })

  it('a 32-byte key is accepted (and the neighbours 31 and 33 above are not)', async () => {
    const { w } = setup(FULL)
    const o = await runSetup([...NONE, ...STEPS_ONLY, '--dry-run'], {}, w.deps)
    expect(o.exitCode).toBe(0)
  })

  it('an unset optional var is not an error', async () => {
    const { w } = setup(without('GMAIL_TOPIC_NAME', 'GMAIL_PUSH_SUBSCRIPTION', 'CONNECT_RETURN_URL', 'GMAIL_BACKFILL_DAYS'))
    expect((await runSetup([...NONE, '--only', 'config:write', '--dry-run'], {}, w.deps)).exitCode).toBe(0)
  })
})

// [[CHN155]] / [[CHN5]] D87, D71's rule: the four push values are judged by the Worker's own parser, so setup can never accept what the Worker rejects.
// (Setup is stricter in one place the Worker is not: a remote PUBLIC_BASE_URL is https, never http://localhost.)
describe('push values: setup and the Worker see the same verdict (one parser)', () => {
  const GOOD = { GMAIL_TOPIC_NAME: FULL.GMAIL_TOPIC_NAME!, GMAIL_PUSH_SUBSCRIPTION: FULL.GMAIL_PUSH_SUBSCRIPTION!, GMAIL_PUSH_SERVICE_ACCOUNT: FULL.GMAIL_PUSH_SERVICE_ACCOUNT!, PUBLIC_BASE_URL: FULL.PUBLIC_BASE_URL! }
  const pairs: Array<[keyof typeof GOOD, string]> = [
    ['GMAIL_TOPIC_NAME', 'projects/p/topics/t'],
    ['GMAIL_TOPIC_NAME', 'projects/p/topics/gmail.watch'],
    ['GMAIL_TOPIC_NAME', 'projects/p/topics/t/extra'],
    ['GMAIL_TOPIC_NAME', 'topics/t'],
    ['GMAIL_TOPIC_NAME', 'projects/p/subscriptions/t'],
    ['GMAIL_PUSH_SUBSCRIPTION', 'projects/p/subscriptions/s'],
    ['GMAIL_PUSH_SUBSCRIPTION', 'projects/p/topics/s'],
    ['GMAIL_PUSH_SUBSCRIPTION', 'projects/p/subscriptions/s/extra'],
    ['GMAIL_PUSH_SERVICE_ACCOUNT', 'push@p.iam.gserviceaccount.com'],
    ['GMAIL_PUSH_SERVICE_ACCOUNT', 'Push@P.iam.gserviceaccount.com'],
    ['GMAIL_PUSH_SERVICE_ACCOUNT', 'not-an-email'],
    ['GMAIL_PUSH_SERVICE_ACCOUNT', 'a b@c.d'],
    ['PUBLIC_BASE_URL', 'https://api.example.test'],
    ['PUBLIC_BASE_URL', 'https://api.example.test/'],
    ['PUBLIC_BASE_URL', 'https://api.example.test/base'],
    ['PUBLIC_BASE_URL', 'https://api.example.test/?x=1'],
    ['PUBLIC_BASE_URL', 'http://api.example.test'],
    ['PUBLIC_BASE_URL', 'api.example.test'],
  ]
  it.each(pairs)('%s = %s', async (name, value) => {
    const { w } = setup({ ...FULL, [name]: value })
    const o = await runSetup([...NONE, ...STEPS_ONLY, '--dry-run'], {}, w.deps)
    const setupRefuses = o.exitCode !== 0 && w.logs.join('\n').includes(name)
    const workerRefuses = parsePushConfig({ ...GOOD, [name]: value }).problems.includes(name)
    expect(setupRefuses).toBe(workerRefuses)
  })
})

describe('full set, real run: secrets by one bulk, vars by config:write', () => {
  it('--auth none: the bulk holds exactly the three Gmail secrets and config gets exactly the nine vars', async () => {
    const { w } = setup(FULL)
    const o = await twice(w, NONE)
    expect(o.exitCode).toBe(0)
    expect(states(o)).toEqual(['secrets:create'])
    expect(bulkPayloads(w)).toEqual([{ GOOGLE_CLIENT_SECRET: FULL.GOOGLE_CLIENT_SECRET, OAUTH_STATE_SECRET: FULL.OAUTH_STATE_SECRET, CREDENTIALS_KEY: FULL.CREDENTIALS_KEY }])
    const vars = configVars(w)
    expect(Object.fromEntries(VARS.map((k) => [k, vars[k]]))).toEqual(Object.fromEntries(VARS.map((k) => [k, FULL[k]])))
    for (const s of SECRETS) expect(Object.keys(vars)).not.toContain(s)
    for (const s of SECRETS) expect(w.state.configText).not.toContain(FULL[s]!)
  })

  it('--auth clerk: the bulk adds the two clerk secrets, the vars are the same nine beside the clerk ones', async () => {
    const { w } = setup(FULL, { configText: clerkConfig() }, true)
    await runSetup([...CLERK, '--only', 'config:write'], CONFIRM, w.deps)
    const o = await runSetup([...CLERK, '--only', 'secrets'], CONFIRM, w.deps)
    expect(o.exitCode).toBe(0)
    expect(w.secretInputs).toHaveLength(1)
    expect(Object.keys(bulkPayloads(w)[0]!).sort()).toEqual(['CLERK_JWT_KEY', 'CLERK_SECRET_KEY', ...SECRETS].sort())
    const vars = configVars(w)
    expect(Object.fromEntries(VARS.map((k) => [k, vars[k]]))).toEqual(Object.fromEntries(VARS.map((k) => [k, FULL[k]])))
    expect(vars.AUTH_PROVIDER).toBe('clerk')
    for (const s of SECRETS) expect(w.state.configText).not.toContain(FULL[s]!)
  })

  it('only the absent secrets are sent: a present one is left alone', async () => {
    const { w } = setup(FULL, { secrets: ['OAUTH_STATE_SECRET'] })
    await twice(w, NONE)
    expect(Object.keys(bulkPayloads(w)[0]!).sort()).toEqual(['CREDENTIALS_KEY', 'GOOGLE_CLIENT_SECRET'])
  })

  it('PUBLIC_BASE_URL defaults to https://<api-host> when the group is present and the file is silent; a given one wins', async () => {
    const a = setup(without('PUBLIC_BASE_URL'))
    await runSetup([...NONE, '--only', 'config:write'], CONFIRM, a.w.deps)
    expect(configVars(a.w).PUBLIC_BASE_URL).toBe('https://api.acme.vibase.ai')
    const b = setup(FULL)
    await runSetup([...NONE, '--only', 'config:write'], CONFIRM, b.w.deps)
    expect(configVars(b.w).PUBLIC_BASE_URL).toBe(FULL.PUBLIC_BASE_URL)
  })

  it('omitted optional vars are not written (the vars are exactly the present ones plus the default)', async () => {
    const { w } = setup(without('GMAIL_TOPIC_NAME', 'GMAIL_BACKFILL_DAYS', 'PUBLIC_BASE_URL'))
    await runSetup([...NONE, '--only', 'config:write'], CONFIRM, w.deps)
    const written = Object.keys(configVars(w)).filter((k) => (VARS as readonly string[]).includes(k)).sort()
    expect(written).toEqual(VARS.filter((k) => !['GMAIL_TOPIC_NAME', 'GMAIL_BACKFILL_DAYS'].includes(k)).sort())
  })

  it('names the file does not know are never passed through', async () => {
    const { w } = setup({ ...FULL, EXTRA_STRAY_SECRET: 'sentinel-stray-value' })
    await twice(w, NONE)
    expect(w.state.configText).not.toContain('sentinel-stray')
    expect(w.secretInputs.join('')).not.toContain('sentinel-stray')
  })
})

describe('idempotence', () => {
  it('a second run on the result: every row ok, no write, no secret bulk', async () => {
    const { w } = setup(FULL)
    await twice(w, NONE)
    const bulks = w.secretInputs.length
    const writes = w.state.configWrites
    const o = await runSetup([...NONE, ...STEPS_ONLY], CONFIRM, w.deps)
    expect(states(o)).toEqual(['config:write:ok', 'secrets:ok'])
    expect(w.state.configWrites).toBe(writes)
    expect(w.secretInputs.length).toBe(bulks)
  })

  it('a var that differs in wrangler.jsonc is the "never overwritten" fail naming the key; the file is unchanged', async () => {
    const { w } = setup(FULL)
    await runSetup([...NONE, '--only', 'config:write'], CONFIRM, w.deps)
    w.state.configText = w.state.configText.replace(FULL.GMAIL_BACKFILL_DAYS!, '9999')
    const before = w.state.configText
    const writes = w.state.configWrites
    const o = await runSetup([...NONE, '--only', 'config:write'], CONFIRM, w.deps)
    expect(states(o)).toEqual(['config:write:fail'])
    expect(w.logs.join('\n')).toContain('GMAIL_BACKFILL_DAYS')
    expect(w.logs.join('\n')).toMatch(/never overwritten/)
    expect(w.state.configText).toBe(before)
    expect(w.state.configWrites).toBe(writes)
  })

  it('a var the file omits stays as it is in wrangler.jsonc (never deleted)', async () => {
    const { w } = setup(FULL)
    await runSetup([...NONE, '--only', 'config:write'], CONFIRM, w.deps)
    const { w: w2 } = setup(without('GMAIL_BACKFILL_DAYS'), { configText: w.state.configText })
    const o = await runSetup([...NONE, '--only', 'config:write'], CONFIRM, w2.deps)
    expect(states(o)).toEqual(['config:write:ok'])
    expect(configVars(w2).GMAIL_BACKFILL_DAYS).toBe(FULL.GMAIL_BACKFILL_DAYS)
  })
})

describe('--rotate-secrets', () => {
  it('replaces GOOGLE_CLIENT_SECRET and OAUTH_STATE_SECRET but never CREDENTIALS_KEY, which is reported by name as kept', async () => {
    const { w } = setup(FULL, { secrets: [...SECRETS] })
    await runSetup([...NONE, '--only', 'config:write'], CONFIRM, w.deps)
    const o = await runSetup([...NONE, '--only', 'secrets', '--rotate-secrets'], CONFIRM, w.deps)
    expect(o.exitCode).toBe(0)
    expect(Object.keys(bulkPayloads(w)[0]!).sort()).toEqual(['GOOGLE_CLIENT_SECRET', 'OAUTH_STATE_SECRET'])
    const r = o.results[0]!
    expect([r.detail, ...(r.lines ?? [])].join('\n')).toMatch(/CREDENTIALS_KEY.*kept/)
  })

  it('an absent CREDENTIALS_KEY is still put, even with --rotate-secrets', async () => {
    const { w } = setup(FULL, { secrets: ['GOOGLE_CLIENT_SECRET', 'OAUTH_STATE_SECRET'] })
    await runSetup([...NONE, '--only', 'config:write'], CONFIRM, w.deps)
    await runSetup([...NONE, '--only', 'secrets', '--rotate-secrets'], CONFIRM, w.deps)
    expect(Object.keys(bulkPayloads(w)[0]!).sort()).toEqual([...SECRETS].sort())
  })

  it('with only CREDENTIALS_KEY present and rotating, nothing but the other two is sent, and CREDENTIALS_KEY is not in the payload', async () => {
    const { w } = setup(FULL, { secrets: ['CREDENTIALS_KEY'] })
    await runSetup([...NONE, '--only', 'config:write'], CONFIRM, w.deps)
    await runSetup([...NONE, '--only', 'secrets', '--rotate-secrets'], CONFIRM, w.deps)
    expect(Object.keys(bulkPayloads(w)[0]!)).not.toContain('CREDENTIALS_KEY')
  })
})

describe('--dry-run with a full set', () => {
  for (const mode of ['none', 'clerk'] as const)
    it(`${mode}: no write command, no secret bulk, no file write, and the plan names variables only`, async () => {
      const { w, clerk } = setup(FULL, mode === 'clerk' ? { configText: clerkConfig() } : {}, mode === 'clerk')
      const o = await runSetup([...ARGS[mode], '--dry-run', ...STEPS_ONLY], {}, w.deps)
      expect(o.exitCode).toBe(0)
      expect(w.writes()).toEqual([])
      expect(w.secretInputs).toEqual([])
      expect(w.state.configWrites).toBe(0)
      expect(clerk.writes()).toEqual([])
      const t = w.logs.join('\n')
      for (const n of [...SECRETS, ...VARS]) expect(t).toContain(n)
      for (const s of SENTINELS) expect(t).not.toContain(s)
    })
})

describe('no value leaks', () => {
  const surface = (w: World, o?: SetupOutcome) =>
    [w.surface(), ...(o?.results ?? []).flatMap((r) => [r.detail, ...(r.lines ?? []), ...(r.manual ?? [])]), w.fetched.join('\n')].join('\n')
  const expectClean = (text: string) => {
    for (const s of SENTINELS) expect(text, `a value of the file reached the output`).not.toContain(s)
  }
  // The secret bulk's own stdin is the one place a secret travels, so the argv-and-logs surface excludes it.

  it('dry run and real run, none and clerk, print variable names only', async () => {
    for (const mode of ['none', 'clerk'] as const) {
      const { w } = setup(FULL, mode === 'clerk' ? { configText: clerkConfig() } : {}, mode === 'clerk')
      const outs = [await runSetup([...ARGS[mode], '--dry-run', '--only', 'config:write'], {}, w.deps), await runSetup([...ARGS[mode], '--only', 'config:write'], CONFIRM, w.deps), await runSetup([...ARGS[mode], '--only', 'secrets'], CONFIRM, w.deps)]
      for (const o of outs) expect(o.exitCode).toBe(0)
      expectClean(surface(w, outs[2]))
      expect(w.secretInputs.join('')).toContain(FULL.GOOGLE_CLIENT_SECRET!)
    }
  })

  it('the config diff names the vars it writes, with their values hidden', async () => {
    const { w } = setup(FULL)
    const o = await runSetup([...NONE, '--only', 'config:write', '--dry-run'], {}, w.deps)
    const lines = o.results[0]!.lines!.join('\n')
    for (const n of VARS) expect(lines).toContain(n)
    expectClean(surface(w, o))
  })

  it('a failing secret bulk and a failing secret list leak nothing', async () => {
    const { w } = setup(FULL)
    await runSetup([...NONE, '--only', 'config:write'], CONFIRM, w.deps)
    const exec = w.deps.exec
    w.deps.exec = async (cmd) => {
      if (cmd.args.includes('bulk')) {
        w.secretInputs.push(cmd.input ?? '')
        return { status: 1, stdout: '', stderr: `boom ${cmd.input}` }
      }
      return exec(cmd)
    }
    const secretsRun = await runSetup([...NONE, '--only', 'secrets'], CONFIRM, w.deps)
    expect(secretsRun.exitCode).toBe(1)
    const inStdinOnly = w.logs.join('\n') + secretsRun.results.map((r) => r.detail + (r.lines ?? []).join('')).join('')
    expectClean(inStdinOnly)
    w.deps.exec = async (cmd) => (cmd.args.includes('list') && cmd.args.includes('secret') ? { status: 1, stdout: '', stderr: `nope ${FULL.GOOGLE_CLIENT_SECRET}` } : exec(cmd))
    const listRun = await runSetup([...NONE, '--only', 'secrets'], CONFIRM, w.deps)
    expect(listRun.exitCode).toBe(1)
    expectClean(w.logs.join('\n') + listRun.results.map((r) => r.detail + (r.lines ?? []).join('')).join(''))
  })

  it('each refusal (partial, bad shape) leaks nothing, whichever name is wrong', async () => {
    for (const name of Object.keys(FULL)) {
      const { w } = setup({ ...FULL, [name]: undefined })
      const o = await runSetup(NONE, CONFIRM, w.deps)
      if (CORE.includes(name)) expect(o.exitCode).toBe(1)
      expectClean(w.logs.join('\n'))
    }
  })

  it('a thrown error with a value in its text is not echoed', async () => {
    const { w } = setup(FULL)
    w.deps.readConfigText = () => {
      throw new Error('cannot read')
    }
    const o = await runSetup([...NONE, '--only', 'config:write'], CONFIRM, w.deps)
    expect(o.exitCode).toBe(1)
    expectClean(w.logs.join('\n'))
  })
})

describe('the env file guards hold with --auth none too', () => {
  for (const status of ['root-env', 'not-ignored'] as const)
    it(`${status}: refused before any command or request, values never parsed into output`, async () => {
      const { w } = setup(FULL, { clerkFileStatus: status })
      for (const dry of [false, true]) {
        const o = await runSetup([...NONE, ...(dry ? ['--dry-run'] : [])], CONFIRM, w.deps)
        expect(o.exitCode).toBe(1)
      }
      expect(w.argv).toEqual([])
      expect(w.fetched).toEqual([])
      expect(w.logs.join('\n')).toMatch(status === 'root-env' ? /root \.env/ : /ignore/)
      for (const s of SENTINELS) expect(w.logs.join('\n')).not.toContain(s)
    })

  it('a missing file on --auth none is a skip, not a refusal; on --auth clerk it still refuses', async () => {
    const a = setup(null)
    expect((await runSetup([...NONE, '--dry-run'], {}, a.w.deps)).exitCode).toBe(0)
    const b = setup(null, { clerkEnvText: null }, true)
    expect((await runSetup([...CLERK, '--dry-run'], {}, b.w.deps)).exitCode).toBe(1)
  })

  it('the process environment is never read for the Gmail values', async () => {
    const saved = process.env.GOOGLE_CLIENT_SECRET
    process.env.GOOGLE_CLIENT_SECRET = 'sentinel-from-process-env'
    try {
      const { w } = setup(null)
      await runSetup([...NONE, '--dry-run'], { GOOGLE_CLIENT_SECRET: 'sentinel-from-process-env' }, w.deps)
      expect(w.logs.join('\n')).toMatch(/gmail.*skipped/i)
    } finally {
      if (saved === undefined) delete process.env.GOOGLE_CLIENT_SECRET
      else process.env.GOOGLE_CLIENT_SECRET = saved
    }
  })
})

// [[OPS501]] D1, D3-D6: the settings file init writes, read by setup's short form and refused by every command that needs a set-up instance. Everything runs through the real
// entry points (runSetup, runStatus, runOwnerReset, parseSettings) on the instance kit's fake Cloudflare, a real settings file on disk and two real local D1s behind bootstrap.
import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openWorkerPair, type WorkerPair } from '../../src/test/kit.js'
import { ALL_MIGRATIONS, API_HOST, setupWorld, type SetupWorld, type SetupWorldOptions } from './setup-kit.js'
import { runOwnerReset } from './owner-reset.js'
import { parseSettings } from './settings.js'
import { runSetup } from './setup.js'
import { runStatus } from './status.js'
import { CONTROL_ALL, CONTROL_UUID, SECRETS_TEXT, UUID, cleanup, controlSettings, makeWorld } from './test-kit.js'

const OWNER = 'owner@example.com'
const INIT = { version: 1, env: 'demo', stage: 'init', api_host: API_HOST, auth: 'better-auth', owner_email: OWNER }
const SHORT = ['--env', 'demo']

let pair: WorkerPair
beforeAll(async () => {
  pair = await openWorkerPair()
}, 60_000)
afterAll(async () => {
  await pair.dispose()
})
beforeEach(async () => {
  await pair.reset()
})
afterEach(() => cleanup())

const world = (o: Partial<SetupWorldOptions> = {}): SetupWorld =>
  setupWorld({ d1: pair, control: pair.control, secretsText: SECRETS_TEXT, ...o })
const run = (s: SetupWorld, argv: string[]) => runSetup(argv, s.w.deps)
const header = (s: SetupWorld) => s.w.out.find((l) => l.startsWith('setup: env')) ?? ''
const invitations = async () =>
  (((await pair.control.prepare('select email from invitations').all()).results ?? []) as { email: string }[]).map(
    (r) => r.email,
  )
const settingsJson = (s: SetupWorld) => JSON.parse(readFileSync(s.w.settingsPath, 'utf8')) as Record<string, unknown>
/** A fresh instance's Cloudflare account state after a first run created everything (for runs that start from a full record). */
const created = {
  d1s: [
    { uuid: UUID, name: 'vb-crm-demo' },
    { uuid: CONTROL_UUID, name: 'vb-control-demo' },
  ],
  r2s: ['vb-bodies-demo'],
}

describe('2. the parser and the other commands (D1, D4, D5)', () => {
  const full = controlSettings({ vars: { AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: `https://${API_HOST}` } })
  it('stage with a full-record key is refused naming that key', () => {
    for (const key of ['worker', 'd1', 'vars', 'r2_bucket'])
      expect(() => parseSettings(JSON.stringify({ ...INIT, [key]: full[key] }), 'demo', '/s/demo.json')).toThrow(
        new RegExp(`"${key}" is not allowed with stage "init"`),
      )
  })
  it('a full record carrying an init-only key (auth) is refused naming the key', () => {
    expect(() => parseSettings(JSON.stringify({ ...full, auth: 'clerk' }), 'demo', '/s/demo.json')).toThrow(
      /unknown key "auth"/,
    )
  })
  it('an unknown stage value is refused naming it', () => {
    expect(() => parseSettings(JSON.stringify({ ...INIT, stage: 'later' }), 'demo', '/s/demo.json')).toThrow(
      /stage "later"/,
    )
  })
  it('a full record with owner_email loads, and keeps it', () => {
    expect(parseSettings(JSON.stringify({ ...full, owner_email: OWNER }), 'demo', '/s/demo.json').owner_email).toBe(
      OWNER,
    )
  })
  it('a full record with owner_email goes through status and owner-reset without a parse refusal', async () => {
    const settings = { ...full, owner_email: OWNER }
    const a = makeWorld({ settings })
    await runStatus(['--env', 'demo'], a.deps)
    expect(a.all()).not.toMatch(/owner_email|unknown key/)
    const b = makeWorld({ settings })
    await runOwnerReset(['--env', 'demo', '--dry-run'], b.deps)
    expect(b.all()).not.toMatch(/owner_email|unknown key/)
  })
  it.each([
    ['status', (w: ReturnType<typeof makeWorld>) => runStatus(['--env', 'demo'], w.deps)],
    ['owner-reset', (w: ReturnType<typeof makeWorld>) => runOwnerReset(['--env', 'demo'], w.deps)],
  ])('%s refuses an init-written file: exit 2, the not-set-up message, no Cloudflare call', async (_n, go) => {
    const w = makeWorld({ settings: INIT })
    expect(await go(w)).toBe(2)
    expect(w.err.join('\n')).toContain(
      `demo is not set up yet (${w.settingsPath} was written by init): run vibase-server setup --env demo`,
    )
    expect(w.fetchUrls).toEqual([])
    expect(w.wrangler).toEqual([])
  })
})

describe('3. setup reads the init file (D3)', () => {
  it('the short form plans with the recorded host, provider and owner email', async () => {
    const s = world({ settings: INIT })
    expect(await run(s, [...SHORT, '--dry-run']), s.w.all()).toBe(0)
    expect(header(s)).toContain(`auth better-auth, api host ${API_HOST}`)
    expect(header(s)).toContain('written by init')
  })
  it('the short form issues the owner invitation to the recorded email', async () => {
    const s = world({ settings: INIT })
    expect(await run(s, SHORT), s.w.all()).toBe(0)
    expect(await invitations()).toEqual([OWNER])
  })
  const REFUSED: [string, string[], RegExp][] = [
    ['--api-host other', ['--api-host', 'other.demo.invalid'], /--api-host other\.demo\.invalid.*api_host/],
    ['--workers-dev', ['--workers-dev'], /--workers-dev.*api_host/],
    ['--auth other', ['--auth', 'none'], /--auth none.*better-auth/],
    ['--owner-email other', ['--owner-email', 'other@example.com'], /--owner-email other@example\.com.*owner_email/],
    ['--change-host', ['--change-host'], /--change-host/],
  ]
  it.each(REFUSED)('%s is refused (exit 2) before any step, naming the file', async (_n, flags, re) => {
    const s = world({ settings: INIT })
    const before = readFileSync(s.w.settingsPath, 'utf8')
    expect(await run(s, [...SHORT, ...flags])).toBe(2)
    const said = s.w.err.join('\n')
    expect(said).toContain(s.w.settingsPath)
    expect(said).toMatch(re)
    expect(said).not.toMatch(/OPS250/)
    expect(said).not.toMatch(/(?:pass|add|use|give) --change-host/)
    expect(s.writes()).toEqual([])
    expect(s.w.wrangler).toEqual([])
    expect(readFileSync(s.w.settingsPath, 'utf8')).toBe(before)
  })
  it('a flag equal to the recorded value runs', async () => {
    const s = world({ settings: INIT })
    expect(
      await run(s, [...SHORT, '--api-host', API_HOST, '--auth', 'better-auth', '--owner-email', OWNER, '--dry-run']),
      s.w.all(),
    ).toBe(0)
  })
  it('an auth none file without an owner email plans with none', async () => {
    const s = world({ settings: { ...INIT, auth: 'none', owner_email: undefined } })
    expect(await run(s, [...SHORT, '--dry-run']), s.w.all()).toBe(0)
    expect(header(s)).toContain('auth none')
  })
})

describe('4. config:write adopts the init file (D4)', () => {
  it('a real run writes the full record with owner_email (a create row) in place of the init file', async () => {
    const s = world({ settings: INIT })
    expect(await run(s, SHORT), s.w.all()).toBe(0)
    const row = s.rows().find((r) => r.step === 'config:write')!
    expect(row.status).toBe('create')
    expect(row.detail).toContain("adopting init's file")
    const j = settingsJson(s)
    expect(j.stage).toBeUndefined()
    expect(j).toMatchObject({ worker: 'vb-demo', api_host: API_HOST, owner_email: OWNER })
  })
  it('a dry run leaves the init file byte-identical and says would write', async () => {
    const s = world({ settings: INIT })
    const before = readFileSync(s.w.settingsPath, 'utf8')
    expect(await run(s, [...SHORT, '--dry-run']), s.w.all()).toBe(0)
    expect(readFileSync(s.w.settingsPath, 'utf8')).toBe(before)
    expect(s.rows().find((r) => r.step === 'config:write')!.detail).toMatch(/^would write/)
  })
  it('a run that fails at migrate after config:write is followed by a short-form rerun that issues the invitation to the recorded email', async () => {
    const s = world({ settings: INIT, sim: { ...created, failApply: true } })
    expect(await run(s, SHORT)).toBe(3)
    expect(settingsJson(s).owner_email).toBe(OWNER)
    s.sim.failApply = false
    s.w.out.length = 0
    s.w.err.length = 0
    expect(await run(s, SHORT), s.w.all()).toBe(0)
    expect(await invitations()).toEqual([OWNER])
  })
  const recordedFull = (extra: Record<string, unknown> = {}) =>
    controlSettings({
      worker: 'vb-demo',
      d1: { name: 'vb-crm-demo', id: UUID },
      control_d1: { name: 'vb-control-demo', id: CONTROL_UUID },
      r2_bucket: 'vb-bodies-demo',
      workflow: { name: 'vb-mail-sync-demo' },
      vars: { AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: `https://${API_HOST}`, CORS_ALLOWED_ORIGINS: '' },
      ...extra,
    })
  const state = { ...created, applied: [...ALL_MIGRATIONS], controlApplied: [...CONTROL_ALL] }
  it('an existing full record without owner_email stays as it is (no key added) when --owner-email is passed', async () => {
    const s = world({ settings: recordedFull(), sim: state })
    expect(await run(s, [...SHORT, '--api-host', API_HOST, '--owner-email', OWNER, '--dry-run']), s.w.all()).toBe(0)
    expect(s.rows().find((r) => r.step === 'config:write')!.detail).toContain('is as desired')
    expect(settingsJson(s).owner_email).toBeUndefined()
    expect(await run(s, [...SHORT, '--api-host', API_HOST, '--owner-email', OWNER]), s.w.all()).toBe(0)
    expect(settingsJson(s).owner_email).toBeUndefined()
  })
  it('a full record with owner_email and a differing --owner-email is refused, pointing at owner-reset', async () => {
    const s = world({ settings: recordedFull({ owner_email: OWNER }), sim: state })
    expect(await run(s, [...SHORT, '--owner-email', 'other@example.com'])).toBe(2)
    expect(s.w.err.join('\n')).toMatch(/owner_email.*owner-reset --env demo --email/s)
    expect(s.writes()).toEqual([])
  })
  it('a full record with owner_email takes it as the default', async () => {
    const s = world({ settings: recordedFull({ owner_email: OWNER }), sim: state })
    expect(await run(s, SHORT), s.w.all()).toBe(0)
    expect(await invitations()).toEqual([OWNER])
  })
  it("empty state: no settings file keeps today's rule (a new better-auth instance needs --owner-email)", async () => {
    const s = world({ settings: null })
    expect(await run(s, ['--env', 'demo', '--api-host', API_HOST, '--dry-run'])).toBe(2)
    expect(s.w.err.join('\n')).toMatch(/--owner-email is required/)
  })
})

describe('5. the host flags are optional for a recorded instance (D6)', () => {
  const recorded = (over: Record<string, unknown> = {}) =>
    controlSettings({
      worker: 'vb-demo',
      d1: { name: 'vb-crm-demo', id: UUID },
      control_d1: { name: 'vb-control-demo', id: CONTROL_UUID },
      r2_bucket: 'vb-bodies-demo',
      workflow: { name: 'vb-mail-sync-demo' },
      vars: { AUTH_PROVIDER: '', CORS_ALLOWED_ORIGINS: '' },
      ...over,
    })
  const state = { d1s: created.d1s, r2s: created.r2s, applied: [...ALL_MIGRATIONS], controlApplied: [...CONTROL_ALL] }
  it('a full custom-domain record runs on the recorded host', async () => {
    const s = world({ settings: recorded(), sim: state })
    expect(await run(s, [...SHORT, '--dry-run']), s.w.all()).toBe(0)
    expect(header(s)).toContain(`api host ${API_HOST}`)
    expect(header(s)).not.toContain('workers.dev')
  })
  it('a workers_dev record runs as --workers-dev', async () => {
    const s = world({
      settings: recorded({ api_host: 'vb-demo.team.workers.dev', workers_dev: true }),
      sim: { ...state, subdomain: { subdomain: 'team', puts: [] } },
    })
    expect(await run(s, [...SHORT, '--dry-run']), s.w.all()).toBe(0)
    expect(header(s)).toContain('vb-demo.team.workers.dev (workers.dev)')
  })
  it('no settings file is refused as today', async () => {
    const s = world({ settings: null })
    expect(await run(s, [...SHORT, '--auth', 'none', '--dry-run'])).toBe(2)
    expect(s.w.err.join('\n')).toMatch(/give --api-host <host> .* or --workers-dev/)
  })
  it('setup:remote with a recorded env and no host flag still refuses', async () => {
    const { parseSetupArgs } = await import('../setup/args.js')
    expect(() => parseSetupArgs(['--env', 'demo', '--auth', 'none'], () => ({ provider: 'none', where: 'x' }))).toThrow(
      /give --api-host/,
    )
  })
})

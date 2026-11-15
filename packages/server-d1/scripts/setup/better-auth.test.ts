// OPS249 cycle 1 on `setup:remote`: the provider rule (D1), the Better Auth vars (D2), `AUTH_SECRET` (D3), the Google pair (D4), the bootstrap step (D6) and re-runs that never
// re-issue the owner link (D7). The same obligations for `vibase-server setup` are in instance/setup-better-auth.test.ts. Everything runs against the setup kit's faked wrangler,
// Cloudflare API and fetch, with two real local D1s (CRM and control) behind the proxy.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendEnvFileVar } from './env-file.js'
import { applyEdits, modify, parse } from 'jsonc-parser'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openControlDb, readControlMarker } from '@vibase/storage-d1'
import { seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { bootstrapD1 } from '../../src/bootstrap-d1.js'
import { openWorkerPair, type WorkerPair } from '../../src/test/kit.js'
import { runSetup } from './run.js'
import { FIXTURE_CONFIG_PATH, makeWorld, type World, type WorldOptions } from './test/world.js'

const CONFIRM = { CONFIRM_REMOTE: '1' }
const HOST = 'api.acme.vibase.ai'
const BASE = `https://${HOST}`
const OWNER = 'owner@example.com'
const ACME = ['--env', 'acme', '--api-host', HOST, '--owner-email', OWNER]
const fixture = readFileSync(FIXTURE_CONFIG_PATH, 'utf8')
const SECRET_43 = 'A'.repeat(20) + 'b'.repeat(20) + '-_9'

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

const world = (o: Partial<WorldOptions> = {}): World => makeWorld({ d1: pair.d1, control: pair.control, clerkEnvText: null, ...o })
const run = (w: World, argv: string[] = ACME) => runSetup(argv, CONFIRM, w.deps)
const dry = (w: World, argv: string[] = ACME) => runSetup([...argv, '--dry-run'], {}, w.deps)
const rows = async (d1: WorkerPair['d1'], q: string) => ((await d1.prepare(q).all()).results ?? []) as Record<string, any>[]
const step = (o: Awaited<ReturnType<typeof runSetup>>, name: string) => o.results.find((r) => r.step === name)!
const header = (w: World) => /, auth (\S+),/.exec(w.logs.find((l) => l.startsWith('setup:remote env')) ?? '')?.[1]
const withRecord = (vars: Record<string, string>) => applyEdits(fixture, modify(fixture, ['env', 'acme'], { name: 'vb-acme', vars }, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
const tokenOf = (logs: string[]) => /\/invite#token=([A-Za-z0-9_-]+)/.exec(logs.join('\n'))?.[1]
const urlLines = (logs: string[]) => logs.filter((l) => l.includes('/invite#token='))

/** The first run of a new instance writes the env block and stops ([[OPS65]] D10); the second one does the rest. */
async function firstRun(w: World, argv: string[] = ACME): Promise<void> {
  const o = await run(w, argv)
  expect(o.stoppedAfterConfigWrite, w.logs.join('\n')).toBe(true)
}
async function fullRun(w: World, argv: string[] = ACME) {
  await firstRun(w, argv)
  w.logs.length = 0
  return run(w, argv)
}

describe('1. the provider rule (D1): matrix over a new instance and a recorded one', () => {
  const NEW: [string, string[], string][] = [
    ['no flag', [], 'better-auth'],
    ['--auth clerk', ['--auth', 'clerk'], 'clerk'],
    ['--auth none', ['--auth', 'none'], 'none'],
  ]
  it.each(NEW)('a new instance, %s: runs as %s', async (_n, flag, expected) => {
    const w = world({ clerkEnvText: undefined })
    await dry(w, [...ACME, ...flag])
    expect(header(w), w.logs.join('\n')).toBe(expected)
  })

  const RECORDS: [string, Record<string, string>, string][] = [
    ['better-auth', { AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: BASE }, 'better-auth'],
    ['clerk', { AUTH_PROVIDER: 'clerk' }, 'clerk'],
    ['none (smoked1-shaped: AUTH_PROVIDER empty)', { AUTH_PROVIDER: '', CORS_ALLOWED_ORIGINS: '' }, 'none'],
    ['none (no AUTH_PROVIDER at all)', { CORS_ALLOWED_ORIGINS: '' }, 'none'],
  ]
  const ALL = ['better-auth', 'clerk', 'none']
  describe.each(RECORDS)('recorded %s', (_n, vars, recorded) => {
    const mk = () => world({ configText: withRecord(vars), clerkEnvText: undefined })
    it('no flag: the recorded provider', async () => {
      const w = mk()
      await dry(w)
      expect(header(w), w.logs.join('\n')).toBe(recorded)
    })
    it('the same flag: accepted', async () => {
      const w = mk()
      await dry(w, [...ACME, '--auth', recorded])
      expect(header(w), w.logs.join('\n')).toBe(recorded)
    })
    it.each(ALL.filter((p) => p !== recorded))('--auth %s differs: refused before any wrangler or Cloudflare call, exit 1, naming the record and OPS250', async (flag) => {
      const w = mk()
      const o = await dry(w, [...ACME, '--auth', flag])
      expect(o.exitCode).toBe(1)
      expect(o.results).toEqual([])
      expect(w.argv).toEqual([])
      expect(w.fetched).toEqual([])
      const said = w.logs.join('\n')
      expect(said).toContain(`--auth ${flag}`)
      expect(said).toContain(recorded)
      expect(said).toContain('OPS250')
    })
  })
})

describe('2. vars and refusals on better-auth (D2)', () => {
  it('the env block holds AUTH_PROVIDER and PUBLIC_BASE_URL and no Clerk variable, read back from the config editor\'s text', async () => {
    const w = world()
    await firstRun(w)
    const block = (parse(w.state.configText) as { env: Record<string, any> }).env.acme
    expect(block.vars).toEqual({ AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: BASE, CORS_ALLOWED_ORIGINS: '' })
    expect(JSON.stringify(block)).not.toMatch(/CLERK|AUTH_CLI_CLIENT_ID|AUTH_ROLE_CLAIM/)
    expect(block.workers_dev).toBe(false)
    expect(block.routes).toEqual([{ pattern: HOST, custom_domain: true }])
    // the written text is itself a record: the next run reads better-auth from it and finds nothing to change
    const again = await run(w)
    expect(step(again, 'config:write').status).toBe('ok')
  })

  it.each([['--clerk-publishable-key', 'pk_test_x'], ['--clerk-production'], ['--no-dcr']])('%s is refused with better-auth, before any step', async (...flag) => {
    const w = world()
    const o = await run(w, [...ACME, ...flag])
    expect(o.exitCode).toBe(1)
    expect(w.logs.join('\n')).toContain('--auth clerk')
    expect(w.argv).toEqual([])
    expect(w.fetched).toEqual([])
  })

  const gmail = (base?: string) => `GOOGLE_CLIENT_ID=gid.apps.googleusercontent.com\nGOOGLE_CLIENT_SECRET=gsecret-0123456789\nOAUTH_STATE_SECRET=state-0123456789\nCREDENTIALS_KEY=${Buffer.alloc(32, 7).toString('base64')}\n${base ? `PUBLIC_BASE_URL=${base}\n` : ''}`
  it('a Gmail-group PUBLIC_BASE_URL that differs from the derived one is refused before any step', async () => {
    const w = world({ clerkEnvText: gmail('https://other.example.com') })
    const o = await run(w)
    expect(o.exitCode).toBe(1)
    expect(w.logs.join('\n')).toMatch(/PUBLIC_BASE_URL/)
    expect(w.argv).toEqual([])
    expect(w.fetched).toEqual([])
  })
  it('the same value as the derived one is accepted', async () => {
    const w = world({ clerkEnvText: gmail(BASE) })
    await firstRun(w)
    expect((parse(w.state.configText) as any).env.acme.vars.PUBLIC_BASE_URL).toBe(BASE)
  })
})

describe('3. AUTH_SECRET (D3), four states', () => {
  const ONLY = [...ACME, '--only', 'secrets']
  const secretsRun = async (w: World, argv = ONLY) => {
    w.events.length = 0
    w.logs.length = 0
    return run(w, argv)
  }
  const bulk = (w: World) => w.secretInputs.map((s) => JSON.parse(s) as Record<string, string>)

  it('(a) neither file nor Worker: generated (43 base64url characters), written to the file BEFORE the put, put on stdin only', async () => {
    const w = world()
    await firstRun(w)
    const o = await secretsRun(w)
    expect(o.exitCode, w.logs.join('\n')).toBe(0)
    expect(w.events).toEqual(['file:AUTH_SECRET', 'put:AUTH_SECRET'])
    const value = bulk(w)[0]!.AUTH_SECRET!
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(w.state.envFileText).toBe(`AUTH_SECRET=${value}\n`)
    expect(step(o, 'secrets').status).toBe('create')
    expect(w.surface()).not.toContain(value)
    expect(w.state.configText).not.toContain(value)
  })

  it('(a) a put that fails leaves the value in the file; the next run is state (b) and puts the same value', async () => {
    const w = world()
    w.state.failBulk = true
    await firstRun(w)
    const failed = await secretsRun(w)
    expect(failed.exitCode).toBe(1)
    expect(step(failed, 'secrets').status).toBe('fail')
    const stored = /^AUTH_SECRET=(\S+)$/m.exec(w.state.envFileText ?? '')?.[1]
    expect(stored, 'the value must survive a failed put').toMatch(/^[A-Za-z0-9_-]{43}$/)
    w.state.failBulk = false
    const again = await secretsRun(w)
    expect(again.exitCode).toBe(0)
    expect(w.events).toEqual(['put:AUTH_SECRET'])
    expect(bulk(w)[0]!.AUTH_SECRET).toBe(stored)
    expect(w.state.envFileText).toBe(`AUTH_SECRET=${stored}\n`)
  })

  it('(b) file only: the file\'s value is put; nothing is generated or written', async () => {
    const w = world({ clerkEnvText: `AUTH_SECRET=${SECRET_43}\n` })
    await firstRun(w)
    const o = await secretsRun(w)
    expect(o.exitCode).toBe(0)
    expect(w.events).toEqual(['put:AUTH_SECRET'])
    expect(bulk(w)).toEqual([{ AUTH_SECRET: SECRET_43 }])
    expect(w.state.envFileText).toBe(`AUTH_SECRET=${SECRET_43}\n`)
  })

  it('(c) both: no write and no put', async () => {
    const w = world({ clerkEnvText: `AUTH_SECRET=${SECRET_43}\n`, secrets: ['AUTH_SECRET'] })
    await firstRun(w)
    const o = await secretsRun(w)
    expect(step(o, 'secrets').status).toBe('ok')
    expect(w.events).toEqual([])
    expect(w.secretInputs).toEqual([])
    expect(w.state.envFileText).toBe(`AUTH_SECRET=${SECRET_43}\n`)
  })

  it('(d) Worker only: nothing generated, nothing written, nothing put, and a `manual` step that names the file', async () => {
    const w = world({ secrets: ['AUTH_SECRET'] })
    await firstRun(w)
    const o = await secretsRun(w)
    expect(o.exitCode).toBe(0)
    expect(w.events).toEqual([])
    expect(w.secretInputs).toEqual([])
    expect(w.state.envFileText).toBeNull()
    const s = step(o, 'secrets')
    expect(s.status).toBe('manual')
    expect(s.detail).toBe('AUTH_SECRET is set on the Worker but not in .env.acme: owner-reset needs it; copy it in if you have it')
    expect(w.logs.join('\n')).toMatch(/manual:\n\s+secrets: AUTH_SECRET is set on the Worker/)
  })

  it('--rotate-secrets never replaces AUTH_SECRET (present on both sides, and file only)', async () => {
    const both = world({ clerkEnvText: `AUTH_SECRET=${SECRET_43}\n`, secrets: ['AUTH_SECRET'] })
    await firstRun(both)
    await secretsRun(both, [...ONLY, '--rotate-secrets'])
    expect(both.secretInputs).toEqual([])
    expect(both.events).toEqual([])
    const only = world({ secrets: ['AUTH_SECRET'] })
    await firstRun(only)
    await secretsRun(only, [...ONLY, '--rotate-secrets'])
    expect(only.secretInputs).toEqual([])
    expect(only.state.envFileText).toBeNull()
  })

  it('(a) a missing file git does not ignore is never created: the step fails, "nothing was put", no secret bulk runs', async () => {
    const w = world({ missingFileNotIgnored: true })
    await firstRun(w, [...ACME, '--clerk-env-file', 'in-repo/missing.env'])
    const o = await secretsRun(w, [...ACME, '--clerk-env-file', 'in-repo/missing.env', '--only', 'secrets'])
    expect(step(o, 'secrets').status).toBe('fail')
    expect(step(o, 'secrets').detail).toContain('nothing was put')
    expect(w.state.envFileText).toBeNull()
    expect(w.secretInputs).toEqual([])
  })

  it('the real appendEnvFileVar refuses to create a missing file that git does not ignore, and creates an ignored one with mode 600', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ops249-repo-'))
    spawnSync('git', ['init', '-q'], { cwd: repo })
    writeFileSync(join(repo, '.gitignore'), '.env.*\n')
    expect(() => appendEnvFileVar('plain.txt', 'acme', 'AUTH_SECRET', 'v', repo, join(repo, '.env'))).toThrow(/not ignored/)
    expect(existsSync(join(repo, 'plain.txt'))).toBe(false)
    appendEnvFileVar(undefined, 'acme', 'AUTH_SECRET', 'v', repo, join(repo, '.env'))
    expect(readFileSync(join(repo, '.env.acme'), 'utf8')).toBe('AUTH_SECRET=v\n')
  })

  it('a dry run reports state (a) and writes and puts nothing', async () => {
    const w = world()
    await firstRun(w)
    w.events.length = 0
    const o = await dry(w, ONLY)
    expect(step(o, 'secrets').status).toBe('create')
    expect(step(o, 'secrets').detail).toMatch(/AUTH_SECRET/)
    expect(w.events).toEqual([])
    expect(w.state.envFileText).toBeNull()
  })

  it('a file value that the Worker would refuse (under 32 characters) is refused before any step', async () => {
    const w = world({ clerkEnvText: 'AUTH_SECRET=short\n' })
    const o = await run(w)
    expect(o.exitCode).toBe(1)
    expect(w.logs.join('\n')).toMatch(/AUTH_SECRET/)
    expect(w.argv).toEqual([])
  })
})

describe('4. the Google pair (D4)', () => {
  const ONLY = [...ACME, '--only', 'secrets']
  it('both values are put as Worker secrets, beside AUTH_SECRET', async () => {
    const w = world({ clerkEnvText: `AUTH_SECRET=${SECRET_43}\nAUTH_GOOGLE_CLIENT_ID=gid-1.apps.googleusercontent.com\nAUTH_GOOGLE_CLIENT_SECRET=gsecret-CANARY-0123\n` })
    await firstRun(w)
    const o = await run(w, ONLY)
    expect(o.exitCode, w.logs.join('\n')).toBe(0)
    expect(JSON.parse(w.secretInputs[0]!)).toEqual({ AUTH_SECRET: SECRET_43, AUTH_GOOGLE_CLIENT_ID: 'gid-1.apps.googleusercontent.com', AUTH_GOOGLE_CLIENT_SECRET: 'gsecret-CANARY-0123' })
    expect(w.surface()).not.toContain('gsecret-CANARY-0123')
  })
  it.each([['AUTH_GOOGLE_CLIENT_ID=gid-1.apps.googleusercontent.com', 'AUTH_GOOGLE_CLIENT_SECRET'], ['AUTH_GOOGLE_CLIENT_SECRET=gsecret-0123456789', 'AUTH_GOOGLE_CLIENT_ID']])('%s alone is refused before any step, naming %s', async (half, missing) => {
    const w = world({ clerkEnvText: `${half}\n` })
    const o = await run(w)
    expect(o.exitCode).toBe(1)
    expect(w.logs.join('\n')).toContain(missing)
    expect(w.logs.join('\n')).not.toContain('gsecret-0123456789')
    expect(w.argv).toEqual([])
    expect(w.fetched).toEqual([])
  })
  it('without either, nothing Google is put', async () => {
    const w = world()
    await firstRun(w)
    await run(w, ONLY)
    expect(Object.keys(JSON.parse(w.secretInputs[0]!))).toEqual(['AUTH_SECRET'])
  })
})

describe('5. the bootstrap step on better-auth (D6)', () => {
  it('writes the marker better-auth:<env>, the control marker, the vibase-cli seed named by PUBLIC_BASE_URL and the owner invitation', async () => {
    const w = world()
    const o = await fullRun(w)
    expect(o.exitCode, w.logs.join('\n')).toBe(0)
    expect(step(o, 'bootstrap').status).toBe('create')
    const [dep] = await rows(pair.d1, 'select organization_id, auth_provider, auth_org_id from deployment')
    expect(dep).toMatchObject({ auth_provider: 'better-auth', auth_org_id: 'acme' })
    expect((await readControlMarker(openControlDb(pair.control)))?.organizationId).toBe(dep!.organization_id)
    expect(await rows(pair.control, "select client_id from auth_oauth_clients where client_id = 'vibase-cli'")).toHaveLength(1)
    expect((await rows(pair.control, "select resource_id from auth_oauth_client_resources where client_id = 'vibase-cli' order by resource_id")).map((r) => r.resource_id)).toEqual([BASE, `${BASE}/mcp`])
    const invitations = await rows(pair.control, 'select email, role, accepted_at, revoked_at from invitations')
    expect(invitations).toEqual([{ email: OWNER, role: 'owner', accepted_at: null, revoked_at: null }])
    expect(await rows(pair.d1, 'select * from users')).toEqual([])
  })

  it('the owner invitation is the last write: it comes after the organisation and the control marker', async () => {
    const w = world()
    await fullRun(w)
    const [inv] = await rows(pair.control, 'select created_at from invitations')
    const [org] = await rows(pair.d1, 'select created_at from organizations')
    expect(inv!.created_at >= org!.created_at).toBe(true)
    expect(await rows(pair.control, "select action from control_audit where action = 'invitation.created'")).toHaveLength(1)
  })

  it('a new instance without --owner-email is refused before any step', async () => {
    const w = world()
    const o = await run(w, ['--env', 'acme', '--api-host', HOST])
    expect(o.exitCode).toBe(1)
    expect(w.logs.join('\n')).toContain('--owner-email')
    expect(w.argv).toEqual([])
  })

  it('a recorded instance with no owner and no live invitation is refused at the step when --owner-email is missing, and writes no invitation', async () => {
    const w = world()
    await fullRun(w)
    await pair.control.prepare('delete from invitations').run()
    w.logs.length = 0
    const o = await run(w, ['--env', 'acme', '--api-host', HOST])
    expect(step(o, 'bootstrap').status).toBe('fail')
    expect(step(o, 'bootstrap').detail).toContain('--owner-email')
    expect(await rows(pair.control, 'select * from invitations')).toEqual([])
  })

  it.each([
    ['none', { authProvider: 'none', authOrgId: 'acme', email: 'x@example.com', agentName: 'a' }],
    ['clerk', { authProvider: 'clerk', authOrgId: 'https://c.example.com' }],
  ])('a %s: marker is refused, whatever else is in the database', async (provider, link) => {
    await bootstrapD1(pair.d1, { organizationName: 'Acme', ...link })
    const w = world()
    await firstRun(w)
    w.logs.length = 0
    const o = await run(w)
    expect(step(o, 'bootstrap').status).toBe('fail')
    expect(step(o, 'bootstrap').detail).toContain(`marked ${provider}:`)
    expect(await rows(pair.control, 'select * from invitations')).toEqual([])
  })

  it('an operator agent on better-auth gets its key in the instance env file, never in the output', async () => {
    const w = world()
    const argv = [...ACME, '--operator-agent', 'operator', '--key-env', 'ACME_KEY']
    const o = await fullRun(w, argv)
    expect(o.exitCode, w.logs.join('\n')).toBe(0)
    expect(w.state.envText).toMatch(/^ACME_KEY=\S+$/m)
    const key = /^ACME_KEY=(\S+)$/m.exec(w.state.envText)![1]!
    expect(w.surface()).not.toContain(key)
    expect(await rows(pair.d1, 'select * from api_keys')).toHaveLength(1)
  })
})

describe('6. re-runs and the one-time link (D7)', () => {
  const invitationRows = () => rows(pair.control, 'select * from invitations')
  const auditRows = () => rows(pair.control, "select * from control_audit where action like 'invitation.%'")

  it('none: the run issues one invitation and prints its URL once, in the bootstrap step\'s lines', async () => {
    const w = world()
    const o = await fullRun(w)
    expect(urlLines(w.logs)).toHaveLength(1)
    expect(step(o, 'bootstrap').lines!.some((l) => l.includes(`${BASE}/invite#token=`))).toBe(true)
    expect(await invitationRows()).toHaveLength(1)
  })

  it('pending: a re-run issues nothing, writes no row and no audit row, names the email and the expiry, and prints no URL', async () => {
    const w = world()
    await fullRun(w)
    const token = tokenOf(w.logs)!
    const [before] = await invitationRows()
    const audits = (await auditRows()).length
    w.logs.length = 0
    const o = await run(w)
    expect(o.exitCode).toBe(0)
    const b = step(o, 'bootstrap')
    expect(b.status).toBe('ok')
    expect(b.detail).toContain(`owner invitation pending for ${OWNER} (expires ${before!.expires_at})`)
    expect(b.detail).toContain(`a new link: CONFIRM_REMOTE=1 pnpm -C packages/server-d1 bootstrap -- --remote --env acme --owner-reset --email ${OWNER}`)
    expect(await invitationRows()).toEqual([before])
    expect(await auditRows()).toHaveLength(audits)
    expect(urlLines(w.logs)).toEqual([])
    for (const text of [w.logs.join('\n'), w.surface(), w.state.configText, w.state.envFileText ?? '', w.state.envText]) expect(text).not.toContain(token)
  })

  it('owner exists: ok, nothing is issued, no row changes', async () => {
    const w = world()
    await fullRun(w)
    const [org] = await rows(pair.d1, 'select id from organizations')
    const user = '0190b2c4-0000-7000-8000-00000000c001'
    await seedPrincipal(pair.d1, { id: user, kind: 'user', email: OWNER })
    await seedMembership(pair.d1, { organizationId: org!.id, userId: user, role: 'owner' })
    const before = JSON.stringify({ i: await invitationRows(), a: await auditRows() })
    w.logs.length = 0
    const o = await run(w)
    expect(step(o, 'bootstrap').status).toBe('ok')
    expect(step(o, 'bootstrap').detail).toMatch(/owner/)
    expect(JSON.stringify({ i: await invitationRows(), a: await auditRows() })).toBe(before)
    expect(urlLines(w.logs)).toEqual([])
  })

  it('a first run that failed after the seed and before the invitation: the re-run issues one (state none on an initialised instance)', async () => {
    const w = world()
    await fullRun(w)
    await pair.control.prepare('delete from invitations').run()
    w.logs.length = 0
    const o = await run(w)
    expect(step(o, 'bootstrap').status).toBe('create')
    expect(await invitationRows()).toHaveLength(1)
    expect(urlLines(w.logs)).toHaveLength(1)
  })

  describe('dry runs', () => {
    it('none: reports it would issue, issues nothing, prints no URL', async () => {
      const w = world()
      await fullRun(w)
      await pair.control.prepare('delete from invitations').run()
      const audits = (await auditRows()).length
      w.logs.length = 0
      const o = await dry(w)
      expect(step(o, 'bootstrap').status).toBe('create')
      expect(step(o, 'bootstrap').detail).toMatch(/would issue an owner invitation for owner@example.com/)
      expect(await invitationRows()).toEqual([])
      expect(await auditRows()).toHaveLength(audits)
      expect(urlLines(w.logs)).toEqual([])
    })
    it('pending: reports the pending invitation and issues nothing', async () => {
      const w = world()
      await fullRun(w)
      const rowsBefore = await invitationRows()
      w.logs.length = 0
      const o = await dry(w)
      expect(step(o, 'bootstrap').detail).toContain(`owner invitation pending for ${OWNER}`)
      expect(step(o, 'bootstrap').detail).toContain(`a new link: CONFIRM_REMOTE=1 pnpm -C packages/server-d1 bootstrap -- --remote --env acme --owner-reset --email ${OWNER}`)
      expect(await invitationRows()).toEqual(rowsBefore)
    })
    it('owner exists: reports it and issues nothing', async () => {
      const w = world()
      await fullRun(w)
      const [org] = await rows(pair.d1, 'select id from organizations')
      const user = '0190b2c4-0000-7000-8000-00000000c002'
      await seedPrincipal(pair.d1, { id: user, kind: 'user', email: OWNER })
      await seedMembership(pair.d1, { organizationId: org!.id, userId: user, role: 'owner' })
      const rowsBefore = await invitationRows()
      w.logs.length = 0
      const o = await dry(w)
      expect(step(o, 'bootstrap').status).toBe('ok')
      expect(await invitationRows()).toEqual(rowsBefore)
    })
  })
})

// Test support for `vibase-server setup` ([[OPS232]]): a simulated Cloudflare account behind the instance kit's fake wrangler runner and fake
// fetch, and a real local D1 behind the bootstrap step. The runner records every call (the kit does); here it also answers the way wrangler's
// output looks, and a write changes the state the next read sees. Nothing reaches a network, an account or the repo's wrangler.
import { existsSync, readFileSync } from 'node:fs'
import type { WorkerD1 } from '../../src/test/kit.js'
import { memoryControl } from '../setup/test/world.js'
import { ISSUER, PK_TEST, SK_TEST, type FakeClerk } from '../setup/test/clerk-world.js'
import { CONTROL_ALL, makeWorld, NO_TRACKER_JSON, SECRETS_TEXT, trackerJson, type World, type WorldOptions } from './test-kit.js'
import type { OpenD1Options, RunResult } from './types.js'

export const ALL_MIGRATIONS = ['0001_a.sql', '0002_b.sql']
export const API_HOST = 'api.demo.invalid'
export const NONE_ARGS = ['--env', 'demo', '--api-host', API_HOST, '--auth', 'none']
export const CLERK_ARGS = ['--env', 'demo', '--api-host', API_HOST, '--owner-email', 'owner@example.com', '--web-origin', 'https://app.demo.invalid']
export const GMAIL_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString('base64')
export const GOOGLE_CLIENT_SECRET = 'gsecret-CANARY-0123456789'
export const OAUTH_STATE_SECRET = 'oauth-state-CANARY-0123456789'
/** A secrets file for `--auth clerk` with the Gmail group: the canary values must never leave the secrets file except as `secret bulk` stdin. */
export const CLERK_SECRETS_TEXT = `${SECRETS_TEXT}CLERK_SECRET_KEY=${SK_TEST}\nCLERK_PUBLISHABLE_KEY=${PK_TEST}\nGOOGLE_CLIENT_ID=gid-123.apps.googleusercontent.com\nGOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}\nOAUTH_STATE_SECRET=${OAUTH_STATE_SECRET}\nCREDENTIALS_KEY=${GMAIL_CREDENTIALS_KEY}\n`
export const CLERK_SECRET_VALUES = [SK_TEST, GOOGLE_CLIENT_SECRET, OAUTH_STATE_SECRET, GMAIL_CREDENTIALS_KEY]

export interface Marker {
  organization_id: string
  auth_provider: string
  auth_org_id: string
  organizations: number
}
export interface Sim {
  d1s: { uuid: string; name: string }[]
  r2s: string[]
  /** `null`: no d1_migrations table. */
  applied: string[] | null
  /** The control database's tracker (OPS279); `null`: no table. */
  controlApplied: string[] | null
  failControlApply?: boolean
  /** What `/health` shows; `null`: it does not answer. */
  deployed: { version: string; commit: string | null } | null
  marker: Marker | null
  /** Secret names on the Worker and the last `secret bulk` payload. */
  secrets: string[]
  bulk: Record<string, string>[]
  failDeploy?: boolean
  failApply?: boolean
  /** A deploy succeeds but `/health` keeps showing what it showed. */
  deployNoop?: boolean
  /** The runner's answer to `secret list` is a failure. */
  clerk?: FakeClerk
  zones: string[]
  denyAll?: boolean
  /** Every bootstrap `openD1` call, with the generated config as it was on disk at that moment. */
  opened: { opts: OpenD1Options; configText: string | null }[]
}

export interface SetupWorld {
  w: World
  sim: Sim
  d1: WorkerD1
  /** The marker-only control database behind `CONTROL_DB`. */
  control: ReturnType<typeof memoryControl>
  /** The settings file's text, or `null`. */
  settings(): string | null
  /** The commands that change something remote, by their wrangler argv. */
  writes(): string[][]
  rows(): { status: string; step: string; detail: string }[]
}

export const isWrite = (args: string[]): boolean => {
  const j = ` ${args.join(' ')} `
  return j.includes(' d1 create ') || j.includes(' r2 bucket create ') || j.includes(' d1 migrations apply ') || args[0] === 'deploy' || j.includes(' secret bulk ')
}

const stripConfig = (args: string[]): string[] => {
  const i = args.indexOf('-c')
  return i < 0 ? args : [...args.slice(0, i), ...args.slice(i + 2)]
}

const markerSql = 'select organization_id, auth_provider, auth_org_id, (select count(*) from organizations) as organizations from deployment where singleton = 1'
export async function readMarker(d1: WorkerD1['d1']): Promise<Marker | null> {
  const row = await d1.prepare(markerSql).first().catch(() => null)
  return row ? (row as unknown as Marker) : null
}

export interface SetupWorldOptions extends Omit<WorldOptions, 'runner' | 'fetch' | 'openD1'> {
  sim?: Partial<Sim>
  d1: WorkerD1
  /** Runs before the control marker is stored (OPS279), to look at the CRM database at that moment. */
  onControlInsert?: (organizationId: string) => Promise<void>
  /** Overrides the runner for some calls: return a result to answer, `undefined` to fall through to the simulation. */
  intercept?: (args: string[], env: Record<string, string>, input?: string) => RunResult | undefined
  /** Overrides a fetch answer; `undefined` falls through. */
  interceptFetch?: (url: string, init?: RequestInit) => Response | undefined
}

export function setupWorld(o: SetupWorldOptions): SetupWorld {
  const sim: Sim = { d1s: [], r2s: [], applied: null, controlApplied: null, deployed: null, marker: null, secrets: [], bulk: [], zones: ['demo.invalid'], opened: [], ...o.sim }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const control = memoryControl(o.onControlInsert)
  const ok = (stdout: string): RunResult => ({ status: 0, stdout, stderr: '' })
  const health = (): Response => {
    if (sim.deployed === null) return new Response('', { status: 522 })
    const status = sim.applied === null ? 'unknown' : ALL_MIGRATIONS.every((n) => sim.applied!.includes(n)) ? 'current' : 'behind'
    return json(200, { status: 'ok', version: sim.deployed.version, ...(sim.deployed.commit ? { commit: sim.deployed.commit } : {}), initialised: sim.marker !== null, migrations: { status } })
  }
  const world = makeWorld({
    settings: null,
    ...o,
    processEnv: { CONFIRM_REMOTE: '1', ...o.processEnv },
    fetch: (url, init) => {
      const over = o.interceptFetch?.(url, init)
      if (over) return over
      if (sim.clerk?.handles(url)) return sim.clerk.handle(url, init)
      if (url.startsWith('https://api.cloudflare.com/client/v4/')) {
        if (sim.denyAll) return json(403, { success: false })
        const path = url.slice('https://api.cloudflare.com/client/v4/'.length)
        if (path.startsWith('zones')) return json(200, { success: true, result: sim.zones.map((name, i) => ({ id: `z${i}`, name })) })
        return json(200, { success: true, result: [] })
      }
      if (url.endsWith('/health')) return health()
      if (url.endsWith('/.well-known/vibase')) return json(200, { auth: sim.clerk ? { provider: 'clerk', issuer: ISSUER, cli_client_id: sim.clerk.state.apps[0]?.client_id ?? null } : null })
      return json(404, {})
    },
    runner: (args, env, input) => {
      const over = o.intercept?.(args, env, input)
      if (over) return over
      const a = stripConfig(args)
      const has = (...w: string[]) => w.every((x) => a.includes(x))
      if (has('d1', 'list')) return ok(JSON.stringify(sim.d1s.map((d) => ({ uuid: d.uuid, name: d.name, created_at: '2026-01-01', version: 'production', num_tables: 0, file_size: 0 }))))
      if (has('d1', 'create')) {
        const name = a[a.indexOf('create') + 1]!
        sim.d1s.push({ uuid: `00000000-1111-4222-8333-${String(sim.d1s.length + 1).padStart(12, '0')}`, name })
        return ok(`Successfully created DB '${name}'\n`)
      }
      if (has('r2', 'bucket', 'list')) return ok(sim.r2s.map((n) => `name:           ${n}\ncreation_date:  2026-01-01T00:00:00.000Z\n`).join('\n'))
      if (has('r2', 'bucket', 'create')) {
        sim.r2s.push(a[a.indexOf('create') + 1]!)
        return ok('Created bucket\n')
      }
      if (has('d1', 'execute')) {
        const sql = a[a.indexOf('--command') + 1] ?? ''
        if (a[a.indexOf('execute') + 1] === 'CONTROL_DB') {
          if (/d1_migrations/.test(sql)) return sim.controlApplied === null ? { status: 1, stdout: NO_TRACKER_JSON, stderr: '' } : ok(trackerJson(sim.controlApplied))
          if (/from control_deployment/.test(sql)) {
            if (sim.controlApplied === null) return { status: 1, stdout: JSON.stringify({ error: { text: 'no such table: control_deployment' } }), stderr: '' }
            const org = control.marker()
            return ok(JSON.stringify([{ results: org ? [{ organization_id: org }] : [], success: true }]))
          }
        }
        if (/d1_migrations/.test(sql)) return sim.applied === null ? { status: 1, stdout: NO_TRACKER_JSON, stderr: '' } : ok(trackerJson(sim.applied))
        if (/from deployment/.test(sql)) {
          if (sim.applied === null) return { status: 1, stdout: JSON.stringify({ error: { text: 'no such table: deployment' } }), stderr: '' }
          return ok(JSON.stringify([{ results: sim.marker ? [sim.marker] : [], success: true }]))
        }
      }
      if (has('d1', 'migrations', 'apply') && a[a.indexOf('apply') + 1] === 'CONTROL_DB') {
        if (sim.failControlApply) return { status: 1, stdout: '', stderr: 'control apply blew up' }
        sim.controlApplied = [...CONTROL_ALL]
        return ok('applied\n')
      }
      if (has('d1', 'migrations', 'apply')) {
        if (sim.failApply) return { status: 1, stdout: '', stderr: 'apply blew up' }
        sim.applied = [...ALL_MIGRATIONS]
        return ok('applied\n')
      }
      if (a[0] === 'deploy') {
        if (sim.failDeploy) return { status: 1, stdout: '', stderr: `deploy blew up ${JSON.stringify(env)}` }
        const v = a.find((x) => x.startsWith('VERSION:'))
        const c = a.find((x) => x.startsWith('COMMIT:'))
        if (!sim.deployNoop) sim.deployed = { version: v!.slice('VERSION:'.length), commit: c!.slice('COMMIT:'.length) }
        return ok('deployed\n')
      }
      if (has('secret', 'list')) return sim.deployed === null ? { status: 1, stdout: '', stderr: 'no such worker' } : ok(JSON.stringify(sim.secrets.map((name) => ({ name, type: 'secret_text' }))))
      if (has('secret', 'bulk')) {
        const values = JSON.parse(input ?? '{}') as Record<string, string>
        sim.bulk.push(values)
        for (const n of Object.keys(values)) if (!sim.secrets.includes(n)) sim.secrets.push(n)
        return ok('Success! Uploaded secrets\n')
      }
      return { status: 1, stdout: '', stderr: `unexpected wrangler call ${args.join(' ')}` }
    },
    openD1: async (opts: OpenD1Options) => {
      sim.opened.push({ opts, configText: existsSync(opts.configPath) ? readFileSync(opts.configPath, 'utf8') : null })
      return { d1: o.d1.d1, control, dispose: async () => void (sim.marker = await readMarker(o.d1.d1)) }
    },
  })
  const rows = () =>
    world.out.flatMap((l) => {
      const m = /^(ok|create|update|manual|fail|blocked)\s+(\S+)\s*(.*)$/.exec(l)
      return m ? [{ status: m[1]!, step: m[2]!, detail: m[3]! }] : []
    })
  return {
    w: world,
    sim,
    d1: o.d1,
    control,
    settings: () => {
      try {
        return readFileSync(world.settingsPath, 'utf8')
      } catch {
        return null
      }
    },
    writes: () => world.wrangler.map((c) => stripConfig(c.args)).filter(isWrite),
    rows,
  }
}

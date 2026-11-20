// Test support for `vibase-server setup` ([[OPS232]]): a simulated Cloudflare account behind the instance kit's fake wrangler runner and fake
// fetch, and a real local D1 behind the bootstrap step. The runner records every call (the kit does); here it also answers the way wrangler's
// output looks, and a write changes the state the next read sees. Nothing reaches a network, an account or the repo's wrangler.
import { existsSync, readFileSync } from 'node:fs'
import type { D1Like } from '@vibase/storage-d1'
import type { WorkerD1 } from '../../src/test/kit.js'
import { OWNERS_SQL, OWNER_INVITATIONS_SQL } from '../setup/commands.js'
import { memoryControl } from '../setup/test/world.js'
import { scriptedAnswer, type BetterAuthScript } from '../setup/test/better-auth-answers.js'
import { subdomainResponse, type SubdomainState } from '../setup/test/subdomain-answers.js'
import { ISSUER, PK_TEST, SK_TEST, type FakeClerk } from '../setup/test/clerk-world.js'
import {
  CONTROL_ALL,
  makeWorld,
  NO_TRACKER_JSON,
  SECRETS_TEXT,
  trackerJson,
  type World,
  type WorldOptions,
} from './test-kit.js'
import type { OpenD1Options, RunResult } from './types.js'

export const ALL_MIGRATIONS = ['0001_a.sql', '0002_b.sql']
export const API_HOST = 'api.demo.invalid'
export const NONE_ARGS = ['--env', 'demo', '--api-host', API_HOST, '--auth', 'none']
export const CLERK_ARGS = [
  '--env',
  'demo',
  '--auth',
  'clerk',
  '--api-host',
  API_HOST,
  '--owner-email',
  'owner@example.com',
  '--web-origin',
  'https://app.demo.invalid',
]
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
  /** `secret bulk` fails (exit 1) and puts nothing (OPS249 D3: the partial state after the secrets file was written). */
  failBulk?: boolean
  /** Mirrors of the real databases the synchronous fake wrangler answers owner-state reads from (refreshed by `sync()` and at the end of a bootstrap): live owner memberships, live owner invitations, the control marker. */
  owners: number
  ownerInvitations: { email: string; expires_at: string }[]
  controlOrg: string | null
  /** The secrets file's text at the moment of each `secret bulk` (OPS249 D3: the file is written before the put); `null` when it did not exist. */
  bulkFile: (string | null)[]
  /** A deploy succeeds but `/health` keeps showing what it showed. */
  deployNoop?: boolean
  /** The runner's answer to `secret list` is a failure. */
  clerk?: FakeClerk
  /** `better-auth`: scripted answers for discovery and the RFC 8414 metadata (OPS306); default: the Worker's correct answers. */
  ba?: BetterAuthScript
  zones: string[]
  /** The account's `workers.dev` subdomain (OPS308); `null`: none registered. */
  subdomain: SubdomainState
  denyAll?: boolean
  /** Every bootstrap `openD1` call, with the generated config as it was on disk at that moment. */
  opened: { opts: OpenD1Options; configText: string | null }[]
}

export interface SetupWorld {
  w: World
  sim: Sim
  d1: WorkerD1
  /** The control database behind `CONTROL_DB`: the marker-only memory one, or the real one given as `control`. */
  control: ReturnType<typeof memoryControl>
  /** The settings file's text, or `null`. */
  settings(): string | null
  /** The commands that change something remote, by their wrangler argv. */
  writes(): string[][]
  /** Refreshes the owner-state mirrors from the real databases (after a test seeds a membership or an invitation). */
  sync(): Promise<void>
  rows(): { status: string; step: string; detail: string }[]
}

export const isWrite = (args: string[]): boolean => {
  const j = ` ${args.join(' ')} `
  return (
    j.includes(' d1 create ') ||
    j.includes(' r2 bucket create ') ||
    j.includes(' d1 migrations apply ') ||
    args[0] === 'deploy' ||
    j.includes(' secret bulk ')
  )
}

const stripConfig = (args: string[]): string[] => {
  const i = args.indexOf('-c')
  return i < 0 ? args : [...args.slice(0, i), ...args.slice(i + 2)]
}

const markerSql =
  'select organization_id, auth_provider, auth_org_id, (select count(*) from organizations) as organizations from deployment where singleton = 1'
export async function readMarker(d1: WorkerD1['d1']): Promise<Marker | null> {
  const row = await d1
    .prepare(markerSql)
    .first()
    .catch(() => null)
  return row ? (row as unknown as Marker) : null
}

export interface SetupWorldOptions extends Omit<WorldOptions, 'runner' | 'fetch' | 'openD1'> {
  sim?: Partial<Sim>
  d1: WorkerD1
  /** A real, migrated control database (OPS249): bootstrap's `better-auth` path seeds the client and writes invitations in it. Default: a marker-only memory database. */
  control?: D1Like
  /** Runs before the control marker is stored (OPS279), to look at the CRM database at that moment. */
  onControlInsert?: (organizationId: string) => Promise<void>
  /** The organisation the control marker already names (an instance paired before this run). */
  controlMarker?: string
  /** Overrides the runner for some calls: return a result to answer, `undefined` to fall through to the simulation. */
  intercept?: (args: string[], env: Record<string, string>, input?: string) => RunResult | undefined
  /** Overrides a fetch answer; `undefined` falls through. */
  interceptFetch?: (url: string, init?: RequestInit) => Response | undefined
}

export function setupWorld(o: SetupWorldOptions): SetupWorld {
  const sim: Sim = {
    d1s: [],
    r2s: [],
    applied: null,
    controlApplied: null,
    deployed: null,
    marker: null,
    secrets: [],
    bulk: [],
    zones: ['demo.invalid'],
    subdomain: { subdomain: 'team', puts: [] },
    opened: [],
    bulkFile: [],
    owners: 0,
    ownerInvitations: [],
    controlOrg: null,
    ...o.sim,
  }
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const control = (o.control ?? memoryControl(o.onControlInsert, o.controlMarker)) as ReturnType<typeof memoryControl>
  const ok = (stdout: string): RunResult => ({ status: 0, stdout, stderr: '' })
  const baCounters = { vibase: 0, metadata: 0 }
  const health = (): Response => {
    if (sim.deployed === null) return new Response('', { status: 522 })
    const status =
      sim.applied === null ? 'unknown' : ALL_MIGRATIONS.every((n) => sim.applied!.includes(n)) ? 'current' : 'behind'
    return json(200, {
      status: 'ok',
      version: sim.deployed.version,
      ...(sim.deployed.commit ? { commit: sim.deployed.commit } : {}),
      initialised: sim.marker !== null,
      migrations: { status },
    })
  }
  const world = makeWorld({
    settings: null,
    ...o,
    processEnv: { ...o.processEnv },
    fetch: (url, init) => {
      const over = o.interceptFetch?.(url, init)
      if (over) return over
      if (sim.clerk?.handles(url)) return sim.clerk.handle(url, init)
      if (url.startsWith('https://api.cloudflare.com/client/v4/')) {
        if (sim.denyAll) return json(403, { success: false })
        const path = url.slice('https://api.cloudflare.com/client/v4/'.length)
        const sub = subdomainResponse(path, init, sim.subdomain)
        if (sub) return sub
        if (path.startsWith('zones'))
          return json(200, { success: true, result: sim.zones.map((name, i) => ({ id: `z${i}`, name })) })
        return json(200, { success: true, result: [] })
      }
      if (url.endsWith('/health')) return health()
      const scripted = scriptedAnswer(url, sim.ba ?? {}, baCounters)
      if (
        scripted &&
        (sim.ba !== undefined ||
          /"AUTH_PROVIDER":\s*"better-auth"/.test(
            existsSync(world.settingsPath) ? readFileSync(world.settingsPath, 'utf8') : '',
          ))
      )
        return scripted
      if (url.endsWith('/.well-known/vibase'))
        return json(200, {
          auth: sim.clerk
            ? { provider: 'clerk', issuer: ISSUER, cli_client_id: sim.clerk.state.apps[0]?.client_id ?? null }
            : null,
        })
      return json(404, {})
    },
    runner: (args, env, input) => {
      const over = o.intercept?.(args, env, input)
      if (over) return over
      const a = stripConfig(args)
      const has = (...w: string[]) => w.every((x) => a.includes(x))
      if (has('d1', 'list'))
        return ok(
          JSON.stringify(
            sim.d1s.map((d) => ({
              uuid: d.uuid,
              name: d.name,
              created_at: '2026-01-01',
              version: 'production',
              num_tables: 0,
              file_size: 0,
            })),
          ),
        )
      if (has('d1', 'create')) {
        const name = a[a.indexOf('create') + 1]!
        sim.d1s.push({ uuid: `00000000-1111-4222-8333-${String(sim.d1s.length + 1).padStart(12, '0')}`, name })
        return ok(`Successfully created DB '${name}'\n`)
      }
      if (has('r2', 'bucket', 'list'))
        return ok(sim.r2s.map((n) => `name:           ${n}\ncreation_date:  2026-01-01T00:00:00.000Z\n`).join('\n'))
      if (has('r2', 'bucket', 'create')) {
        sim.r2s.push(a[a.indexOf('create') + 1]!)
        return ok('Created bucket\n')
      }
      if (has('d1', 'execute')) {
        const sql = a[a.indexOf('--command') + 1] ?? ''
        if (a[a.indexOf('execute') + 1] === 'CONTROL_DB') {
          if (/d1_migrations/.test(sql))
            return sim.controlApplied === null
              ? { status: 1, stdout: NO_TRACKER_JSON, stderr: '' }
              : ok(trackerJson(sim.controlApplied))
          if (/from control_deployment/.test(sql)) {
            if (sim.controlApplied === null)
              return {
                status: 1,
                stdout: JSON.stringify({ error: { text: 'no such table: control_deployment' } }),
                stderr: '',
              }
            const org = o.control ? sim.controlOrg : control.marker()
            return ok(JSON.stringify([{ results: org ? [{ organization_id: org }] : [], success: true }]))
          }
          // OPS249 D7: the owner state, as the last `sync()` (or the end of a bootstrap) saw it in the real databases.
          if (/from invitations/.test(sql))
            return ok(JSON.stringify([{ results: sim.ownerInvitations, success: true }]))
        }
        if (/from memberships/.test(sql))
          return ok(JSON.stringify([{ results: [{ owners: sim.owners }], success: true }]))
        if (/d1_migrations/.test(sql))
          return sim.applied === null
            ? { status: 1, stdout: NO_TRACKER_JSON, stderr: '' }
            : ok(trackerJson(sim.applied))
        if (/from deployment/.test(sql)) {
          if (sim.applied === null)
            return { status: 1, stdout: JSON.stringify({ error: { text: 'no such table: deployment' } }), stderr: '' }
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
      if (has('secret', 'list'))
        return sim.deployed === null
          ? { status: 1, stdout: '', stderr: 'no such worker' }
          : ok(JSON.stringify(sim.secrets.map((name) => ({ name, type: 'secret_text' }))))
      if (has('secret', 'bulk')) {
        sim.bulkFile.push(existsSync(world.secretsPath) ? readFileSync(world.secretsPath, 'utf8') : null)
        if (sim.failBulk) return { status: 1, stdout: '', stderr: 'bulk blew up' }
        const values = JSON.parse(input ?? '{}') as Record<string, string>
        sim.bulk.push(values)
        for (const n of Object.keys(values)) if (!sim.secrets.includes(n)) sim.secrets.push(n)
        return ok('Success! Uploaded secrets\n')
      }
      return { status: 1, stdout: '', stderr: `unexpected wrangler call ${args.join(' ')}` }
    },
    openD1: async (opts: OpenD1Options) => {
      sim.opened.push({ opts, configText: existsSync(opts.configPath) ? readFileSync(opts.configPath, 'utf8') : null })
      return {
        d1: o.d1.d1,
        control,
        dispose: async () => {
          sim.marker = await readMarker(o.d1.d1)
          if (o.control) await sync()
        },
      }
    },
  })
  const sync = async (): Promise<void> => {
    if (!o.control) return
    const owners = (await o.d1.d1
      .prepare(OWNERS_SQL)
      .first()
      .catch(() => null)) as { owners: number } | null
    sim.owners = owners?.owners ?? 0
    sim.ownerInvitations = ((await o.control.prepare(OWNER_INVITATIONS_SQL).all()).results ?? []) as {
      email: string
      expires_at: string
    }[]
    sim.controlOrg =
      (
        (await o.control
          .prepare('select organization_id from control_deployment where singleton = 1')
          .first()
          .catch(() => null)) as { organization_id: string } | null
      )?.organization_id ?? null
  }
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
    sync,
    writes: () => world.wrangler.map((c) => stripConfig(c.args)).filter(isWrite),
    rows,
  }
}

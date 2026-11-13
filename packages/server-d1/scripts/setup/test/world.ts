// A fake world for `setup:remote` tests ([[OPS65]] Tests): an injected command runner standing in for wrangler and git (recorded argv,
// canned output shaped like wrangler's), an injected fetch standing in for Cloudflare's API and the Worker's /health, a text copy of
// wrangler.jsonc, and the in-memory D1 behind the marker. Writes by a run change the state the next run reads.
import { readFileSync } from 'node:fs'
import { parse } from 'jsonc-parser'
import { CONTROL_MIGRATIONS, MIGRATIONS, type D1Like, type D1PreparedLike } from '@vibase/storage-d1'
import type { Credentials, EnvFileProbe, ExecResult, SetupCmd, SetupDeps } from '../types.js'
import { PK_TEST, SK_TEST, type FakeClerk } from './clerk-world.js'

export const FIXTURE_CONFIG_PATH = new URL('./wrangler.fixture.jsonc', import.meta.url)
export const EXPECTED_MIGRATIONS = MIGRATIONS.map((m) => m.name)
export const CONTROL_EXPECTED = CONTROL_MIGRATIONS.map((m) => m.name)
export const SHA = 'a'.repeat(40)
export const OLD_SHA = 'b'.repeat(40)
/** Canary values: they stand for `.env` contents and must never reach an argv, a log line or the config. */
export const CREDS: Credentials = { accountId: 'acct-canary-0001', apiToken: 'cf-token-canary-9f8e7d' }
export const OPERATOR_KEY_PREFIX = 'vk_'

const WRITE_VERBS = [
  ['d1', 'create'],
  ['r2', 'bucket', 'create'],
  ['d1', 'migrations', 'apply'],
  ['deploy'],
  ['secret', 'bulk'],
]
/** True for a command that creates, applies or deploys (the writes a dry run must never issue). */
export function isWriteCommand(argv: readonly string[]): boolean {
  const joined = ` ${argv.join(' ')} `
  return WRITE_VERBS.some((v) => joined.includes(` ${v.join(' ')} `)) && !joined.includes(' git ')
}

/**
 * A control database that holds only the marker (OPS279): enough for `control-store`'s two statements. `onInsert` runs before the row is stored,
 * so a test can look at the CRM database at the moment the control marker is written.
 */
export function memoryControl(onInsert?: (organizationId: string) => Promise<void>): D1Like & { inserts: string[]; marker(): string | null } {
  let org: string | null = null
  const inserts: string[] = []
  const prep = (q: string, args: unknown[] = []): D1PreparedLike => ({
    bind: (...v: unknown[]) => prep(q, v),
    run: async () => {
      if (/insert into control_deployment/.test(q)) {
        await onInsert?.(args[0] as string)
        inserts.push(args[0] as string)
        org ??= args[0] as string
      }
      return { success: true }
    },
    all: async () => ({ success: true, results: org ? [{ organization_id: org }] : [] }),
    first: async () => (org ? { organization_id: org } : null),
  })
  return { prepare: (q: string) => prep(q), batch: async (s: D1PreparedLike[]) => Promise.all(s.map((x) => x.run())), inserts, marker: () => org }
}

export interface WorldOptions {
  configText?: string
  d1: D1Like
  /** The control database behind `CONTROL_DB` (OPS279); default: a marker-only memory database. */
  control?: D1Like
  /** The control database's applied migrations; `null`: no tracker table. */
  appliedControl?: string[] | null
  failControlApply?: boolean
  d1s?: { uuid: string; name: string }[]
  r2s?: string[]
  /** `null`: no d1_migrations table. */
  applied?: string[] | null
  deployedSha?: string | null
  headSha?: string
  dirty?: boolean
  /** Cloudflare API probes answered with 403, by path fragment (`d1`, `r2`, `workers`, `zones`). */
  denied?: string[]
  zones?: string[]
  envText?: string
  /** When set, `/health` never reports current migrations. */
  healthNeverCurrent?: boolean
  /** `--auth clerk`: the fake Clerk behind api.clerk.com and the issuer host. */
  clerk?: FakeClerk
  /** The Clerk env file's text; `null`: no such file. Default: a development pair. */
  clerkEnvText?: string | null
  clerkFileStatus?: 'ok' | 'root-env' | 'not-ignored'
  /** Secret names already on the Worker. */
  secrets?: string[]
  /** What the Worker's `/.well-known/vibase` reports (`auth.issuer`, `auth.cli_client_id`); default: matches `state.configText`'s vars. */
  vibase?: { issuer: string | null; cli_client_id: string | null } | 'absent'
}

export interface World {
  deps: SetupDeps
  argv: string[][]
  inputs: string[]
  /** Stdin of `wrangler secret bulk`: the only place a secret may travel. */
  secretInputs: string[]
  probes: { arg: string | undefined; envName: string }[]
  fetched: string[]
  logs: string[]
  state: { configText: string; envText: string; configWrites: number; d1s: { uuid: string; name: string }[]; r2s: string[]; applied: string[] | null; appliedControl: string[] | null; deployedSha: string | null; sleeps: number[]; secrets: Record<string, string> }
  writes(): string[][]
  /** The control database behind `CONTROL_DB`. */
  control: D1Like
  /** Every string that reached argv, stdin or a log line (fetched URLs carry the account id as an API path and are checked apart). */
  surface(): string
}

export function makeWorld(o: WorldOptions): World {
  const state = {
    configText: o.configText ?? readFileSync(FIXTURE_CONFIG_PATH, 'utf8'),
    envText: o.envText ?? '',
    configWrites: 0,
    d1s: [...(o.d1s ?? [])],
    r2s: [...(o.r2s ?? [])],
    applied: o.applied === undefined ? null : o.applied,
    appliedControl: o.appliedControl === undefined ? null : o.appliedControl,
    deployedSha: o.deployedSha === undefined ? null : o.deployedSha,
    sleeps: [] as number[],
    secrets: Object.fromEntries((o.secrets ?? []).map((n) => [n, 'present'])) as Record<string, string>,
  }
  const argv: string[][] = []
  const inputs: string[] = []
  const secretInputs: string[] = []
  const probes: { arg: string | undefined; envName: string }[] = []
  const fetched: string[] = []
  const logs: string[] = []
  let clock = 1_000_000
  const head = o.headSha ?? SHA
  const control = o.control ?? memoryControl()

  const json = (v: unknown): ExecResult => ({ status: 0, stdout: JSON.stringify(v), stderr: '' })
  const text = (s: string): ExecResult => ({ status: 0, stdout: s, stderr: '' })

  async function exec(cmd: SetupCmd): Promise<ExecResult> {
    argv.push([cmd.command, ...cmd.args])
    if (cmd.input !== undefined) (cmd.args.includes('secret') && cmd.args.includes('bulk') ? secretInputs : inputs).push(cmd.input)
    const a = cmd.args
    const has = (...w: string[]) => w.every((x) => a.includes(x))
    if (cmd.command === 'git') {
      if (has('rev-parse')) return text(`${head}\n`)
      if (has('status')) return text(o.dirty ? ' M packages/server-d1/wrangler.jsonc\n' : '')
    }
    if (has('secret', 'list')) return json(Object.keys(state.secrets).map((name) => ({ name, type: 'secret_text' })))
    if (has('secret', 'bulk')) {
      Object.assign(state.secrets, JSON.parse(cmd.input ?? '{}'))
      return text('Success! Uploaded secrets\n')
    }
    if (has('d1', 'list')) return json(state.d1s.map((d) => ({ uuid: d.uuid, name: d.name, created_at: '2026-01-01', version: 'production', num_tables: 0, file_size: 0 })))
    if (has('d1', 'create')) {
      const name = a[a.indexOf('create') + 1]!
      state.d1s.push({ uuid: `00000000-1111-4222-8333-${String(state.d1s.length + 1).padStart(12, '0')}`, name })
      return text(`Successfully created DB '${name}'\n`)
    }
    if (has('r2', 'bucket', 'list')) return text(state.r2s.map((n) => `name:           ${n}\ncreation_date:  2026-01-01T00:00:00.000Z\n`).join('\n'))
    if (has('r2', 'bucket', 'create')) {
      state.r2s.push(a[a.indexOf('create') + 1]!)
      return text('Created bucket\n')
    }
    if (has('d1', 'execute')) {
      const sql = a[a.indexOf('--command') + 1] ?? ''
      if (a[a.indexOf('execute') + 1] === 'CONTROL_DB') {
        if (/d1_migrations/.test(sql)) {
          if (state.appliedControl === null) return { status: 1, stdout: JSON.stringify({ error: { text: 'no such table: d1_migrations' } }), stderr: '' }
          return json([{ results: state.appliedControl.map((name) => ({ name })), success: true }])
        }
        if (/from control_deployment/.test(sql)) {
          if (state.appliedControl === null) return { status: 1, stdout: JSON.stringify({ error: { text: 'no such table: control_deployment' } }), stderr: '' }
          const row = await control.prepare(sql).first()
          return json([{ results: row ? [row] : [], success: true }])
        }
      }
      if (/d1_migrations/.test(sql)) {
        if (state.applied === null) return { status: 1, stdout: JSON.stringify({ error: { text: 'no such table: d1_migrations' } }), stderr: '' }
        return json([{ results: state.applied.map((name) => ({ name })), success: true }])
      }
      if (/from deployment/.test(sql)) {
        if (state.applied === null) return { status: 1, stdout: JSON.stringify({ error: { text: 'no such table: deployment' } }), stderr: '' }
        const row = await o.d1.prepare(sql).first()
        return json([{ results: row ? [row] : [], success: true }])
      }
    }
    if (has('d1', 'migrations', 'list')) return text('migrations list\n')
    if (has('d1', 'migrations', 'apply')) {
      if (a[a.indexOf('apply') + 1] === 'CONTROL_DB') {
        if (o.failControlApply) return { status: 1, stdout: '', stderr: 'control apply blew up' }
        state.appliedControl = [...CONTROL_EXPECTED]
        return text('applied\n')
      }
      state.applied = [...EXPECTED_MIGRATIONS]
      return text('applied\n')
    }
    if (a.includes('typecheck') || (a.includes('test') && a.includes('-C')) || (a.includes('build') && a.includes('-C'))) return text('ok\n')
    if (a.includes('deploy')) {
      const v = a.find((x) => x.startsWith('VERSION:'))
      state.deployedSha = v ? v.slice('VERSION:'.length) : OLD_SHA
      return text('deployed\n')
    }
    return { status: 1, stdout: '', stderr: `unexpected command: ${cmd.command} ${a.join(' ')}` }
  }

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    fetched.push(url)
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (o.clerk?.handles(url)) return o.clerk.handle(url, init)
    if (url.startsWith('https://api.cloudflare.com/client/v4/')) {
      const path = url.slice('https://api.cloudflare.com/client/v4/'.length)
      const kind = path.startsWith('zones') ? 'zones' : path.includes('/d1/') ? 'd1' : path.includes('/r2/') ? 'r2' : path.includes('/workers/') ? 'workers' : 'other'
      if ((o.denied ?? []).includes(kind)) return reply(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] })
      if (kind === 'zones') return reply(200, { success: true, result: (o.zones ?? ['vibase.ai']).map((name, i) => ({ id: `z${i}`, name })) })
      if (kind === 'r2') return reply(200, { success: true, result: { buckets: [] } })
      return reply(200, { success: true, result: [] })
    }
    if (url.endsWith('/health')) {
      if (state.deployedSha === null) return new Response('', { status: 522 })
      const initialised = (await o.d1.prepare('select 1 as x from deployment').first().catch(() => null)) !== null
      return reply(200, { status: 'ok', version: state.deployedSha, initialised, migrations: { status: o.healthNeverCurrent ? 'behind' : state.applied && EXPECTED_MIGRATIONS.every((n) => state.applied!.includes(n)) ? 'current' : 'behind' } })
    }
    if (url.endsWith('/.well-known/vibase')) {
      if (o.vibase === 'absent') return reply(404, {})
      const vars = (parse(state.configText) as { env?: Record<string, { vars?: Record<string, string> }> }).env?.[new URL(url).hostname.split('.')[1] ?? '']?.vars
      const v = o.vibase ?? { issuer: vars?.CLERK_ISSUER ?? null, cli_client_id: vars?.AUTH_CLI_CLIENT_ID ?? null }
      return reply(200, { auth: v.issuer === null ? null : { provider: 'clerk', issuer: v.issuer, cli_client_id: v.cli_client_id } })
    }
    return reply(404, {})
  }) as typeof fetch

  const deps: SetupDeps = {
    exec,
    fetch: fakeFetch,
    loadEnv: () => CREDS,
    readConfigText: () => state.configText,
    writeConfigText: (t) => {
      state.configText = t
      state.configWrites++
    },
    openD1: async () => ({ d1: o.d1, control, dispose: async () => {} }),
    probeEnvFile: (arg, envName): EnvFileProbe => {
      probes.push({ arg, envName })
      const display = arg ?? `.env.${envName}`
      if (o.clerkFileStatus && o.clerkFileStatus !== 'ok') return { display, status: o.clerkFileStatus }
      const text = o.clerkEnvText === undefined ? `CLERK_SECRET_KEY=${SK_TEST}\nVITE_CLERK_PUBLISHABLE_KEY=${PK_TEST}\n` : o.clerkEnvText
      return text === null ? { display, status: 'missing' } : { display, status: 'ok', text }
    },
    readEnvText: () => state.envText,
    appendEnvVar: (name, value) => {
      if (new RegExp(`^${name}=`, 'm').test(state.envText)) throw new Error(`${name} is already set in .env`)
      state.envText += `${name}=${value}\n`
    },
    log: (l) => void logs.push(l),
    now: () => clock,
    sleep: async (ms) => {
      state.sleeps.push(ms)
      clock += ms
    },
  }

  return {
    deps,
    argv,
    inputs,
    secretInputs,
    probes,
    fetched,
    logs,
    state,
    writes: () => argv.filter((c) => isWriteCommand(c)),
    control,
    surface: () => [...argv.map((c) => c.join(' ')), ...inputs, ...logs].join('\n'),
  }
}

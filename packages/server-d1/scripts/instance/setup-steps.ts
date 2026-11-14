// The steps of `vibase-server setup` ([[OPS232]], [[OPS210]] D17): [[OPS65]]'s steps (D11 order) over the settings and secrets files, from an installed release.
// Every wrangler call is the package's own wrangler on a config generated per call (`-c <path>`), never `pnpm`, `git` or `--env`. The parsers, the Clerk rows, the
// preflight and the desired vars are the source path's own code; the steps that touch a command or a file are written here, so `setup:remote` is untouched (D18).
// Nothing here reads a repo path or the process environment: every value comes in through `InstanceDeps` and the secrets file. Nothing logs a secret.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { uuidv7, execute } from '@vibase/storage'
import { d1Binding, openControlDb, writeControlMarker } from '@vibase/storage-d1'
import { bootstrapD1, probeBatchAtomicity } from '../../src/bootstrap-d1.js'
import { initDeploymentOperation } from '../../src/init-deployment.js'
import { PLACEHOLDER_DATABASE_ID, formatMigrationDiff, statusOf } from '../remote.js'
import { clerkStep, configuredCliClientId, signingKeyPem, type ClerkCtx } from '../setup/clerk.js'
import type { ClerkKeys } from '../setup/clerk-keys.js'
import { desiredBlock } from '../setup/config-editor.js'
import { CONTROL_MARKER_SQL, MARKER_SQL, parseControlMarkerOutput, parseD1List, parseMarkerOutput, parseR2List, parseSecretList, parseTrackerOutput } from '../setup/commands.js'
import { GMAIL_SECRET_NAMES, NEVER_REPLACED, type Gmail } from '../setup/gmail.js'
import { preflight } from '../setup/steps.js'
import type { Credentials, SetupOptions, StepName, StepResult } from '../setup/types.js'
import type { ReleaseManifest } from '../../../release/src/manifest.js'
import { withGeneratedConfig, withGeneratedConfigAsync } from './config.js'
import { childEnv } from './gate.js'
import type { Secrets } from './secrets.js'
import { verify, deployArgs, migrateArgs } from './upgrade.js'
import type { InstanceDeps, InstanceSettings, RunResult } from './types.js'

export interface SetupCtx extends ClerkCtx {
  opts: SetupOptions
  /** The instance deps, plus the config text the Clerk rows read `AUTH_CLI_CLIENT_ID` from (the settings file's vars). */
  deps: InstanceDeps & { readConfigText(): string }
  manifest: ReleaseManifest
  secrets: Secrets
  creds: Credentials
  settingsPath: string
  secretsPath: string
  /** The settings file as it was read, `null` when there is none yet. */
  existing: InstanceSettings | null
  /** The settings as they stand after `config:write` (the file's content, or what a dry run would write). */
  current?: InstanceSettings
  gmail: Gmail | null
  facts?: { d1s: { uuid: string; name: string }[]; r2s: string[] }
  /** A change was planned that later steps wait on (a dry run). */
  pending: boolean
  blockedBy?: StepName
  /** An earlier step made a change: a refusal after this is a failed step (exit 3), not a refusal before the first step (exit 2). */
  wrote: boolean
  keyWritten?: boolean
  /** Values that must never be printed beyond the secrets file's own: the operator key once it exists. */
  extraMasks: string[]
}

type Step = (ctx: SetupCtx) => Promise<StepResult>
const result = (step: StepName, status: StepResult['status'], detail: string, lines?: string[]): StepResult => ({ step, status, detail, ...(lines ? { lines } : {}) })

/** Commands that create, apply or deploy: never issued in a dry run. */
export function isWriteArgs(args: readonly string[]): boolean {
  const j = ` ${args.join(' ')} `
  return j.includes(' d1 create ') || j.includes(' r2 bucket create ') || j.includes(' d1 migrations apply ') || args[0] === 'deploy' || j.includes(' secret bulk ')
}

/** [[OPS262]] D5: a new instance's Workflow; an existing record's name wins (the settings file's `workflow.name`). */
export const workflowName = (env: string): string => `vb-mail-sync-${env}`

const CORS = (o: SetupOptions) => o.origins.join(',')

/** The settings the flags (and the clerk and Gmail inputs) ask for; the database id is the discovered one, or the placeholder while it is only planned. */
export function desiredSettings(ctx: SetupCtx): InstanceSettings {
  const { opts } = ctx
  const clerk = opts.auth === 'clerk'
  const d1 = ctx.facts?.d1s.find((d) => d.name === opts.d1Name)
  const control = ctx.facts?.d1s.find((d) => d.name === opts.controlD1Name)
  const cliId = clerk ? (ctx.cliClientId ?? configuredCliClientId(ctx.deps.readConfigText(), opts.env)) : undefined
  const block = desiredBlock({
    env: opts.env,
    workerName: opts.workerName,
    d1Name: opts.d1Name,
    d1Id: d1?.uuid ?? PLACEHOLDER_DATABASE_ID,
    r2Name: opts.r2Name,
    apiHost: opts.apiHost,
    corsOrigins: CORS(opts),
    ...(ctx.gmail ? { gmailVars: ctx.gmail.vars } : {}),
    ...(clerk
      ? { authVars: { AUTH_PROVIDER: 'clerk', CLERK_ISSUER: ctx.keys!.issuer, CLERK_PUBLISHABLE_KEY: ctx.keys!.publishableKey, CLERK_AUTHORIZED_PARTIES: [...new Set([`https://${opts.apiHost}`, ...opts.origins])].join(','), AUTH_CLI_CLIENT_ID: cliId } }
      : {}),
  })
  return {
    version: 1,
    env: opts.env,
    worker: opts.workerName,
    api_host: opts.apiHost,
    d1: { name: opts.d1Name, id: d1?.uuid ?? PLACEHOLDER_DATABASE_ID },
    control_d1: { name: opts.controlD1Name, id: control?.uuid ?? PLACEHOLDER_DATABASE_ID },
    r2_bucket: opts.r2Name,
    workflow: { name: ctx.existing?.workflow.name ?? workflowName(opts.env) },
    vars: block.vars as Record<string, string>,
  }
}

/** The settings every wrangler call is generated from: the file's content once `config:write` has run, the desired ones before. */
const effective = (ctx: SetupCtx): InstanceSettings => ctx.current ?? desiredSettings(ctx)

/** Every wrangler call goes through here: a write in a dry run is refused in code, and the config is generated for the call and gone after it. */
function wr(ctx: SetupCtx, args: string[] | ((configPath: string) => string[]), o: { input?: string } = {}): RunResult {
  const settings = effective(ctx)
  return withGeneratedConfig({ packageDir: ctx.deps.packageDir, settings, tmpRoot: ctx.deps.tmpRoot, resourcesOnly: settings.d1.id === PLACEHOLDER_DATABASE_ID || settings.control_d1?.id === PLACEHOLDER_DATABASE_ID }, (configPath) => {
    const full = typeof args === 'function' ? args(configPath) : [...args, '-c', configPath]
    if (isWriteArgs(full)) {
      if (ctx.opts.dryRun) throw new Error(`refusing to run a write command in a dry run: ${full.join(' ')}`)
      ctx.wrote = true
    }
    return ctx.deps.runWrangler(full, { cwd: dirname(configPath), env: childEnv(ctx.deps, ctx.secrets), input: o.input })
  })
}
const tail = (ctx: SetupCtx, r: RunResult) => ctx.secrets.redact((r.stderr.trim() || r.stdout.trim()).slice(-400))

function readFacts(ctx: SetupCtx, fresh = false): NonNullable<SetupCtx['facts']> {
  if (ctx.facts && !fresh) return ctx.facts
  const d1 = wr(ctx, ['d1', 'list', '--json'])
  if (d1.status !== 0) throw new Error(`wrangler d1 list failed (exit ${d1.status ?? 'none'})`)
  const r2 = wr(ctx, ['r2', 'bucket', 'list'])
  if (r2.status !== 0) throw new Error(`wrangler r2 bucket list failed (exit ${r2.status ?? 'none'})`)
  return (ctx.facts = { d1s: parseD1List(d1.stdout), r2s: parseR2List(r2.stdout) })
}

const preflightStep: Step = async (ctx) => preflight(ctx)

const configResources: Step = async (ctx) => {
  readFacts(ctx)
  const planned: string[] = []
  const { d1Name, controlD1Name, r2Name } = ctx.opts
  const dry = ctx.opts.dryRun
  // The CRM database first, then the control database ([[OPS279]] P4: every instance gets one, whatever `--auth`).
  for (const name of [d1Name, controlD1Name]) {
    if (ctx.facts!.d1s.some((d) => d.name === name)) continue
    planned.push(`D1 ${name}`)
    if (dry) continue
    const r = wr(ctx, ['d1', 'create', name])
    if (r.status !== 0) return result('config:resources', 'fail', `wrangler d1 create ${name} failed (exit ${r.status ?? 'none'})`, [tail(ctx, r)].filter(Boolean))
    readFacts(ctx, true)
    if (!ctx.facts!.d1s.some((d) => d.name === name)) return result('config:resources', 'fail', `D1 ${name} was created but is not in wrangler d1 list`)
  }
  if (!ctx.facts!.r2s.includes(r2Name)) {
    planned.push(`R2 ${r2Name}`)
    if (!dry) {
      const r = wr(ctx, ['r2', 'bucket', 'create', r2Name])
      if (r.status !== 0) return result('config:resources', 'fail', `wrangler r2 bucket create ${r2Name} failed (exit ${r.status ?? 'none'})`, [tail(ctx, r)].filter(Boolean))
    }
  }
  if (planned.length === 0) return result('config:resources', 'ok', `D1 ${d1Name}, D1 ${controlD1Name} and R2 ${r2Name} exist`)
  const state = (n: string) => (planned.includes(n) ? (dry ? 'would create' : 'created') : 'exists')
  if (dry) ctx.pending = true
  return result('config:resources', 'create', planned.join(', '), [`D1 ${d1Name}: ${state(`D1 ${d1Name}`)}`, `D1 ${controlD1Name} (control): ${state(`D1 ${controlD1Name}`)}`, `R2 ${r2Name}: ${state(`R2 ${r2Name}`)}`])
}

const textOf = (s: InstanceSettings): string => `${JSON.stringify(s, null, 2)}\n`

/**
 * The settings file ([[OPS210]] D9): created when absent, completed where it lacks a value the flags need, never overwritten where a value differs
 * (`wrangler.jsonc`'s rule, [[OPS65]] D9, carried over). The run continues: there is no commit stop (D17).
 */
const configWrite: Step = async (ctx) => {
  readFacts(ctx)
  const { opts, existing } = ctx
  const desired = desiredSettings(ctx)
  if (opts.auth === 'clerk' && desired.vars.AUTH_CLI_CLIENT_ID === undefined && !opts.dryRun) {
    return result('config:write', 'fail', 'AUTH_CLI_CLIENT_ID is not known: the Vibase CLI application comes from the clerk step (run it, or set the variable in the settings file)')
  }
  const write = (s: InstanceSettings, detail: string, status: 'create' | 'update'): StepResult => {
    if (opts.dryRun) {
      ctx.pending = true
      ctx.blockedBy = 'config:write'
      return result('config:write', status, `would ${detail}`)
    }
    mkdirSync(dirname(ctx.settingsPath), { recursive: true })
    writeFileSync(ctx.settingsPath, textOf(s))
    ctx.current = s
    ctx.wrote = true
    return result('config:write', status, detail)
  }
  if (existing === null) return write(desired, `write ${ctx.settingsPath}`, 'create')

  const mismatches: string[] = []
  const same = (label: string, a: unknown, b: unknown) => void (a !== b && mismatches.push(label))
  same('worker', existing.worker, desired.worker)
  same('api_host', existing.api_host, desired.api_host)
  same('d1.name', existing.d1.name, desired.d1.name)
  if (desired.d1.id !== PLACEHOLDER_DATABASE_ID) same('d1.id', existing.d1.id, desired.d1.id)
  same('r2_bucket', existing.r2_bucket, desired.r2_bucket)
  same('workflow.name', existing.workflow.name, desired.workflow.name)
  // [[OPS279]]: the control database is recorded once and never changed; an instance recorded without one gets it (P4).
  let control_d1 = existing.control_d1
  const added: string[] = []
  if (existing.control_d1 === undefined) {
    control_d1 = desired.control_d1
    added.push('control_d1')
  } else {
    same('control_d1.name', existing.control_d1.name, desired.control_d1!.name)
    if (desired.control_d1!.id !== PLACEHOLDER_DATABASE_ID) same('control_d1.id', existing.control_d1.id, desired.control_d1!.id)
  }
  const vars = { ...existing.vars }
  for (const [k, v] of Object.entries(desired.vars)) {
    const here = existing.vars[k]
    if (here === undefined || (k === 'CLERK_PUBLISHABLE_KEY' && here === '')) {
      vars[k] = v
      added.push(`vars.${k}`)
    } else if (k === 'CLERK_AUTHORIZED_PARTIES') {
      // A union, never a removal ([[UI30]] D7): what an owner added by hand stays, what setup needs is appended.
      const present = here.split(',').map((o) => o.trim()).filter(Boolean)
      const missing = v.split(',').filter((o) => o !== '' && !present.includes(o))
      if (missing.length > 0) {
        vars[k] = [...present, ...missing].join(',')
        added.push(`vars.${k}`)
      }
    } else if (here !== v) mismatches.push(`vars.${k}`)
  }
  if (mismatches.length > 0) {
    return result('config:write', 'fail', `${ctx.settingsPath} differs from the desired value at ${mismatches.join(', ')}; it is never overwritten: fix it or the flag`, mismatches.map((k) => `differs: ${k}`))
  }
  if (added.length === 0) {
    ctx.current = existing
    return result('config:write', 'ok', `${ctx.settingsPath} is as desired`)
  }
  return write({ ...existing, ...(control_d1 ? { control_d1 } : {}), vars }, `write ${added.join(', ')} into ${ctx.settingsPath}`, 'update')
}

const blocked = (ctx: SetupCtx, step: StepName): StepResult | null => {
  if (ctx.blockedBy) return result(step, 'blocked', `waits on ${ctx.blockedBy} (nothing is evaluated until the settings file is written)`)
  if (ctx.current === undefined) return result(step, 'fail', `there is no settings file at ${ctx.settingsPath}: run config:write first`)
  return ctx.current.d1.id === PLACEHOLDER_DATABASE_ID || ctx.current.control_d1?.id === PLACEHOLDER_DATABASE_ID ? result(step, 'blocked', 'waits on the database planned above') : null
}

const expectedMigrations = (ctx: SetupCtx) => ctx.manifest.migrations.map((m) => m.name)
const expectedControlMigrations = (ctx: SetupCtx) => (ctx.manifest.control_migrations ?? []).map((m) => m.name)
const readTracker = (ctx: SetupCtx, binding: 'DB' | 'CONTROL_DB' = 'DB'): string[] | null => {
  const r = wr(ctx, ['d1', 'execute', binding, '--remote', '--json', '--command', 'select name from d1_migrations'])
  try {
    return parseTrackerOutput(r.stdout)
  } catch (e) {
    throw new Error(`wrangler d1 execute failed (exit ${r.status ?? 'none'}): ${tail(ctx, r) || (e instanceof Error ? e.message : '')}`)
  }
}

/**
 * The expected sets are `release.json`'s ([[OPS232]] P2). Decision (OPS279 D-a): the `migrate` step covers both databases, control first ([[CORE259]] D14); an `ahead`
 * database fails before anything is applied, only a behind database is applied, and a control failure stops before the CRM migration and before deploy.
 */
const migrate: Step = async (ctx) => {
  const b = blocked(ctx, 'migrate')
  if (b) return b
  const dbs = [
    ...(ctx.current?.control_d1 ? [{ label: 'control', binding: 'CONTROL_DB' as const, expected: expectedControlMigrations(ctx) }] : []),
    { label: 'crm', binding: 'DB' as const, expected: expectedMigrations(ctx) },
  ]
  const both = dbs.length > 1
  const read = () => dbs.map((db) => {
    const applied = readTracker(ctx, db.binding)
    return { db, applied, status: statusOf(applied, db.expected) }
  })
  const diff = (rows: ReturnType<typeof read>) => rows.flatMap((x) => formatMigrationDiff(x.applied, x.db.expected).map((l) => (both ? `[${x.db.label}] ${l}` : l)))
  const before = read()
  const ahead = before.find((x) => x.status === 'ahead')
  if (ahead) return result('migrate', 'fail', `the ${both ? `${ahead.db.label} ` : ''}database has migrations this release does not know: install a newer release, do not migrate`, diff(before))
  if (before.every((x) => x.status === 'current')) return result('migrate', 'ok', both ? `${dbs[0]!.expected.length} control and ${dbs[1]!.expected.length} CRM migrations applied` : `${dbs[0]!.expected.length} migrations applied`)
  if (ctx.opts.dryRun) {
    ctx.pending = true
    return result('migrate', 'update', `would apply: ${both ? before.map((x) => `${x.db.label} ${x.status}`).join(', ') : before[0]!.status}`, diff(before))
  }
  for (const x of before) {
    if (x.status === 'current') continue
    const r = wr(ctx, (cfg) => migrateArgs(cfg, x.db.binding))
    if (r.status !== 0) return result('migrate', 'fail', `${both ? `${x.db.label} ` : ''}wrangler d1 migrations apply failed (exit ${r.status ?? 'none'}): ${tail(ctx, r)}`)
  }
  const after = read()
  const notCurrent = after.find((x) => x.status !== 'current')
  if (notCurrent) return result('migrate', 'fail', `${both ? `${notCurrent.db.label} ` : ''}migrations are not current after apply`, diff(after))
  return result('migrate', 'update', 'applied', diff(after))
}

const wantedLink = (ctx: SetupCtx) => (ctx.opts.auth === 'clerk' ? { authProvider: 'clerk', authOrgId: ctx.keys!.issuer } : { authProvider: 'none', authOrgId: ctx.opts.env })

const assigned = (text: string, name: string) => new RegExp(`^\\s*(export\\s+)?${name}=`, 'm').test(text)

/** Appends `NAME=value` to the secrets file, which keeps (or gets) mode 600; refuses when the name is already there ([[OPS232]] P4). */
function appendSecret(ctx: SetupCtx, name: string, value: string): void {
  const exists = existsSync(ctx.secretsPath)
  const text = exists ? readFileSync(ctx.secretsPath, 'utf8') : ''
  if (assigned(text, name)) throw new Error(`${name} is already set in ${ctx.secretsPath}: refusing to overwrite a key`)
  const line = `${text === '' || text.endsWith('\n') ? '' : '\n'}${name}=${value}\n`
  if (exists) appendFileSync(ctx.secretsPath, line)
  else {
    mkdirSync(dirname(ctx.secretsPath), { recursive: true })
    writeFileSync(ctx.secretsPath, line, { mode: 0o600 })
  }
}

/** [[OPS65]] D18, D39 over the release's wrangler and D1: the marker, the organisation and (with the flags) the operator agent, whose key goes to the secrets file. */
const bootstrap: Step = async (ctx) => {
  const b = blocked(ctx, 'bootstrap')
  if (b) return b
  const { opts } = ctx
  const want = wantedLink(ctx)
  const clerk = opts.auth === 'clerk'
  const hasControl = ctx.current?.control_d1 !== undefined
  const read = wr(ctx, ['d1', 'execute', 'DB', '--remote', '--json', '--command', MARKER_SQL])
  const marker = parseMarkerOutput(read.stdout)
  if (marker === 'no-table') return opts.dryRun ? result('bootstrap', 'blocked', 'the database is not migrated yet') : result('bootstrap', 'fail', 'the database is not migrated: run migrate first')
  // [[OPS279]] (D7, D9): the control marker is read with the CRM one; a marker that names another organisation is refused before either database is written.
  const control = hasControl ? parseControlMarkerOutput(wr(ctx, ['d1', 'execute', 'CONTROL_DB', '--remote', '--json', '--command', CONTROL_MARKER_SQL]).stdout) : undefined
  if (control === 'no-table') return opts.dryRun ? result('bootstrap', 'blocked', 'the control database is not migrated yet') : result('bootstrap', 'fail', 'the control database is not migrated: run migrate first')
  if (control && (marker === null || control.organizationId !== marker.organizationId)) {
    return result('bootstrap', 'fail', `the control database is already paired with organization ${control.organizationId}, not ${marker === null ? 'this deployment' : marker.organizationId}: it belongs to another deployment`)
  }
  if (marker !== null) {
    if (marker.authProvider !== want.authProvider || marker.authOrgId !== want.authOrgId) {
      return result('bootstrap', 'fail', `the database is marked ${marker.authProvider}:${marker.authOrgId}, not ${want.authProvider}:${want.authOrgId}: it belongs to another deployment`)
    }
    // A Clerk bootstrap always makes the organisation (CORE64 D11); `none` without the operator flags is the marker alone.
    if (!clerk || marker.organizations > 0) {
      const mark = `marker ${want.authProvider}:${want.authOrgId} present`
      if (control !== null) return result('bootstrap', 'ok', opts.operatorAgent !== undefined ? `${mark}: bootstrap already ran, so --operator-agent and --key-env were not applied; create another agent key through api_keys.create on /meta/v1` : mark)
      // An instance bootstrapped before the control database existed: only its control marker is missing.
      const what = `control marker for organization ${marker.organizationId}`
      if (opts.dryRun) {
        ctx.pending = true
        return result('bootstrap', 'create', `would write ${what}`)
      }
      ctx.wrote = true
      return withGeneratedConfigAsync({ packageDir: ctx.deps.packageDir, settings: effective(ctx), tmpRoot: ctx.deps.tmpRoot }, async (configPath) => {
        const opened = await ctx.deps.openD1({ configPath, remoteBindings: true, persist: false, env: childEnv(ctx.deps, ctx.secrets) })
        try {
          if (!opened.control) return result('bootstrap', 'fail', 'the control database is not bound in the instance proxy')
          await writeControlMarker(openControlDb(opened.control), marker.organizationId)
          return result('bootstrap', 'create', `wrote ${what}`)
        } finally {
          await opened.dispose()
        }
      })
    }
  }
  const operator = opts.operatorAgent !== undefined
  if (operator && assigned(ctx.secrets.text, opts.keyEnv!)) return result('bootstrap', 'fail', `${opts.keyEnv} is already set in ${ctx.secretsPath}: refusing to overwrite a key`)
  const mark = `marker ${want.authProvider}:${want.authOrgId}`
  const keyTo = operator ? `, operator agent ${opts.operatorAgent} (key to ${ctx.secretsPath} as ${opts.keyEnv})` : ''
  const ctl = hasControl ? ', control marker' : ''
  const what = clerk ? `${marker ? 'organisation' : `${mark}, organisation`} ${opts.org}${keyTo}${ctl}, no human (the owner arrives by invitation)` : operator ? `${mark}, organisation ${opts.org}${keyTo}${ctl}` : `${mark}${ctl}`
  if (opts.dryRun) {
    ctx.pending = true
    return result('bootstrap', 'create', `would write ${what}`)
  }
  ctx.wrote = true
  return withGeneratedConfigAsync({ packageDir: ctx.deps.packageDir, settings: effective(ctx), tmpRoot: ctx.deps.tmpRoot }, async (configPath) => {
    const { d1, control: controlD1, dispose } = await ctx.deps.openD1({ configPath, remoteBindings: true, persist: false, env: childEnv(ctx.deps, ctx.secrets) })
    try {
      if (hasControl && !controlD1) return result('bootstrap', 'fail', 'the control database is not bound in the instance proxy')
      const controlDb = hasControl ? openControlDb(controlD1!) : undefined
      const link = { organizationId: marker?.organizationId ?? uuidv7(), ...want }
      if (marker === null) {
        if ((await probeBatchAtomicity(d1, link)) === 'not-atomic') return result('bootstrap', 'fail', 'atomicity probe failed (a failed batch left a row): stopping')
      }
      if (!clerk && !operator) {
        await execute(d1Binding(d1, link), { kind: 'internal', organizationId: link.organizationId }, initDeploymentOperation(link))
        // The control marker follows the CRM deployment row ([[CORE259]] D7).
        if (controlDb) await writeControlMarker(controlDb, link.organizationId)
        return result('bootstrap', 'create', `wrote ${what}`)
      }
      const r = clerk
        ? await bootstrapD1(d1, { organizationName: opts.org, agentName: opts.operatorAgent, ...want, organizationId: link.organizationId }, { control: controlDb })
        : await bootstrapD1(d1, { organizationName: opts.org, email: opts.ownerEmail, agentName: opts.operatorAgent!, ...want, organizationId: link.organizationId }, { control: controlDb })
      if (r.key === null || r.agentId === null) return result('bootstrap', 'create', `wrote ${what}`)
      ctx.extraMasks.push(r.key)
      try {
        appendSecret(ctx, opts.keyEnv!, r.key)
      } catch {
        return result('bootstrap', 'fail', `the API key could not be written to ${ctx.secretsPath}; it is lost: revoke api key ${r.apiKeyId} and create a new one`)
      }
      ctx.keyWritten = true
      return result('bootstrap', 'create', `wrote ${what}`, [`agent_id: ${r.agentId}`, `api_key_id: ${r.apiKeyId}`, `api_key: written to ${ctx.secretsPath} as ${opts.keyEnv} (not shown)`])
    } finally {
      await dispose()
    }
  })
}

interface Health {
  version?: string
  commit?: string
  migrations?: string
}
async function readHealth(ctx: SetupCtx): Promise<Health | null> {
  try {
    const res = await ctx.deps.fetch(`https://${ctx.opts.apiHost}/health`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
    if (res.status !== 200) return null
    const j = (await res.json()) as { version?: unknown; commit?: unknown; migrations?: { status?: unknown } }
    return { version: typeof j.version === 'string' ? j.version : undefined, commit: typeof j.commit === 'string' ? j.commit : undefined, migrations: typeof j.migrations?.status === 'string' ? j.migrations.status : undefined }
  } catch {
    return null
  }
}

/** [[OPS232]] P5: `ok` without deploying when `/health` already shows the package's version and commit; otherwise D15's deploy (`--no-bundle`, `VERSION`, `COMMIT`). */
const deploy: Step = async (ctx) => {
  const b = blocked(ctx, 'deploy')
  if (b) return b
  const { version, commit } = ctx.manifest
  const health = await readHealth(ctx)
  if (health?.version === version && health.commit === commit) return result('deploy', 'ok', `/health already reports ${version} @ ${commit}`)
  const seen = health?.version ? health.version.slice(0, 12) : 'no answer'
  if (ctx.opts.dryRun) {
    ctx.pending = true
    return result('deploy', 'update', `would deploy ${version} @ ${commit} (/health: ${seen})`)
  }
  const r = wr(ctx, (cfg) => deployArgs(version, commit, cfg))
  if (r.status !== 0) return result('deploy', 'fail', `wrangler deploy failed (exit ${r.status ?? 'none'}): ${tail(ctx, r)}`)
  return result('deploy', 'update', `deployed ${version} @ ${commit} (was ${seen})`)
}

const CLERK_SECRET_NAMES = ['CLERK_SECRET_KEY', 'CLERK_JWT_KEY'] as const

/** [[OPS87]], [[OPS150]] over `wrangler secret bulk` on stdin: present secrets stay without `--rotate-secrets`; `CREDENTIALS_KEY` is put only when absent. */
const secrets: Step = async (ctx) => {
  const b = blocked(ctx, 'secrets')
  if (b) return b
  const clerk = ctx.opts.auth === 'clerk'
  const names: string[] = [...(clerk ? CLERK_SECRET_NAMES : []), ...(ctx.gmail ? GMAIL_SECRET_NAMES : [])]
  if (names.length === 0) return result('secrets', 'ok', 'no secrets for this configuration (--auth none, no Gmail group)')
  const list = wr(ctx, ['secret', 'list', '--format', 'json'])
  if (list.status !== 0) {
    return ctx.opts.dryRun && ctx.pending
      ? result('secrets', 'blocked', 'waits on the Worker planned above (wrangler secret list needs it to exist)')
      : result('secrets', 'fail', `wrangler secret list failed (exit ${list.status ?? 'none'}): is the Worker deployed?`)
  }
  const present = parseSecretList(list.stdout)
  const put = names.filter((n) => (n === NEVER_REPLACED && ctx.gmail ? !present.includes(n) : ctx.opts.rotateSecrets || !present.includes(n)))
  const kept = ctx.gmail && ctx.opts.rotateSecrets && present.includes(NEVER_REPLACED) ? [`${NEVER_REPLACED} kept: stored credentials are encrypted under it (rotate through CREDENTIALS_KEY_VERSION, not setup)`] : []
  if (put.length === 0) return result('secrets', 'ok', `${names.join(' and ')} are present (--rotate-secrets replaces them${ctx.gmail ? `, except ${NEVER_REPLACED}` : ''})`, kept.length ? kept : undefined)
  const status = put.filter((n) => present.includes(n)).length === put.length ? 'update' : 'create'
  if (ctx.opts.dryRun) return result('secrets', status, `would put ${put.join(', ')}`, kept.length ? kept : undefined)
  const values: Record<string, string> = {}
  if (put.includes('CLERK_SECRET_KEY')) values.CLERK_SECRET_KEY = ctx.keys!.secretKey
  if (put.includes('CLERK_JWT_KEY')) values.CLERK_JWT_KEY = await signingKeyPem(ctx)
  for (const n of GMAIL_SECRET_NAMES) if (put.includes(n)) values[n] = ctx.gmail!.secrets[n]!
  const r = wr(ctx, ['secret', 'bulk'], { input: JSON.stringify(values) })
  if (r.status !== 0) return result('secrets', 'fail', `wrangler secret bulk failed (exit ${r.status ?? 'none'})`)
  return result('secrets', status, `put ${put.join(', ')}`, kept.length ? kept : undefined)
}

/** `/.well-known/vibase` `auth` must equal what setup configured ([[OPS65]] D21). */
async function checkDiscovery(ctx: SetupCtx): Promise<string | null> {
  const keys = ctx.keys as ClerkKeys
  const expectedClient = ctx.cliClientId ?? ctx.current?.vars.AUTH_CLI_CLIENT_ID
  let auth: { issuer?: unknown; cli_client_id?: unknown } | null | undefined
  try {
    const res = await ctx.deps.fetch(`https://${ctx.opts.apiHost}/.well-known/vibase`)
    if (res.status !== 200) return `https://${ctx.opts.apiHost}/.well-known/vibase answered ${res.status}`
    auth = ((await res.json()) as { auth?: typeof auth }).auth
  } catch {
    return `https://${ctx.opts.apiHost}/.well-known/vibase did not answer`
  }
  if (!auth) return '/.well-known/vibase reports no auth provider: the Worker has no Clerk configuration (are the secrets and variables in place?)'
  const bad: string[] = []
  if (auth.issuer !== keys.issuer) bad.push(`auth.issuer is ${String(auth.issuer)}, setup configured ${keys.issuer}`)
  if (expectedClient === undefined) bad.push('auth.cli_client_id cannot be compared: AUTH_CLI_CLIENT_ID is not in the settings file (run the clerk step)')
  else if (auth.cli_client_id !== expectedClient) bad.push(`auth.cli_client_id is ${String(auth.cli_client_id)}, setup configured ${expectedClient}`)
  return bad.length ? `/.well-known/vibase disagrees: ${bad.join('; ')}` : null
}

/** [[OPS232]] P5: verify expects the package's version with migrations `current`, on the injected clock and the 300 s bound of `upgrade`. */
const verifyStep: Step = async (ctx) => {
  const b = blocked(ctx, 'verify')
  if (b) return b
  const { version } = ctx.manifest
  const url = `https://${ctx.opts.apiHost}`
  let seen: string | null
  if (ctx.opts.dryRun) {
    const h = await readHealth(ctx)
    seen = h?.version === version && h.migrations === 'current' ? null : h === null ? 'no answer' : `version ${h.version ?? '?'}, migrations ${h.migrations ?? '?'}`
    if (seen !== null) return ctx.pending ? result('verify', 'blocked', 'waits on the changes planned above') : result('verify', 'fail', `${url}/health is not at ${version} with migrations current (${seen})`)
  } else {
    seen = await verify(url, version, ['current'], ctx.deps)
    if (seen !== null) return result('verify', 'fail', `${url}/health did not become ${version} with migrations current within 300s (${seen})`)
  }
  if (ctx.opts.auth === 'clerk') {
    const mismatch = await checkDiscovery(ctx)
    if (mismatch) return result('verify', 'fail', mismatch)
  }
  const clerk = ctx.opts.auth === 'clerk'
  const next = [
    `API: ${url}`,
    ...(clerk
      ? [`accept the owner invitation Clerk emailed to ${ctx.opts.ownerEmail}`, `vibase login --server ${url}`, 'GET /meta/v1/me must show role: owner (this is the C3 check: a missing vibase_role session-token claim refuses the sign-in)', ...(ctx.manualRows ?? []).map((m) => `manual ${m}`)]
      : []),
    ctx.keyWritten ? `agents use the operator key in ${ctx.secretsPath} (${ctx.opts.keyEnv}) as a Bearer token` : 'no operator key was created in this run; create agents and keys through agents.create and api_keys.create on /meta/v1 (re-run with --operator-agent and --key-env only while the organisation does not exist yet)',
  ]
  return result('verify', 'ok', `${url}/health is ${version}, migrations current`, next)
}

const clerkStepAdapter: Step = (ctx) => clerkStep(ctx)

export const STEPS: Record<StepName, Step> = {
  preflight: preflightStep,
  'config:resources': configResources,
  clerk: clerkStepAdapter,
  'config:write': configWrite,
  migrate,
  bootstrap,
  deploy,
  secrets,
  verify: verifyStep,
}

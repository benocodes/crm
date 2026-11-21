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
import {
  GOOGLE_SECRET_NAMES,
  authSecretManual,
  authSecretState,
  newAuthSecret,
  type BetterAuthInputs,
} from '../setup/better-auth.js'
import { clerkStep, configuredCliClientId, signingKeyPem, type ClerkCtx } from '../setup/clerk.js'
import type { ClerkKeys } from '../setup/clerk-keys.js'
import { desiredBlock } from '../setup/config-editor.js'
import {
  CONTROL_MARKER_SQL,
  MARKER_SQL,
  OWNERS_SQL,
  OWNER_INVITATIONS_SQL,
  parseControlMarkerOutput,
  parseD1List,
  parseMarkerOutput,
  parseOwnerState,
  parseR2List,
  parseSecretList,
  parseTrackerOutput,
  type MarkerRow,
} from '../setup/commands.js'
import { GMAIL_SECRET_NAMES, NEVER_REPLACED, type Gmail } from '../setup/gmail.js'
import { moveLines, oldDomainManual } from '../setup/host.js'
import { preflight } from '../setup/steps.js'
import type { Credentials, SetupOptions, StepName, StepResult } from '../setup/types.js'
import type { ReleaseManifest } from '../../../release/src/manifest.js'
import { withGeneratedConfig, withGeneratedConfigAsync } from './config.js'
import { childEnv, sameCommit } from './gate.js'
import type { Secrets } from './secrets.js'
import { deployArgs, migrateArgs } from './upgrade.js'
import {
  CfApiError,
  readBucket,
  readDomains,
  readSubdomainEnabled,
  readWorkerSettings,
  type WorkerSettings,
} from './cf-api.js'
import { readOnce } from './reach.js'
import {
  betterAuthNextSteps,
  checkBetterAuthIssuer,
  secretsKeptSentence,
  type OwnerInvitation,
} from '../setup/verify-better-auth.js'
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
  /** `--auth better-auth`: `AUTH_SECRET` and the Google pair as the secrets file holds them ([[OPS249]] D3, D4). */
  betterAuth?: BetterAuthInputs
  facts?: { d1s: { uuid: string; name: string }[]; r2s: string[] }
  /** A change was planned that later steps wait on (a dry run). */
  pending: boolean
  blockedBy?: StepName
  /** An earlier step made a change: a refusal after this is a failed step (exit 3), not a refusal before the first step (exit 2). */
  wrote: boolean
  keyWritten?: boolean
  /** `bootstrap` issued an owner invitation in this run: the only run whose next steps say "open the link printed above" ([[OPS306]] P4). */
  ownerLinkIssued?: boolean
  /** The invitation this run issued, held for the closing Claim block ([[GH442]] item 5): never in a step's lines. */
  ownerInvitation?: OwnerInvitation
  /** [[OPS496]] D5: the owner state the bootstrap step found (an owner, or a pending owner invitation); unset when that step did not report it. */
  ownerState?: { kind: 'owner' } | { kind: 'pending'; email: string; expiresAt: string }
  /** [[OPS496]] D2, D5: verify's one `/health` read got no answer. */
  hostUnanswered?: boolean
  /** Values that must never be printed beyond the secrets file's own: the operator key once it exists. */
  extraMasks: string[]
}

type Step = (ctx: SetupCtx) => Promise<StepResult>
const result = (step: StepName, status: StepResult['status'], detail: string, lines?: string[]): StepResult => ({
  step,
  status,
  detail,
  ...(lines ? { lines } : {}),
})

/** Commands that create, apply or deploy: never issued in a dry run. */
export function isWriteArgs(args: readonly string[]): boolean {
  const j = ` ${args.join(' ')} `
  return (
    j.includes(' d1 create ') ||
    j.includes(' r2 bucket create ') ||
    j.includes(' d1 migrations apply ') ||
    args[0] === 'deploy' ||
    j.includes(' secret bulk ')
  )
}

import { workflowName } from '../setup/names.js'

export { workflowName }

const CORS = (o: SetupOptions) => o.origins.join(',')

/** The settings the flags (and the clerk and Gmail inputs) ask for; the database id is the discovered one, or the placeholder while it is only planned. */
export function desiredSettings(ctx: SetupCtx): InstanceSettings {
  const { opts } = ctx
  const clerk = opts.auth === 'clerk'
  const d1 = ctx.facts?.d1s.find((d) => d.name === opts.d1Name)
  const control = ctx.facts?.d1s.find((d) => d.name === opts.controlD1Name)
  const cliId = clerk ? (ctx.cliClientId ?? configuredCliClientId(ctx.deps.readConfigText(), opts.env)) : undefined
  // [[OPS308]]: workers_dev is on in workers.dev mode and stays on after a move from it.
  const wd = opts.workersDev || opts.recordedHost?.workersDev === true
  const block = desiredBlock({
    env: opts.env,
    workerName: opts.workerName,
    d1Name: opts.d1Name,
    d1Id: d1?.uuid ?? PLACEHOLDER_DATABASE_ID,
    r2Name: opts.r2Name,
    apiHost: opts.apiHost,
    workersDev: wd,
    noRoute: opts.workersDev,
    move: opts.move !== undefined,
    corsOrigins: CORS(opts),
    ...(ctx.gmail ? { gmailVars: ctx.gmail.vars } : {}),
    // [[OPS249]] D2: `better-auth` writes `AUTH_PROVIDER` and `PUBLIC_BASE_URL` and nothing else.
    ...(opts.auth === 'better-auth'
      ? { authVars: { AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: `https://${opts.apiHost}` } }
      : {}),
    ...(clerk
      ? {
          authVars: {
            AUTH_PROVIDER: 'clerk',
            CLERK_ISSUER: ctx.keys!.issuer,
            CLERK_PUBLISHABLE_KEY: ctx.keys!.publishableKey,
            CLERK_AUTHORIZED_PARTIES: [...new Set([`https://${opts.apiHost}`, ...opts.origins])].join(','),
            AUTH_CLI_CLIENT_ID: cliId,
          },
        }
      : {}),
  })
  return {
    version: 1,
    env: opts.env,
    worker: opts.workerName,
    api_host: opts.apiHost,
    ...(wd ? { workers_dev: true } : {}),
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
  return withGeneratedConfig(
    {
      packageDir: ctx.deps.packageDir,
      settings,
      tmpRoot: ctx.deps.tmpRoot,
      resourcesOnly: settings.d1.id === PLACEHOLDER_DATABASE_ID || settings.control_d1?.id === PLACEHOLDER_DATABASE_ID,
    },
    (configPath) => {
      const full = typeof args === 'function' ? args(configPath) : [...args, '-c', configPath]
      if (isWriteArgs(full)) {
        if (ctx.opts.dryRun) throw new Error(`refusing to run a write command in a dry run: ${full.join(' ')}`)
        ctx.wrote = true
      }
      return ctx.deps.runWrangler(full, {
        cwd: dirname(configPath),
        env: childEnv(ctx.deps, ctx.secrets),
        input: o.input,
      })
    },
  )
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
    if (r.status !== 0)
      return result(
        'config:resources',
        'fail',
        `wrangler d1 create ${name} failed (exit ${r.status ?? 'none'})`,
        [tail(ctx, r)].filter(Boolean),
      )
    readFacts(ctx, true)
    if (!ctx.facts!.d1s.some((d) => d.name === name))
      return result('config:resources', 'fail', `D1 ${name} was created but is not in wrangler d1 list`)
  }
  if (!ctx.facts!.r2s.includes(r2Name)) {
    planned.push(`R2 ${r2Name}`)
    if (!dry) {
      const r = wr(ctx, ['r2', 'bucket', 'create', r2Name])
      if (r.status !== 0)
        return result(
          'config:resources',
          'fail',
          `wrangler r2 bucket create ${r2Name} failed (exit ${r.status ?? 'none'})`,
          [tail(ctx, r)].filter(Boolean),
        )
    }
  }
  if (planned.length === 0)
    return result('config:resources', 'ok', `D1 ${d1Name}, D1 ${controlD1Name} and R2 ${r2Name} exist`)
  const state = (n: string) => (planned.includes(n) ? (dry ? 'would create' : 'created') : 'exists')
  if (dry) ctx.pending = true
  return result('config:resources', 'create', planned.join(', '), [
    `D1 ${d1Name}: ${state(`D1 ${d1Name}`)}`,
    `D1 ${controlD1Name} (control): ${state(`D1 ${controlD1Name}`)}`,
    `R2 ${r2Name}: ${state(`R2 ${r2Name}`)}`,
  ])
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
    return result(
      'config:write',
      'fail',
      'AUTH_CLI_CLIENT_ID is not known: the Vibase CLI application comes from the clerk step (run it, or set the variable in the settings file)',
    )
  }
  const { move } = opts
  // [[OPS308]] P5: setup makes no DNS or custom-domain delete call, so a custom domain the move leaves behind is the operator's to detach.
  const leftBehind =
    move?.fromMode === 'custom' && move.from !== undefined && !opts.workersDev ? [oldDomainManual(move.from)] : []
  const write = (s: InstanceSettings, detail: string, status: 'create' | 'update'): StepResult => {
    if (opts.dryRun) {
      ctx.pending = true
      ctx.blockedBy = 'config:write'
      return {
        ...result('config:write', status, `would ${detail}`),
        ...(leftBehind.length ? { manual: leftBehind } : {}),
      }
    }
    mkdirSync(dirname(ctx.settingsPath), { recursive: true })
    writeFileSync(ctx.settingsPath, textOf(s))
    ctx.current = s
    ctx.wrote = true
    return { ...result('config:write', status, detail), ...(leftBehind.length ? { manual: leftBehind } : {}) }
  }
  if (existing === null) return write(desired, `write ${ctx.settingsPath}`, 'create')

  const mismatches: string[] = []
  const same = (label: string, a: unknown, b: unknown) => void (a !== b && mismatches.push(label))
  same('worker', existing.worker, desired.worker)
  if (!move) same('api_host', existing.api_host, desired.api_host)
  same('workers_dev', existing.workers_dev === true, desired.workers_dev === true)
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
    if (desired.control_d1!.id !== PLACEHOLDER_DATABASE_ID)
      same('control_d1.id', existing.control_d1.id, desired.control_d1!.id)
  }
  const vars = { ...existing.vars }
  for (const [k, v] of Object.entries(desired.vars)) {
    const here = existing.vars[k]
    if (k === 'PUBLIC_BASE_URL' && move && here !== undefined && here !== v) {
      vars[k] = v
      added.push(`vars.${k}`)
    } else if (here === undefined || (k === 'CLERK_PUBLISHABLE_KEY' && here === '')) {
      vars[k] = v
      added.push(`vars.${k}`)
    } else if (k === 'CLERK_AUTHORIZED_PARTIES') {
      // A union, never a removal ([[UI30]] D7): what an owner added by hand stays, what setup needs is appended.
      const present = here
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean)
      const missing = v.split(',').filter((o) => o !== '' && !present.includes(o))
      if (missing.length > 0) {
        vars[k] = [...present, ...missing].join(',')
        added.push(`vars.${k}`)
      }
    } else if (here !== v) mismatches.push(`vars.${k}`)
  }
  if (mismatches.length > 0) {
    return result(
      'config:write',
      'fail',
      `${ctx.settingsPath} differs from the desired value at ${mismatches.join(', ')}; it is never overwritten: fix it or the flag`,
      mismatches.map((k) => `differs: ${k}`),
    )
  }
  if (move) added.unshift('api_host')
  if (added.length === 0) {
    ctx.current = existing
    return result('config:write', 'ok', `${ctx.settingsPath} is as desired`)
  }
  return write(
    { ...existing, ...(move ? { api_host: desired.api_host } : {}), ...(control_d1 ? { control_d1 } : {}), vars },
    `write ${added.join(', ')} into ${ctx.settingsPath}`,
    'update',
  )
}

const blocked = (ctx: SetupCtx, step: StepName): StepResult | null => {
  if (ctx.blockedBy)
    return result(
      step,
      'blocked',
      `waits on ${ctx.blockedBy} (nothing is evaluated until the settings file is written)`,
    )
  if (ctx.current === undefined)
    return result(step, 'fail', `there is no settings file at ${ctx.settingsPath}: run config:write first`)
  return ctx.current.d1.id === PLACEHOLDER_DATABASE_ID || ctx.current.control_d1?.id === PLACEHOLDER_DATABASE_ID
    ? result(step, 'blocked', 'waits on the database planned above')
    : null
}

const expectedMigrations = (ctx: SetupCtx) => ctx.manifest.migrations.map((m) => m.name)
const expectedControlMigrations = (ctx: SetupCtx) => (ctx.manifest.control_migrations ?? []).map((m) => m.name)
const readTracker = (ctx: SetupCtx, binding: 'DB' | 'CONTROL_DB' = 'DB'): string[] | null => {
  const r = wr(ctx, ['d1', 'execute', binding, '--remote', '--json', '--command', 'select name from d1_migrations'])
  try {
    return parseTrackerOutput(r.stdout)
  } catch (e) {
    throw new Error(
      `wrangler d1 execute failed (exit ${r.status ?? 'none'}): ${tail(ctx, r) || (e instanceof Error ? e.message : '')}`,
    )
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
    ...(ctx.current?.control_d1
      ? [{ label: 'control', binding: 'CONTROL_DB' as const, expected: expectedControlMigrations(ctx) }]
      : []),
    { label: 'crm', binding: 'DB' as const, expected: expectedMigrations(ctx) },
  ]
  const both = dbs.length > 1
  const read = () =>
    dbs.map((db) => {
      const applied = readTracker(ctx, db.binding)
      return { db, applied, status: statusOf(applied, db.expected) }
    })
  const diff = (rows: ReturnType<typeof read>) =>
    rows.flatMap((x) => formatMigrationDiff(x.applied, x.db.expected).map((l) => (both ? `[${x.db.label}] ${l}` : l)))
  const before = read()
  const ahead = before.find((x) => x.status === 'ahead')
  if (ahead)
    return result(
      'migrate',
      'fail',
      `the ${both ? `${ahead.db.label} ` : ''}database has migrations this release does not know: install a newer release, do not migrate`,
      diff(before),
    )
  if (before.every((x) => x.status === 'current'))
    return result(
      'migrate',
      'ok',
      both
        ? `${dbs[0]!.expected.length} control and ${dbs[1]!.expected.length} CRM migrations applied`
        : `${dbs[0]!.expected.length} migrations applied`,
    )
  if (ctx.opts.dryRun) {
    ctx.pending = true
    return result(
      'migrate',
      'update',
      `would apply: ${both ? before.map((x) => `${x.db.label} ${x.status}`).join(', ') : before[0]!.status}`,
      diff(before),
    )
  }
  for (const x of before) {
    if (x.status === 'current') continue
    const r = wr(ctx, (cfg) => migrateArgs(cfg, x.db.binding))
    if (r.status !== 0)
      return result(
        'migrate',
        'fail',
        `${both ? `${x.db.label} ` : ''}wrangler d1 migrations apply failed (exit ${r.status ?? 'none'}): ${tail(ctx, r)}`,
      )
  }
  const after = read()
  const notCurrent = after.find((x) => x.status !== 'current')
  if (notCurrent)
    return result(
      'migrate',
      'fail',
      `${both ? `${notCurrent.db.label} ` : ''}migrations are not current after apply`,
      diff(after),
    )
  return result('migrate', 'update', 'applied', diff(after))
}

const wantedLink = (ctx: SetupCtx) =>
  ctx.opts.auth === 'clerk'
    ? { authProvider: 'clerk', authOrgId: ctx.keys!.issuer }
    : { authProvider: ctx.opts.auth, authOrgId: ctx.opts.env }

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

/**
 * [[OPS249]] D6, D7: the `better-auth` bootstrap over the release's wrangler and D1. The owner state is read first (an owner membership, else the newest live owner invitation, else neither) and
 * `ownerEmail` reaches the shared `bootstrapD1` only in the third state, so a re-run never re-issues (or reprints) the link. A dry run reports the state it found and writes nothing.
 */
async function betterAuthBootstrap(
  ctx: SetupCtx,
  want: { authProvider: string; authOrgId: string },
  marker: MarkerRow | null,
  control: { organizationId: string } | null | undefined,
): Promise<StepResult> {
  const { opts } = ctx
  if (ctx.current?.control_d1 === undefined)
    return result('bootstrap', 'fail', 'better-auth needs the control database: the settings file records none')
  const complete = marker !== null && marker.organizations > 0 && control !== null
  const read = (binding: 'DB' | 'CONTROL_DB', sql: string) =>
    wr(ctx, ['d1', 'execute', binding, '--remote', '--json', '--command', sql]).stdout
  const state = parseOwnerState(read('DB', OWNERS_SQL), read('CONTROL_DB', OWNER_INVITATIONS_SQL))
  const operator = opts.operatorAgent !== undefined
  const mark = `marker ${want.authProvider}:${want.authOrgId} present`
  if (state.kind === 'owner') ctx.ownerState = { kind: 'owner' }
  else if (state.kind !== 'none') ctx.ownerState = { kind: 'pending', email: state.email, expiresAt: state.expiresAt }
  if (complete && state.kind !== 'none') {
    const note = operator
      ? ': bootstrap already ran, so --operator-agent and --key-env were not applied; create another agent key through api_keys.create on /meta/v1'
      : ''
    return result(
      'bootstrap',
      'ok',
      state.kind === 'owner'
        ? `${mark}, an owner exists: nothing to issue${note}`
        : `${mark}, owner invitation pending for ${state.email} (expires ${state.expiresAt}), a new link: vibase-server owner-reset --env ${opts.env} --email ${state.email}${note}`,
    )
  }
  const issue = state.kind === 'none'
  if (issue && opts.ownerEmail === undefined) {
    return result(
      'bootstrap',
      'fail',
      '--owner-email is required: this instance has no owner and no live owner invitation, so setup must issue one (pass --owner-email <address>)',
    )
  }
  if (operator && !complete && assigned(ctx.secrets.text, opts.keyEnv!))
    return result(
      'bootstrap',
      'fail',
      `${opts.keyEnv} is already set in ${ctx.secretsPath}: refusing to overwrite a key`,
    )
  const invite = issue ? `an owner invitation for ${opts.ownerEmail}` : undefined
  if (opts.dryRun) {
    ctx.pending = true
    if (complete) return result('bootstrap', 'create', `would issue ${invite}`)
    const parts = [
      ...(marker === null ? [`marker ${want.authProvider}:${want.authOrgId}`] : []),
      ...(marker === null || marker.organizations === 0 ? [`organisation ${opts.org}`] : []),
      ...(control === null ? ['control marker'] : []),
      'the vibase-cli client',
      ...(operator ? [`operator agent ${opts.operatorAgent} (key to ${ctx.secretsPath} as ${opts.keyEnv})`] : []),
    ]
    return result('bootstrap', 'create', `would write ${parts.join(', ')}${invite ? `, then issue ${invite}` : ''}`)
  }
  ctx.wrote = true
  return withGeneratedConfigAsync(
    { packageDir: ctx.deps.packageDir, settings: effective(ctx), tmpRoot: ctx.deps.tmpRoot },
    async (configPath) => {
      const {
        d1,
        control: controlD1,
        dispose,
      } = await ctx.deps.openD1({
        configPath,
        remoteBindings: true,
        persist: false,
        env: childEnv(ctx.deps, ctx.secrets),
      })
      try {
        if (!controlD1) return result('bootstrap', 'fail', 'the control database is not bound in the instance proxy')
        const link = { organizationId: marker?.organizationId ?? uuidv7(), ...want }
        if (marker === null && (await probeBatchAtomicity(d1, link)) === 'not-atomic')
          return result('bootstrap', 'fail', 'atomicity probe failed (a failed batch left a row): stopping')
        const r = await bootstrapD1(
          d1,
          {
            organizationName: opts.org,
            agentName: opts.operatorAgent,
            ...want,
            organizationId: link.organizationId,
            publicBaseUrl: `https://${opts.apiHost}`,
            ...(issue ? { ownerEmail: opts.ownerEmail } : {}),
          },
          { control: openControlDb(controlD1) },
        )
        const lines: string[] = []
        if (r.key !== null && r.agentId !== null) {
          ctx.extraMasks.push(r.key)
          try {
            appendSecret(ctx, opts.keyEnv!, r.key)
          } catch {
            return result(
              'bootstrap',
              'fail',
              `the API key could not be written to ${ctx.secretsPath}; it is lost: revoke api key ${r.apiKeyId} and create a new one`,
            )
          }
          ctx.keyWritten = true
          lines.push(
            `agent_id: ${r.agentId}`,
            `api_key_id: ${r.apiKeyId}`,
            `api_key: written to ${ctx.secretsPath} as ${opts.keyEnv} (not shown)`,
          )
        }
        // [[GH442]] item 5: the URL is held for the closing Claim block (printed once, last, stored nowhere); a later run reads the state and prints none.
        if (r.ownerInvitation) {
          ctx.ownerLinkIssued = true
          ctx.ownerInvitation = {
            email: r.ownerInvitation.email,
            expiresAt: r.ownerInvitation.expiresAt,
            url: r.ownerInvitation.url,
          }
          lines.push(
            `owner invitation for ${r.ownerInvitation.email} issued (the link is printed at the end of this run)`,
          )
        }
        return result(
          'bootstrap',
          'create',
          `wrote ${[...(marker === null ? [`marker ${want.authProvider}:${want.authOrgId}`] : []), `organisation ${opts.org}`, 'control marker', 'the vibase-cli client', ...(r.ownerInvitation ? ['an owner invitation'] : [])].join(', ')}`,
          lines.length ? lines : undefined,
        )
      } finally {
        await dispose()
      }
    },
  )
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
  if (marker === 'no-table')
    return opts.dryRun
      ? result('bootstrap', 'blocked', 'the database is not migrated yet')
      : result('bootstrap', 'fail', 'the database is not migrated: run migrate first')
  // [[OPS279]] (D7, D9): the control marker is read with the CRM one; a marker that names another organisation is refused before either database is written.
  const control = hasControl
    ? parseControlMarkerOutput(
        wr(ctx, ['d1', 'execute', 'CONTROL_DB', '--remote', '--json', '--command', CONTROL_MARKER_SQL]).stdout,
      )
    : undefined
  if (control === 'no-table')
    return opts.dryRun
      ? result('bootstrap', 'blocked', 'the control database is not migrated yet')
      : result('bootstrap', 'fail', 'the control database is not migrated: run migrate first')
  if (control && (marker === null || control.organizationId !== marker.organizationId)) {
    return result(
      'bootstrap',
      'fail',
      `the control database is already paired with organization ${control.organizationId}, not ${marker === null ? 'this deployment' : marker.organizationId}: it belongs to another deployment`,
    )
  }
  if (marker !== null && (marker.authProvider !== want.authProvider || marker.authOrgId !== want.authOrgId)) {
    return result(
      'bootstrap',
      'fail',
      `the database is marked ${marker.authProvider}:${marker.authOrgId}, not ${want.authProvider}:${want.authOrgId}: it belongs to another deployment`,
    )
  }
  if (opts.auth === 'better-auth') return betterAuthBootstrap(ctx, want, marker, control)
  if (marker !== null) {
    // A Clerk bootstrap always makes the organisation (CORE64 D11); `none` without the operator flags is the marker alone.
    if (!clerk || marker.organizations > 0) {
      const mark = `marker ${want.authProvider}:${want.authOrgId} present`
      if (control !== null)
        return result(
          'bootstrap',
          'ok',
          opts.operatorAgent !== undefined
            ? `${mark}: bootstrap already ran, so --operator-agent and --key-env were not applied; create another agent key through api_keys.create on /meta/v1`
            : mark,
        )
      // An instance bootstrapped before the control database existed: only its control marker is missing.
      const what = `control marker for organization ${marker.organizationId}`
      if (opts.dryRun) {
        ctx.pending = true
        return result('bootstrap', 'create', `would write ${what}`)
      }
      ctx.wrote = true
      return withGeneratedConfigAsync(
        { packageDir: ctx.deps.packageDir, settings: effective(ctx), tmpRoot: ctx.deps.tmpRoot },
        async (configPath) => {
          const opened = await ctx.deps.openD1({
            configPath,
            remoteBindings: true,
            persist: false,
            env: childEnv(ctx.deps, ctx.secrets),
          })
          try {
            if (!opened.control)
              return result('bootstrap', 'fail', 'the control database is not bound in the instance proxy')
            await writeControlMarker(openControlDb(opened.control), marker.organizationId)
            return result('bootstrap', 'create', `wrote ${what}`)
          } finally {
            await opened.dispose()
          }
        },
      )
    }
  }
  const operator = opts.operatorAgent !== undefined
  if (operator && assigned(ctx.secrets.text, opts.keyEnv!))
    return result(
      'bootstrap',
      'fail',
      `${opts.keyEnv} is already set in ${ctx.secretsPath}: refusing to overwrite a key`,
    )
  const mark = `marker ${want.authProvider}:${want.authOrgId}`
  const keyTo = operator ? `, operator agent ${opts.operatorAgent} (key to ${ctx.secretsPath} as ${opts.keyEnv})` : ''
  const ctl = hasControl ? ', control marker' : ''
  const what = clerk
    ? `${marker ? 'organisation' : `${mark}, organisation`} ${opts.org}${keyTo}${ctl}, no human (the owner arrives by invitation)`
    : operator
      ? `${mark}, organisation ${opts.org}${keyTo}${ctl}`
      : `${mark}${ctl}`
  if (opts.dryRun) {
    ctx.pending = true
    return result('bootstrap', 'create', `would write ${what}`)
  }
  ctx.wrote = true
  return withGeneratedConfigAsync(
    { packageDir: ctx.deps.packageDir, settings: effective(ctx), tmpRoot: ctx.deps.tmpRoot },
    async (configPath) => {
      const {
        d1,
        control: controlD1,
        dispose,
      } = await ctx.deps.openD1({
        configPath,
        remoteBindings: true,
        persist: false,
        env: childEnv(ctx.deps, ctx.secrets),
      })
      try {
        if (hasControl && !controlD1)
          return result('bootstrap', 'fail', 'the control database is not bound in the instance proxy')
        const controlDb = hasControl ? openControlDb(controlD1!) : undefined
        const link = { organizationId: marker?.organizationId ?? uuidv7(), ...want }
        if (marker === null) {
          if ((await probeBatchAtomicity(d1, link)) === 'not-atomic')
            return result('bootstrap', 'fail', 'atomicity probe failed (a failed batch left a row): stopping')
        }
        if (!clerk && !operator) {
          await execute(
            d1Binding(d1, link),
            { kind: 'internal', organizationId: link.organizationId },
            initDeploymentOperation(link),
          )
          // The control marker follows the CRM deployment row ([[CORE259]] D7).
          if (controlDb) await writeControlMarker(controlDb, link.organizationId)
          return result('bootstrap', 'create', `wrote ${what}`)
        }
        const r = clerk
          ? await bootstrapD1(
              d1,
              {
                organizationName: opts.org,
                agentName: opts.operatorAgent,
                ...want,
                organizationId: link.organizationId,
              },
              { control: controlDb },
            )
          : await bootstrapD1(
              d1,
              {
                organizationName: opts.org,
                email: opts.ownerEmail,
                agentName: opts.operatorAgent!,
                ...want,
                organizationId: link.organizationId,
              },
              { control: controlDb },
            )
        if (r.key === null || r.agentId === null) return result('bootstrap', 'create', `wrote ${what}`)
        ctx.extraMasks.push(r.key)
        try {
          appendSecret(ctx, opts.keyEnv!, r.key)
        } catch {
          return result(
            'bootstrap',
            'fail',
            `the API key could not be written to ${ctx.secretsPath}; it is lost: revoke api key ${r.apiKeyId} and create a new one`,
          )
        }
        ctx.keyWritten = true
        return result('bootstrap', 'create', `wrote ${what}`, [
          `agent_id: ${r.agentId}`,
          `api_key_id: ${r.apiKeyId}`,
          `api_key: written to ${ctx.secretsPath} as ${opts.keyEnv} (not shown)`,
        ])
      } finally {
        await dispose()
      }
    },
  )
}

/**
 * [[OPS496]] D4 (revising [[OPS232]] P5): `ok` without deploying when the Worker's settings already show the package's version and commit and every recorded variable at its value; otherwise
 * D15's deploy (`--no-bundle`, `VERSION`, `COMMIT`). The live build comes from the Cloudflare API, never from the host: a lookup of a hostname before its record exists poisons the machine's DNS cache.
 */
const deploy: Step = async (ctx) => {
  const b = blocked(ctx, 'deploy')
  if (b) return b
  const { version, commit } = ctx.manifest
  let live: WorkerSettings | null = null
  let unreadable: string | undefined
  try {
    live = await readWorkerSettings(ctx.creds, ctx.opts.workerName, ctx.deps.fetch)
  } catch (e) {
    unreadable = e instanceof CfApiError ? `settings unreadable: HTTP ${e.status}` : 'settings unreadable'
  }
  const sameBuild = live !== null && live.plain.VERSION === version && sameCommit(live.plain.COMMIT ?? null, commit)
  const differing = live
    ? Object.entries(effective(ctx).vars)
        .filter(([k, v]) => live.plain[k] !== v)
        .map(([k]) => k)
    : []
  // [[OPS308]] D14: a host move changes the generated config (the route, the issuer) at an unchanged version, so it always deploys.
  if (!ctx.opts.move && sameBuild && differing.length === 0)
    return result('deploy', 'ok', `the Worker already shows ${version} @ ${commit} with the recorded variables`)
  const seen =
    unreadable ??
    (live === null
      ? 'no Worker'
      : `${live.plain.VERSION ? live.plain.VERSION.slice(0, 12) : 'no version'}${sameBuild && differing.length ? `, variables differ: ${differing.join(', ')}` : ''}`)
  if (ctx.opts.dryRun) {
    ctx.pending = true
    return result('deploy', 'update', `would deploy ${version} @ ${commit} (Worker: ${seen})`)
  }
  const r = wr(ctx, (cfg) => deployArgs(version, commit, cfg))
  if (r.status !== 0)
    return result('deploy', 'fail', `wrangler deploy failed (exit ${r.status ?? 'none'}): ${tail(ctx, r)}`)
  return result('deploy', 'update', `deployed ${version} @ ${commit} (was ${seen})`)
}

const CLERK_SECRET_NAMES = ['CLERK_SECRET_KEY', 'CLERK_JWT_KEY'] as const

/** The secrets this configuration's `secrets` step manages: the Clerk pair, `AUTH_SECRET` and the Google pair when set, the Gmail group. */
export function managedSecretNames(ctx: SetupCtx): string[] {
  return [
    ...(ctx.opts.auth === 'clerk' ? CLERK_SECRET_NAMES : []),
    ...(ctx.betterAuth ? ['AUTH_SECRET', ...(ctx.betterAuth.google ? GOOGLE_SECRET_NAMES : [])] : []),
    ...(ctx.gmail ? GMAIL_SECRET_NAMES : []),
  ]
}

/**
 * [[OPS87]], [[OPS150]] over `wrangler secret bulk` on stdin: present secrets stay without `--rotate-secrets`; `CREDENTIALS_KEY` is put only when absent. [[OPS249]] D3: `AUTH_SECRET` is
 * judged by its four states and never rotated; a generated value is written to the secrets file BEFORE the put, so a failed put cannot lose it.
 */
const secrets: Step = async (ctx) => {
  const b = blocked(ctx, 'secrets')
  if (b) return b
  const ba = ctx.betterAuth
  const names = managedSecretNames(ctx)
  if (names.length === 0)
    return result('secrets', 'ok', 'no secrets for this configuration (--auth none, no Gmail group)')
  const list = wr(ctx, ['secret', 'list', '--format', 'json'])
  if (list.status !== 0) {
    return ctx.opts.dryRun && ctx.pending
      ? result('secrets', 'blocked', 'waits on the Worker planned above (wrangler secret list needs it to exist)')
      : result(
          'secrets',
          'fail',
          `wrangler secret list failed (exit ${list.status ?? 'none'}): is the Worker deployed?`,
        )
  }
  const present = parseSecretList(list.stdout)
  const authState = ba ? authSecretState(ba.authSecret !== undefined, present.includes('AUTH_SECRET')) : undefined
  const put = names.filter((n) =>
    n === 'AUTH_SECRET'
      ? authState === 'a' || authState === 'b'
      : n === NEVER_REPLACED && ctx.gmail
        ? !present.includes(n)
        : ctx.opts.rotateSecrets || !present.includes(n),
  )
  const stays = ctx.opts.rotateSecrets
    ? []
    : names.filter((n) => n !== 'AUTH_SECRET' && present.includes(n) && !put.includes(n))
  const kept = [
    ...(ctx.gmail && ctx.opts.rotateSecrets && present.includes(NEVER_REPLACED)
      ? [
          `${NEVER_REPLACED} kept: stored credentials are encrypted under it (rotate through CREDENTIALS_KEY_VERSION, not setup)`,
        ]
      : []),
    // [[GH442]] item 4: present secrets that this run does not replace.
    ...(stays.length > 0 && put.length > 0 ? [secretsKeptSentence(stays)] : []),
  ]
  const manual = authState === 'd' ? authSecretManual(ba!.file) : undefined
  if (put.length === 0) {
    if (manual) return result('secrets', 'manual', manual, kept.length ? kept : undefined)
    return result(
      'secrets',
      'ok',
      `${names.join(' and ')} are present and kept as they are: a changed value in the secrets file is not applied without --rotate-secrets${ctx.gmail ? ` (which never replaces ${NEVER_REPLACED})` : ''}${ba ? ' (AUTH_SECRET is never replaced)' : ''}`,
      kept.length ? kept : undefined,
    )
  }
  const status = put.filter((n) => present.includes(n)).length === put.length ? 'update' : 'create'
  const wouldPut = `${authState === 'a' ? `would generate AUTH_SECRET into ${ba!.file} and ` : 'would '}put ${put.join(', ')}`
  if (ctx.opts.dryRun)
    return manual
      ? result('secrets', 'manual', manual, [wouldPut, ...kept])
      : result('secrets', status, wouldPut, kept.length ? kept : undefined)
  const values: Record<string, string> = {}
  if (put.includes('CLERK_SECRET_KEY')) values.CLERK_SECRET_KEY = ctx.keys!.secretKey
  if (put.includes('CLERK_JWT_KEY')) values.CLERK_JWT_KEY = await signingKeyPem(ctx)
  if (authState === 'b') values.AUTH_SECRET = ba!.authSecret!
  if (authState === 'a') {
    values.AUTH_SECRET = newAuthSecret()
    // Masked from every later line before it can be printed, then written to the file before the put.
    ctx.extraMasks.push(values.AUTH_SECRET)
    try {
      appendSecret(ctx, 'AUTH_SECRET', values.AUTH_SECRET)
      ctx.wrote = true
    } catch {
      return result('secrets', 'fail', `AUTH_SECRET could not be written to ${ba!.file}; nothing was put`)
    }
  }
  if (ba?.google) for (const n of GOOGLE_SECRET_NAMES) if (put.includes(n)) values[n] = ba.google[n]
  for (const n of GMAIL_SECRET_NAMES) if (put.includes(n)) values[n] = ctx.gmail!.secrets[n]!
  const r = wr(ctx, ['secret', 'bulk'], { input: JSON.stringify(values) })
  if (r.status !== 0)
    return result(
      'secrets',
      'fail',
      `wrangler secret bulk failed (exit ${r.status ?? 'none'})${authState === 'a' ? `; AUTH_SECRET is in ${ba!.file}, the next run puts it` : ''}`,
    )
  const done = `put ${put.join(', ')}`
  return manual
    ? result('secrets', 'manual', manual, [done, ...kept])
    : result('secrets', status, done, kept.length ? kept : undefined)
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
  if (!auth)
    return '/.well-known/vibase reports no auth provider: the Worker has no Clerk configuration (are the secrets and variables in place?)'
  const bad: string[] = []
  if (auth.issuer !== keys.issuer) bad.push(`auth.issuer is ${String(auth.issuer)}, setup configured ${keys.issuer}`)
  if (expectedClient === undefined)
    bad.push(
      'auth.cli_client_id cannot be compared: AUTH_CLI_CLIENT_ID is not in the settings file (run the clerk step)',
    )
  else if (auth.cli_client_id !== expectedClient)
    bad.push(`auth.cli_client_id is ${String(auth.cli_client_id)}, setup configured ${expectedClient}`)
  return bad.length ? `/.well-known/vibase disagrees: ${bad.join('; ')}` : null
}

/**
 * [[OPS496]] D1: the facts the old poll inferred from `/health` and the ones it could not see, each through the Cloudflare API and none through the host. The first failure is returned,
 * naming the check and what was found; no later check runs.
 */
async function apiChecks(ctx: SetupCtx): Promise<string | null> {
  const { opts, creds } = ctx
  const f = ctx.deps.fetch
  const { version, commit } = ctx.manifest
  let worker: WorkerSettings | null = null
  const checks: [string, () => Promise<string | null>][] = [
    [
      'Worker',
      async () => {
        worker = await readWorkerSettings(creds, opts.workerName, f)
        if (worker === null) return `Worker ${opts.workerName} not found (Cloudflare API code 10007)`
        const p = worker.plain
        if (p.VERSION !== version) return `VERSION is ${p.VERSION ?? 'not set'}, the package is ${version}`
        if (!sameCommit(p.COMMIT ?? null, commit)) return `COMMIT is ${p.COMMIT ?? 'not set'}, the package is ${commit}`
        for (const [k, v] of Object.entries(effective(ctx).vars))
          if (p[k] !== v)
            return `variable ${k} is ${p[k] === undefined ? 'not set' : JSON.stringify(p[k])} on the Worker, recorded ${JSON.stringify(v)}`
        return null
      },
    ],
    [
      'secrets',
      async () => {
        const missing = managedSecretNames(ctx).filter((n) => !worker!.secrets.includes(n))
        return missing.length ? `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not on the Worker` : null
      },
    ],
    [
      'host',
      async () => {
        if (opts.workersDev)
          return (await readSubdomainEnabled(creds, opts.workerName, f))
            ? null
            : `the workers.dev subdomain of ${opts.workerName} is not enabled`
        return (await readDomains(creds, opts.workerName, f)).includes(opts.apiHost)
          ? null
          : `custom domain ${opts.apiHost} is not attached to ${opts.workerName}`
      },
    ],
    [
      'migrations',
      async () => {
        const dbs = [
          ...(ctx.current?.control_d1
            ? [{ label: 'control', binding: 'CONTROL_DB' as const, expected: expectedControlMigrations(ctx) }]
            : []),
          { label: 'crm', binding: 'DB' as const, expected: expectedMigrations(ctx) },
        ]
        for (const db of dbs) {
          const status = statusOf(readTracker(ctx, db.binding), db.expected)
          if (status !== 'current') return `the ${db.label} database is ${status}, not current`
        }
        return null
      },
    ],
    ['bucket', async () => ((await readBucket(creds, opts.r2Name, f)) ? null : `R2 bucket ${opts.r2Name} not found`)],
  ]
  for (const [name, check] of checks) {
    try {
      const d = await check()
      if (d) return `${name} check failed: ${d}`
    } catch (e) {
      return `${name} check failed: ${ctx.secrets.redact(e instanceof Error ? e.message : 'failed')}`
    }
  }
  return null
}

/** [[OPS496]] D2: one `/health` read after the API checks. No answer is `ok` ("not reachable yet"); an answer that is wrong fails. Returns a failure detail, `'unanswered'`, or `null`. */
async function readHostOnce(ctx: SetupCtx, url: string): Promise<string | 'unanswered' | null> {
  const { version, commit } = ctx.manifest
  const r = await readOnce(ctx.deps.fetch, `${url}/health`)
  if (!r.answered) return 'unanswered'
  if (r.status !== 200) return `${url}/health answered ${r.status}, not 200`
  const j = r.body as { version?: unknown; commit?: unknown; migrations?: { status?: unknown } } | null
  if (typeof j?.version !== 'string')
    return `${url}/health answered 200 but not with a Vibase health body (no version string)`
  if (j.version !== version) return `${url}/health is at version ${j.version}, the package is ${version}`
  if (typeof j.commit === 'string' && !sameCommit(j.commit, commit))
    return `${url}/health is at commit ${j.commit}, the package is ${commit}`
  const m = j.migrations?.status
  if (m !== 'current') return `${url}/health reports migrations ${typeof m === 'string' ? m : 'unknown'}, not current`
  return null
}

/**
 * [[OPS496]] D1-D3 (revising [[OPS232]] P5, [[OPS306]] D8, [[OPS308]] P2): the Cloudflare API checks, then one bounded `/health` read and, only after a `200`, one read of each discovery
 * document. Never polls and never sleeps.
 */
const verifyStep: Step = async (ctx) => {
  const b = blocked(ctx, 'verify')
  if (b) return b
  const { version } = ctx.manifest
  const url = `https://${ctx.opts.apiHost}`
  const failed = await apiChecks(ctx)
  // A dry run with changes planned above evaluates nothing yet, whatever the reads showed.
  if (ctx.opts.dryRun && ctx.pending) return result('verify', 'blocked', 'waits on the changes planned above')
  if (failed) return result('verify', 'fail', failed)
  const host = await readHostOnce(ctx, url)
  const reached = host !== 'unanswered'
  if (host !== null && host !== 'unanswered') return result('verify', 'fail', host)
  if (!reached) ctx.hostUnanswered = true
  if (reached && ctx.opts.auth === 'clerk') {
    const mismatch = await checkDiscovery(ctx)
    if (mismatch) return result('verify', 'fail', mismatch)
  }
  let signInMethods: string[] = []
  if (reached && ctx.opts.auth === 'better-auth') {
    // OPS306 D8, P1: the issuer is the recorded PUBLIC_BASE_URL (`https://<api host>`, the value setup records), never a request host. One read of each document ([[OPS496]] D3).
    const issuer = await checkBetterAuthIssuer(url, {
      fetch: ctx.deps.fetch,
      now: ctx.deps.now,
      sleep: ctx.deps.sleep,
      dryRun: false,
      once: true,
    })
    if (!issuer.ok) return result('verify', 'fail', issuer.detail)
    signInMethods = issuer.signInMethods
  }
  const detail = reached
    ? `${url}/health is ${version}, migrations current`
    : `${url} not reachable yet from this machine (API checks passed; discovery not checked)`
  const hint = ctx.keyWritten
    ? `agents use the operator key in ${ctx.secretsPath} (${ctx.opts.keyEnv}) as a Bearer token`
    : 'no operator key was created in this run; create agents and keys through agents.create and api_keys.create on /meta/v1 (re-run with --operator-agent and --key-env only while the organisation does not exist yet)'
  if (ctx.opts.auth === 'better-auth') {
    // The settings file holds variables only, never a `send_email` binding, so email is never recorded here and the statement always prints (OPS306 D5).
    return result(
      'verify',
      'ok',
      detail,
      betterAuthNextSteps({
        url,
        claimLink: ctx.ownerLinkIssued === true,
        google: signInMethods.includes('google') || (!reached && ctx.betterAuth?.google !== undefined),
        emailConfigured: false,
        hint: [hint],
      }).concat(ctx.opts.move ? moveLines(ctx.opts.move.from, ctx.opts.apiHost, false) : []),
    )
  }
  const clerk = ctx.opts.auth === 'clerk'
  const next = [
    `API: ${url}`,
    ...(clerk
      ? [
          `accept the owner invitation Clerk emailed to ${ctx.opts.ownerEmail}`,
          `vibase login --server ${url}`,
          'GET /meta/v1/me must show role: owner (this is the C3 check: a missing vibase_role session-token claim refuses the sign-in)',
          ...(ctx.manualRows ?? []).map((m) => `manual ${m}`),
        ]
      : []),
    hint,
    ...(ctx.opts.move
      ? [
          `host change: ${ctx.opts.move.from ?? 'workers.dev'} -> ${ctx.opts.apiHost}: point every client at the new host`,
        ]
      : []),
  ]
  return result('verify', 'ok', detail, next)
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

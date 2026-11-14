// The steps of `setup:remote` ([[OPS65]] D7, D11): each reads the current state, compares it with the desired one and reports
// `ok` / `create` / `update` / `fail` (or `blocked`); a real run then makes the change. Nothing here logs a credential or the operator key.
import { parse } from 'jsonc-parser'
import { bootstrapD1, probeBatchAtomicity } from '../../src/bootstrap-d1.js'
import { initDeploymentOperation } from '../../src/init-deployment.js'
import { execute, uuidv7 } from '@vibase/storage'
import { CONTROL_MIGRATIONS, MIGRATIONS, d1Binding, openControlDb, writeControlMarker } from '@vibase/storage-d1'
import { PLACEHOLDER_DATABASE_ID, RemoteRefusal, formatMigrationDiff, resolveTarget, statusOf, type ConfigLike, type Target } from '../remote.js'
import { clerkStep, configuredCliClientId, signingKeyPem } from './clerk.js'
import type { ClerkKeys } from './clerk-keys.js'
import { GMAIL_SECRET_NAMES, NEVER_REPLACED, hideGmailValues, type Gmail } from './gmail.js'
import { reconcileEnvBlock, type DesiredEnv } from './config-editor.js'
import {
  controlMarkerCommand,
  d1CreateCommand,
  d1ListCommand,
  deployStepCommands,
  gitHead,
  gitStatus,
  isWriteCommand,
  markerCommand,
  migrateStepCommands,
  parseControlMarkerOutput,
  parseD1List,
  parseMarkerOutput,
  parseR2List,
  parseSecretList,
  parseTrackerOutput,
  r2CreateCommand,
  r2ListCommand,
  secretBulkCommand,
  secretListCommand,
  trackerCommand,
} from './commands.js'
import type { Credentials, ExecResult, SetupCmd, SetupDeps, SetupOptions, StepName, StepResult } from './types.js'

const EXPECTED = MIGRATIONS.map((m) => m.name)
const CONTROL_EXPECTED = CONTROL_MIGRATIONS.map((m) => m.name)
const CF = 'https://api.cloudflare.com/client/v4/'
export const VERIFY_INTERVAL_MS = 10_000
export const VERIFY_BOUND_MS = 300_000

export interface Ctx {
  opts: SetupOptions
  deps: SetupDeps
  creds: Credentials
  /** Set when an earlier step planned a change a later step depends on (a dry run). */
  pending: boolean
  /** Set by `config:write` when it planned or made a change that later steps wait on. */
  blockedBy?: StepName
  /** The sha `verify` expects: set only when `deploy` ran in this invocation. */
  expectSha?: string
  facts?: { d1s: { uuid: string; name: string }[]; r2s: string[] }
  /** `config:write` made a change: the run stops ([[OPS65]] D10). */
  stop?: boolean
  /** `bootstrap` wrote the operator key to `.env` in this run. */
  keyWritten?: boolean
  /** `--auth clerk`: the instance's credentials, loaded before any request ([[OPS65]] D34). */
  keys?: ClerkKeys
  /** The `Vibase CLI` application's client id, once the `clerk` step found or created it. */
  cliClientId?: string
  /** The Gmail group from the env file ([[OPS150]]); `null` when skipped. */
  gmail?: Gmail | null
  /** The instance's signing key as PEM; a secret value, never printed. */
  jwtPem?: string
  /** The Clerk rows that are `manual`, repeated in verify's next steps ([[OPS65]] D21). */
  manualRows?: string[]
}

type Step = (ctx: Ctx) => Promise<StepResult>
const result = (step: StepName, status: StepResult['status'], detail: string, lines?: string[]): StepResult => ({ step, status, detail, ...(lines ? { lines } : {}) })
const message = (e: unknown) => (e instanceof Error ? e.message : 'failed')

/** Every subprocess goes through here: a write in a dry run is refused in code, not only by each step's own check. */
async function run(ctx: Ctx, cmd: SetupCmd): Promise<ExecResult> {
  if (ctx.opts.dryRun && isWriteCommand(cmd)) throw new Error(`refusing to run a write command in a dry run: ${cmd.args.join(' ')}`)
  return ctx.deps.exec(cmd)
}

function envConfig(text: string, env: string): ConfigLike {
  const root = parse(text, [], { allowTrailingComma: true }) as { env?: Record<string, { name?: string; d1_databases?: ConfigLike['d1_databases'] }> } | undefined
  const block = root?.env?.[env]
  if (!block) throw new RemoteRefusal(`env ${env} is not in wrangler.jsonc yet: run config:write first`)
  return { name: block.name, d1_databases: block.d1_databases }
}
function target(ctx: Ctx): Target {
  return resolveTarget(envConfig(ctx.deps.readConfigText(), ctx.opts.env), ctx.opts.env)
}

async function readFacts(ctx: Ctx, fresh = false): Promise<NonNullable<Ctx['facts']>> {
  if (ctx.facts && !fresh) return ctx.facts
  const d1 = await run(ctx, d1ListCommand())
  if (d1.status !== 0) throw new Error(`wrangler d1 list failed (exit ${d1.status})`)
  const r2 = await run(ctx, r2ListCommand())
  if (r2.status !== 0) throw new Error(`wrangler r2 bucket list failed (exit ${r2.status})`)
  ctx.facts = { d1s: parseD1List(d1.stdout), r2s: parseR2List(r2.stdout) }
  return ctx.facts
}

const cfGet = (ctx: PreflightCtx, path: string) => ctx.deps.fetch(`${CF}${path}`, { headers: { authorization: `Bearer ${ctx.creds.apiToken}` } })

/** What `preflight` reads: shared with `vibase-server setup` ([[OPS232]]). */
export interface PreflightCtx {
  creds: Credentials
  opts: Pick<SetupOptions, 'apiHost'>
  deps: Pick<SetupDeps, 'fetch'>
}
export const preflight = async (ctx: PreflightCtx): Promise<StepResult> => {
  const { accountId } = ctx.creds
  const probes: [string, string][] = [
    [`accounts/${accountId}/d1/database?per_page=1`, 'Account / D1 / Edit'],
    [`accounts/${accountId}/r2/buckets?per_page=1`, 'Account / Workers R2 Storage / Edit'],
    [`accounts/${accountId}/workers/scripts`, 'Account / Workers Scripts / Edit'],
  ]
  const failures: string[] = []
  for (const [path, permission] of probes) {
    const res = await cfGet(ctx, path)
    if (!res.ok) failures.push(`${permission}: the token cannot read it (HTTP ${res.status})`)
  }
  const labels = ctx.opts.apiHost.split('.')
  let zone: string | null = null
  let zoneDenied = false
  for (let i = 0; i <= labels.length - 2 && zone === null && !zoneDenied; i++) {
    const candidate = labels.slice(i).join('.')
    const res = await cfGet(ctx, `zones?name=${encodeURIComponent(candidate)}`)
    if (!res.ok) {
      zoneDenied = true
      failures.push(`Zone / Zone / Read: the token cannot read zones (HTTP ${res.status})`)
      break
    }
    const body = (await res.json()) as { result?: { name?: string }[] }
    if (body.result?.some((z) => z.name === candidate)) zone = candidate
  }
  if (zone === null && !zoneDenied) failures.push(`zone: no zone for ${ctx.opts.apiHost} is visible to the token (the API host must be on a zone in this account)`)
  if (failures.length > 0) return result('preflight', 'fail', `missing: ${failures.map((f) => f.split(':')[0]).join(', ')}`, failures)
  return result('preflight', 'ok', `Cloudflare credentials reach D1, R2, Workers and zone ${zone}`)
}

const configResources: Step = async (ctx) => {
  await readFacts(ctx)
  const planned: string[] = []
  const lines: string[] = []
  const { d1Name, controlD1Name, r2Name } = ctx.opts
  // The CRM database first, then the control database ([[OPS279]] P4: every instance gets one, whatever `--auth`).
  for (const name of [d1Name, controlD1Name]) {
    if (ctx.facts!.d1s.some((d) => d.name === name)) continue
    planned.push(`D1 ${name}`)
    if (!ctx.opts.dryRun) {
      const r = await run(ctx, d1CreateCommand(name))
      if (r.status !== 0) return result('config:resources', 'fail', `wrangler d1 create ${name} failed (exit ${r.status})`, [r.stderr.trim()].filter(Boolean))
      await readFacts(ctx, true)
      if (!ctx.facts!.d1s.some((d) => d.name === name)) return result('config:resources', 'fail', `D1 ${name} was created but is not in wrangler d1 list`)
    }
  }
  if (!ctx.facts!.r2s.includes(r2Name)) {
    planned.push(`R2 ${r2Name}`)
    if (!ctx.opts.dryRun) {
      const r = await run(ctx, r2CreateCommand(r2Name))
      if (r.status !== 0) return result('config:resources', 'fail', `wrangler r2 bucket create ${r2Name} failed (exit ${r.status})`, [r.stderr.trim()].filter(Boolean))
    }
  }
  const state = (n: string) => (planned.includes(n) ? (ctx.opts.dryRun ? 'would create' : 'created') : 'exists')
  lines.push(`D1 ${d1Name}: ${state(`D1 ${d1Name}`)}`)
  lines.push(`D1 ${controlD1Name} (control): ${state(`D1 ${controlD1Name}`)}`)
  lines.push(`R2 ${r2Name}: ${state(`R2 ${r2Name}`)}`)
  if (planned.length === 0) return result('config:resources', 'ok', `D1 ${d1Name}, D1 ${controlD1Name} and R2 ${r2Name} exist`)
  if (ctx.opts.dryRun) ctx.pending = true
  return result('config:resources', 'create', planned.join(', '), lines)
}

function lineDiff(before: string, after: string): string[] {
  const count = (t: string) => t.split('\n').reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>())
  const b = count(before)
  const a = count(after)
  const out: string[] = []
  for (const l of before.split('\n')) if ((a.get(l) ?? 0) < (b.get(l) ?? 0)) (a.set(l, (a.get(l) ?? 0) + 1), out.push(`- ${l}`))
  for (const l of after.split('\n')) if ((b.get(l) ?? 0) < (a.get(l) ?? 0)) (b.set(l, (b.get(l) ?? 0) + 1), out.push(`+ ${l}`))
  return out
}

const configWrite: Step = async (ctx) => {
  const facts = await readFacts(ctx)
  const before0 = ctx.deps.readConfigText()
  const created = facts.d1s.find((d) => d.name === ctx.opts.d1Name)
  const createdControl = facts.d1s.find((d) => d.name === ctx.opts.controlD1Name)
  const clerk = ctx.opts.auth === 'clerk'
  const cliId = clerk ? (ctx.cliClientId ?? configuredCliClientId(before0, ctx.opts.env)) : undefined
  if (clerk && cliId === undefined && !ctx.opts.dryRun) {
    return result('config:write', 'fail', 'AUTH_CLI_CLIENT_ID is not known: the Vibase CLI application comes from the clerk step (run it, or set the variable in wrangler.jsonc)')
  }
  const desired: DesiredEnv = {
    env: ctx.opts.env,
    workerName: ctx.opts.workerName,
    d1Name: ctx.opts.d1Name,
    d1Id: created?.uuid ?? PLACEHOLDER_DATABASE_ID,
    controlD1Name: ctx.opts.controlD1Name,
    controlD1Id: createdControl?.uuid ?? PLACEHOLDER_DATABASE_ID,
    r2Name: ctx.opts.r2Name,
    apiHost: ctx.opts.apiHost,
    corsOrigins: ctx.opts.origins.join(','),
    ...(ctx.gmail ? { gmailVars: ctx.gmail.vars } : {}),
    // [[UI30]] D7: the connect page's own origin is an authorized party (never a CORS origin, never a Clerk allowed origin), and the
    // publishable key is a public var. `--auth none` writes neither.
    ...(clerk
      ? {
          authVars: {
            AUTH_PROVIDER: 'clerk',
            CLERK_ISSUER: ctx.keys!.issuer,
            CLERK_PUBLISHABLE_KEY: ctx.keys!.publishableKey,
            CLERK_AUTHORIZED_PARTIES: [...new Set([`https://${ctx.opts.apiHost}`, ...ctx.opts.origins])].join(','),
            AUTH_CLI_CLIENT_ID: cliId,
          },
        }
      : {}),
  }
  const before = ctx.deps.readConfigText()
  const r = reconcileEnvBlock(before, desired)
  if (r.mismatches.length > 0) {
    return result('config:write', 'fail', `wrangler.jsonc differs from the desired value at ${r.mismatches.join(', ')}; it is never overwritten: fix it or the flag`, r.mismatches.map((k) => `differs: ${k}`))
  }
  if (r.changed.length === 0) return result('config:write', 'ok', `env.${ctx.opts.env} in wrangler.jsonc is as desired`)
  const diff = lineDiff(before, r.text).map(hideGmailValues)
  if (ctx.opts.dryRun) {
    ctx.pending = true
    ctx.blockedBy = 'config:write'
    return result('config:write', 'update', `would write ${r.changed.join(', ')}${clerk && cliId === undefined ? ' (AUTH_CLI_CLIENT_ID follows once the Vibase CLI application exists)' : ''}`, diff)
  }
  ctx.deps.writeConfigText(r.text)
  ctx.stop = true
  return result('config:write', 'update', `wrote ${r.changed.join(', ')}`, [...diff, 'review and commit wrangler.jsonc, then re-run the same command to migrate, bootstrap, deploy and verify'])
}

const blocked = (ctx: Ctx, step: StepName): StepResult | null =>
  ctx.blockedBy ? result(step, 'blocked', `waits on ${ctx.blockedBy} (nothing is evaluated until the config is written and committed)`) : null

interface Db {
  label: 'control' | 'crm'
  binding: 'CONTROL_DB' | 'DB'
  expected: string[]
}

/**
 * Decision (OPS279 D-a): the `migrate` step covers both databases, control first ([[CORE259]] D14); `--only migrate` migrates both. Each database is read, a database
 * `ahead` of this build fails before anything is applied, and only a behind database is applied; a control failure stops before the CRM migration and before deploy.
 */
const migrate: Step = async (ctx) => {
  const b = blocked(ctx, 'migrate')
  if (b) return b
  const t = target(ctx)
  const dbs: Db[] = [...(t.control ? [{ label: 'control' as const, binding: 'CONTROL_DB' as const, expected: CONTROL_EXPECTED }] : []), { label: 'crm', binding: 'DB', expected: EXPECTED }]
  const both = t.control !== undefined
  const tag = (db: Db, lines: string[]) => (both ? lines.map((l) => `[${db.label}] ${l}`) : lines)
  const read = async () => {
    const out: { db: Db; applied: string[] | null; status: ReturnType<typeof statusOf> }[] = []
    for (const db of dbs) {
      const applied = parseTrackerOutput((await run(ctx, trackerCommand(t.env, db.binding))).stdout)
      out.push({ db, applied, status: statusOf(applied, db.expected) })
    }
    return out
  }
  const before = await read()
  const ahead = before.find((x) => x.status === 'ahead')
  if (ahead) {
    return result('migrate', 'fail', `the ${both ? `${ahead.db.label} ` : ''}database has migrations this build does not know: deploy a newer build, do not migrate`, before.flatMap((x) => tag(x.db, formatMigrationDiff(x.applied, x.db.expected))))
  }
  const diff = (rows: typeof before) => rows.flatMap((x) => tag(x.db, formatMigrationDiff(x.applied, x.db.expected)))
  if (before.every((x) => x.status === 'current')) return result('migrate', 'ok', both ? `${CONTROL_EXPECTED.length} control and ${EXPECTED.length} CRM migrations applied` : `${EXPECTED.length} migrations applied`)
  if (ctx.opts.dryRun) {
    ctx.pending = true
    return result('migrate', 'update', `would apply: ${both ? before.map((x) => `${x.db.label} ${x.status}`).join(', ') : before[0]!.status}`, diff(before))
  }
  for (const x of before) {
    if (x.status === 'current') continue
    for (const cmd of migrateStepCommands(t.env, x.db.binding)) {
      const r = await run(ctx, cmd)
      if (r.status !== 0) return result('migrate', 'fail', `${both ? `${x.db.label} ` : ''}${cmd.args.slice(2, 5).join(' ')} ${cmd.args[5]} failed (exit ${r.status})`)
    }
  }
  const after = await read()
  const notCurrent = after.find((x) => x.status !== 'current')
  if (notCurrent) return result('migrate', 'fail', `${both ? `${notCurrent.db.label} ` : ''}migrations are not current after apply`, diff(after))
  return result('migrate', 'update', 'applied', diff(after))
}

/** The marker's link for this run: `clerk:<issuer>` or `none:<env>` ([[OPS65]] D18). */
const wantedLink = (ctx: Ctx) => (ctx.opts.auth === 'clerk' ? { authProvider: 'clerk', authOrgId: ctx.keys!.issuer } : { authProvider: 'none', authOrgId: ctx.opts.env })

const bootstrap: Step = async (ctx) => {
  const b = blocked(ctx, 'bootstrap')
  if (b) return b
  const t = target(ctx)
  const { opts } = ctx
  const want = wantedLink(ctx)
  const clerk = opts.auth === 'clerk'
  const marker = parseMarkerOutput((await run(ctx, markerCommand(t.env))).stdout)
  if (marker === 'no-table') return opts.dryRun ? result('bootstrap', 'blocked', 'the database is not migrated yet') : result('bootstrap', 'fail', 'the database is not migrated: run migrate first')
  // [[OPS279]] (D7, D9): the control marker is read with the CRM one; a marker that names another organisation is refused before either database is written.
  const control = t.control ? parseControlMarkerOutput((await run(ctx, controlMarkerCommand(t.env))).stdout) : undefined
  if (control === 'no-table') return opts.dryRun ? result('bootstrap', 'blocked', 'the control database is not migrated yet') : result('bootstrap', 'fail', 'the control database is not migrated: run migrate first')
  if (control && (marker === null || control.organizationId !== marker.organizationId)) {
    return result('bootstrap', 'fail', `the control database is already paired with organization ${control.organizationId}, not ${marker === null ? 'this deployment' : marker.organizationId}: it belongs to another deployment`)
  }
  if (marker !== null) {
    if (marker.authProvider !== want.authProvider || marker.authOrgId !== want.authOrgId) {
      return result('bootstrap', 'fail', `the database is marked ${marker.authProvider}:${marker.authOrgId}, not ${want.authProvider}:${want.authOrgId}: it belongs to another deployment`)
    }
    // A Clerk bootstrap always makes the organisation (CORE64 D11); `none` without the operator flags is the marker alone (cycle 1).
    if (!clerk || marker.organizations > 0) {
      const flags = opts.operatorAgent !== undefined
      const mark = `marker ${want.authProvider}:${want.authOrgId} present`
      const done = flags ? `${mark}: bootstrap already ran, so --operator-agent and --key-env were not applied; create another agent key with the bootstrap script (see the README Deploy section)` : mark
      if (control !== null) return result('bootstrap', 'ok', done)
      // An instance bootstrapped before the control database existed: only its control marker is missing.
      const what = `control marker for organization ${marker.organizationId}`
      if (opts.dryRun) {
        ctx.pending = true
        return result('bootstrap', 'create', `would write ${what}`)
      }
      const { d1, control: controlD1, dispose } = await ctx.deps.openD1(opts.env)
      void d1
      try {
        if (!controlD1) return result('bootstrap', 'fail', 'the control database is not bound in the instance proxy')
        await writeControlMarker(openControlDb(controlD1), marker.organizationId)
        return result('bootstrap', 'create', `wrote ${what}`)
      } finally {
        await dispose()
      }
    }
  }
  const operator = opts.operatorAgent !== undefined
  if (operator && new RegExp(`^\\s*(export\\s+)?${opts.keyEnv}=`, 'm').test(ctx.deps.readEnvText())) {
    return result('bootstrap', 'fail', `${opts.keyEnv} is already set in .env: refusing to overwrite a key`)
  }
  const mark = `marker ${want.authProvider}:${want.authOrgId}`
  const ctl = t.control ? ', control marker' : ''
  const what = clerk
    ? `${marker ? 'organisation' : `${mark}, organisation`} ${opts.org}${operator ? `, operator agent ${opts.operatorAgent} (key to .env as ${opts.keyEnv})` : ''}${ctl}, no human (the owner arrives by invitation)`
    : operator
      ? `${mark}, organisation ${opts.org}, operator agent ${opts.operatorAgent} (key to .env as ${opts.keyEnv})${ctl}`
      : `${mark}${ctl}`
  if (opts.dryRun) {
    ctx.pending = true
    return result('bootstrap', 'create', `would write ${what}`)
  }
  const { d1, control: controlD1, dispose } = await ctx.deps.openD1(opts.env)
  try {
    if (t.control && !controlD1) return result('bootstrap', 'fail', 'the control database is not bound in the instance proxy')
    const controlDb = t.control ? openControlDb(controlD1!) : undefined
    const link = { organizationId: marker?.organizationId ?? uuidv7(), ...want }
    if (marker === null) {
      const probe = await probeBatchAtomicity(d1, link)
      if (probe === 'not-atomic') return result('bootstrap', 'fail', 'atomicity probe failed (a failed batch left a row): stopping')
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
    try {
      ctx.deps.appendEnvVar(opts.keyEnv!, r.key)
    } catch {
      return result('bootstrap', 'fail', `the API key could not be written to .env; it is lost: revoke api key ${r.apiKeyId} and create a new one`)
    }
    ctx.keyWritten = true
    return result('bootstrap', 'create', `wrote ${what}`, [`agent_id: ${r.agentId}`, `api_key_id: ${r.apiKeyId}`, `api_key: written to .env as ${opts.keyEnv} (not shown)`])
  } finally {
    await dispose()
  }
}

async function readHealth(ctx: Ctx): Promise<{ version?: string; migrations?: string } | null> {
  try {
    const res = await ctx.deps.fetch(`https://${ctx.opts.apiHost}/health`)
    if (res.status !== 200) return null
    const j = (await res.json()) as { version?: unknown; migrations?: { status?: unknown } }
    return { version: typeof j.version === 'string' ? j.version : undefined, migrations: typeof j.migrations?.status === 'string' ? j.migrations.status : undefined }
  } catch {
    return null
  }
}

/**
 * Decision (OPS65 cycle 1): `deploy` is `ok` when `/health.version` equals the full `git rev-parse HEAD`, the value `deploy:remote`
 * would stamp as `VERSION` ([[OPS4]] D12). `/health` that cannot be read counts as not deployed. A real deploy needs a clean tree.
 */
const deploy: Step = async (ctx) => {
  const b = blocked(ctx, 'deploy')
  if (b) return b
  const t = target(ctx)
  const head = await run(ctx, gitHead())
  const sha = head.stdout.trim()
  if (head.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) return result('deploy', 'fail', 'could not read the commit (git rev-parse HEAD failed)')
  const health = await readHealth(ctx)
  if (health?.version === sha) {
    ctx.expectSha = sha
    return result('deploy', 'ok', `/health already reports ${sha.slice(0, 12)}`)
  }
  const seen = health?.version ? health.version.slice(0, 12) : 'no answer'
  if (ctx.opts.dryRun) {
    ctx.pending = true
    ctx.expectSha = sha
    return result('deploy', 'update', `would deploy ${sha.slice(0, 12)} (/health: ${seen})`)
  }
  const status = await run(ctx, gitStatus())
  if (status.status !== 0 || status.stdout.trim() !== '') return result('deploy', 'fail', 'the working tree is not clean: commit or stash first (deploy stamps the commit sha)')
  for (const cmd of deployStepCommands(t.env, sha)) {
    const r = await run(ctx, cmd)
    if (r.status !== 0) return result('deploy', 'fail', `${cmd.args.includes('deploy') ? 'wrangler deploy' : cmd.args.slice(-1)[0]} failed (exit ${r.status})`)
  }
  ctx.expectSha = sha
  return result('deploy', 'update', `deployed ${sha.slice(0, 12)} (was ${seen})`)
}

/** The secrets the Worker needs with `--auth clerk` (D3, D12): the Clerk secret key and the derived signing key. */
const CLERK_SECRET_NAMES = ['CLERK_SECRET_KEY', 'CLERK_JWT_KEY'] as const

/**
 * Decision (OPS87): secrets go in after the deploy with `wrangler secret bulk --env <name>` and JSON on stdin ([[OPS65]] D12). Present ones
 * (`wrangler secret list`) are left alone without `--rotate-secrets`; the signing key is derived (a read) only when something is put.
 * Decision (OPS150, D41): the Gmail secrets join the same bulk, on `--auth none` too; `CREDENTIALS_KEY` is put only when absent, never rotated.
 */
const secrets: Step = async (ctx) => {
  const b = blocked(ctx, 'secrets')
  if (b) return b
  const clerk = ctx.opts.auth === 'clerk'
  const names: string[] = [...(clerk ? CLERK_SECRET_NAMES : []), ...(ctx.gmail ? GMAIL_SECRET_NAMES : [])]
  if (names.length === 0) return result('secrets', 'ok', 'no secrets for this configuration (--auth none, no Gmail group)')
  const t = target(ctx)
  const list = await run(ctx, secretListCommand(t.env))
  if (list.status !== 0) {
    return ctx.opts.dryRun && ctx.pending
      ? result('secrets', 'blocked', 'waits on the Worker planned above (wrangler secret list needs it to exist)')
      : result('secrets', 'fail', `wrangler secret list failed (exit ${list.status}): is the Worker deployed?`)
  }
  const present = parseSecretList(list.stdout)
  const put = names.filter((n) => (n === NEVER_REPLACED && ctx.gmail ? !present.includes(n) : ctx.opts.rotateSecrets || !present.includes(n)))
  const kept = ctx.gmail && ctx.opts.rotateSecrets && present.includes(NEVER_REPLACED) ? [`${NEVER_REPLACED} kept: stored credentials are encrypted under it (rotate through CREDENTIALS_KEY_VERSION, not setup)`] : []
  if (put.length === 0) return result('secrets', 'ok', `${names.join(' and ')} are present (--rotate-secrets replaces them${ctx.gmail ? `, except ${NEVER_REPLACED}` : ''})`, kept.length ? kept : undefined)
  const rotating = put.filter((n) => present.includes(n))
  const status = rotating.length === put.length ? 'update' : 'create'
  if (ctx.opts.dryRun) return result('secrets', status, `would put ${put.join(', ')}`, kept.length ? kept : undefined)
  const values: Record<string, string> = {}
  if (put.includes('CLERK_SECRET_KEY')) values.CLERK_SECRET_KEY = ctx.keys!.secretKey
  if (put.includes('CLERK_JWT_KEY')) values.CLERK_JWT_KEY = await signingKeyPem(ctx)
  for (const n of GMAIL_SECRET_NAMES) if (put.includes(n)) values[n] = ctx.gmail!.secrets[n]!
  const r = await run(ctx, secretBulkCommand(t.env, JSON.stringify(values)))
  if (r.status !== 0) return result('secrets', 'fail', `wrangler secret bulk failed (exit ${r.status})`)
  return result('secrets', status, `put ${put.join(', ')}`, kept.length ? kept : undefined)
}

type Marker = Awaited<ReturnType<typeof readMarker>>
async function readMarker(ctx: Ctx) {
  try {
    return parseMarkerOutput((await run(ctx, markerCommand(target(ctx).env))).stdout)
  } catch {
    return null
  }
}

/** D39: the repair hint is a command that works on the env it is printed for. */
function repairLines(ctx: Ctx, marker: Marker): string[] {
  const { opts } = ctx
  const want = wantedLink(ctx)
  const none = `CONFIRM_REMOTE=1 pnpm -C packages/server-d1 bootstrap -- --remote --env ${opts.env} --key-env <NAME> --org <name> --auth-provider none --auth-org-id ${opts.env} --email <email> --agent <name>`
  const clerk = `CONFIRM_REMOTE=1 pnpm -C packages/server-d1 bootstrap -- --remote --env ${opts.env} --key-env <NAME> --org <name> --issuer ${want.authOrgId} --agent <name>`
  if (marker !== null && marker !== 'no-table' && (marker.authProvider !== want.authProvider || marker.authOrgId !== want.authOrgId)) {
    return [`the database is marked ${marker.authProvider}:${marker.authOrgId}, not ${want.authProvider}:${want.authOrgId}: it belongs to another deployment`]
  }
  if (marker !== null && marker !== 'no-table' && marker.organizations > 0) {
    return [`this env is bootstrapped; create agents and keys through agents.create and api_keys.create on /meta/v1 (${opts.auth === 'clerk' ? 'after vibase login' : 'with an existing owner key'})`]
  }
  return ['no operator key was created in this run; to create an agent and key:', `  ${opts.auth === 'clerk' ? clerk : none}`]
}

/** `/.well-known/vibase` `auth` must equal what setup configured ([[OPS65]] D21). */
async function checkDiscovery(ctx: Ctx): Promise<string | null> {
  const expectedIssuer = ctx.keys!.issuer
  const expectedClient = ctx.cliClientId ?? configuredCliClientId(ctx.deps.readConfigText(), ctx.opts.env)
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
  if (auth.issuer !== expectedIssuer) bad.push(`auth.issuer is ${String(auth.issuer)}, setup configured ${expectedIssuer}`)
  if (expectedClient === undefined) bad.push('auth.cli_client_id cannot be compared: AUTH_CLI_CLIENT_ID is not in wrangler.jsonc (run the clerk step)')
  else if (auth.cli_client_id !== expectedClient) bad.push(`auth.cli_client_id is ${String(auth.cli_client_id)}, setup configured ${expectedClient}`)
  return bad.length ? `/.well-known/vibase disagrees: ${bad.join('; ')}` : null
}

/**
 * Decision (OPS65 cycle 1): the sha `verify` waits for is HEAD only when `deploy` ran in the same invocation; run alone
 * (`--only verify`, or after a no-op `--only` set without deploy) it requires `migrations.status = current` and reports the sha it found.
 * Decision (OPS87): with `--auth clerk` it then compares `/.well-known/vibase` (D21) and prints the next steps with the manual rows.
 */
const verify: Step = async (ctx) => {
  const b = blocked(ctx, 'verify')
  if (b) return b
  const ready = (h: Awaited<ReturnType<typeof readHealth>>) => h !== null && h.migrations === 'current' && (ctx.expectSha === undefined || h.version === ctx.expectSha)
  let health = await readHealth(ctx)
  if (ctx.opts.dryRun) {
    if (!ready(health)) return ctx.pending ? result('verify', 'blocked', 'waits on the changes planned above') : result('verify', 'fail', `https://${ctx.opts.apiHost}/health is not at the expected version with migrations current`)
  } else {
    const start = ctx.deps.now()
    while (!ready(health) && ctx.deps.now() - start < VERIFY_BOUND_MS) {
      await ctx.deps.sleep(VERIFY_INTERVAL_MS)
      health = await readHealth(ctx)
    }
    if (!ready(health)) {
      const seen = health === null ? 'no answer' : `version ${health.version ?? '?'}, migrations ${health.migrations ?? '?'}`
      return result('verify', 'fail', `https://${ctx.opts.apiHost}/health did not become current within ${VERIFY_BOUND_MS / 1000}s (${seen})`)
    }
  }
  const detail = `https://${ctx.opts.apiHost}/health is current (${health!.version?.slice(0, 12) ?? 'no version'})`
  if (ctx.opts.auth === 'clerk') {
    const mismatch = await checkDiscovery(ctx)
    if (mismatch) return result('verify', 'fail', mismatch)
  }
  const clerk = ctx.opts.auth === 'clerk'
  const hint = ctx.keyWritten ? [`agents use the operator key in .env (${ctx.opts.keyEnv}) as a Bearer token`] : repairLines(ctx, await readMarker(ctx))
  const next = [
    `API: https://${ctx.opts.apiHost}`,
    ...(clerk
      ? [
          `accept the owner invitation Clerk emailed to ${ctx.opts.ownerEmail}`,
          `vibase login --server https://${ctx.opts.apiHost}`,
          'GET /meta/v1/me must show role: owner (this is the C3 check: a missing vibase_role session-token claim refuses the sign-in)',
          ...(ctx.manualRows ?? []).map((m) => `manual ${m}`),
        ]
      : []),
    ...hint,
  ]
  return result('verify', 'ok', detail, next)
}

export const STEPS: Record<StepName, Step> = {
  preflight,
  'config:resources': configResources,
  clerk: clerkStep,
  'config:write': configWrite,
  migrate,
  bootstrap,
  deploy,
  secrets,
  verify,
}

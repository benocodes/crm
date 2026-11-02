// The steps of `setup:remote` ([[OPS65]] D7, D11): each reads the current state, compares it with the desired one and reports
// `ok` / `create` / `update` / `fail` (or `blocked`); a real run then makes the change. Nothing here logs a credential or the operator key.
import { parse } from 'jsonc-parser'
import { bootstrapD1, probeBatchAtomicity } from '../../src/bootstrap-d1.js'
import { initDeploymentOperation } from '../../src/init-deployment.js'
import { execute, uuidv7 } from '@vault/storage'
import { MIGRATIONS, d1Binding } from '@vault/storage-d1'
import { PLACEHOLDER_DATABASE_ID, RemoteRefusal, formatMigrationDiff, resolveTarget, statusOf, type ConfigLike, type Target } from '../remote.js'
import { reconcileEnvBlock, type DesiredEnv } from './config-editor.js'
import {
  d1CreateCommand,
  d1ListCommand,
  deployStepCommands,
  gitHead,
  gitStatus,
  isWriteCommand,
  markerCommand,
  migrateStepCommands,
  parseD1List,
  parseMarkerOutput,
  parseR2List,
  parseTrackerOutput,
  r2CreateCommand,
  r2ListCommand,
  trackerCommand,
} from './commands.js'
import type { Credentials, ExecResult, SetupCmd, SetupDeps, SetupOptions, StepName, StepResult } from './types.js'

const EXPECTED = MIGRATIONS.map((m) => m.name)
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

const cfGet = (ctx: Ctx, path: string) => ctx.deps.fetch(`${CF}${path}`, { headers: { authorization: `Bearer ${ctx.creds.apiToken}` } })

const preflight: Step = async (ctx) => {
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
  const facts = await readFacts(ctx)
  const planned: string[] = []
  const lines: string[] = []
  const { d1Name, r2Name } = ctx.opts
  if (!facts.d1s.some((d) => d.name === d1Name)) {
    planned.push(`D1 ${d1Name}`)
    if (!ctx.opts.dryRun) {
      const r = await run(ctx, d1CreateCommand(d1Name))
      if (r.status !== 0) return result('config:resources', 'fail', `wrangler d1 create ${d1Name} failed (exit ${r.status})`, [r.stderr.trim()].filter(Boolean))
      await readFacts(ctx, true)
      if (!ctx.facts!.d1s.some((d) => d.name === d1Name)) return result('config:resources', 'fail', `D1 ${d1Name} was created but is not in wrangler d1 list`)
    }
  }
  if (!ctx.facts!.r2s.includes(r2Name)) {
    planned.push(`R2 ${r2Name}`)
    if (!ctx.opts.dryRun) {
      const r = await run(ctx, r2CreateCommand(r2Name))
      if (r.status !== 0) return result('config:resources', 'fail', `wrangler r2 bucket create ${r2Name} failed (exit ${r.status})`, [r.stderr.trim()].filter(Boolean))
    }
  }
  lines.push(`D1 ${d1Name}: ${planned.includes(`D1 ${d1Name}`) ? (ctx.opts.dryRun ? 'would create' : 'created') : 'exists'}`)
  lines.push(`R2 ${r2Name}: ${planned.includes(`R2 ${r2Name}`) ? (ctx.opts.dryRun ? 'would create' : 'created') : 'exists'}`)
  if (planned.length === 0) return result('config:resources', 'ok', `D1 ${d1Name} and R2 ${r2Name} exist`)
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
  const created = facts.d1s.find((d) => d.name === ctx.opts.d1Name)
  const desired: DesiredEnv = {
    env: ctx.opts.env,
    workerName: ctx.opts.workerName,
    d1Name: ctx.opts.d1Name,
    d1Id: created?.uuid ?? PLACEHOLDER_DATABASE_ID,
    r2Name: ctx.opts.r2Name,
    apiHost: ctx.opts.apiHost,
    corsOrigins: ctx.opts.origins.join(','),
  }
  const before = ctx.deps.readConfigText()
  const r = reconcileEnvBlock(before, desired)
  if (r.mismatches.length > 0) {
    return result('config:write', 'fail', `wrangler.jsonc differs from the desired value at ${r.mismatches.join(', ')}; it is never overwritten: fix it or the flag`, r.mismatches.map((k) => `differs: ${k}`))
  }
  if (r.changed.length === 0) return result('config:write', 'ok', `env.${ctx.opts.env} in wrangler.jsonc is as desired`)
  const diff = lineDiff(before, r.text)
  if (ctx.opts.dryRun) {
    ctx.pending = true
    ctx.blockedBy = 'config:write'
    return result('config:write', 'update', `would write ${r.changed.join(', ')}`, diff)
  }
  ctx.deps.writeConfigText(r.text)
  ctx.stop = true
  return result('config:write', 'update', `wrote ${r.changed.join(', ')}`, [...diff, 'review and commit wrangler.jsonc, then re-run the same command to migrate, bootstrap, deploy and verify'])
}

const blocked = (ctx: Ctx, step: StepName): StepResult | null =>
  ctx.blockedBy ? result(step, 'blocked', `waits on ${ctx.blockedBy} (nothing is evaluated until the config is written and committed)`) : null

const migrate: Step = async (ctx) => {
  const b = blocked(ctx, 'migrate')
  if (b) return b
  const t = target(ctx)
  const applied = async () => parseTrackerOutput((await run(ctx, trackerCommand(t.env))).stdout)
  const before = await applied()
  const status = statusOf(before, EXPECTED)
  if (status === 'current') return result('migrate', 'ok', `${EXPECTED.length} migrations applied`)
  if (status === 'ahead') return result('migrate', 'fail', 'the database has migrations this build does not know: deploy a newer build, do not migrate', formatMigrationDiff(before, EXPECTED))
  if (ctx.opts.dryRun) {
    ctx.pending = true
    return result('migrate', 'update', `would apply: ${status}`, formatMigrationDiff(before, EXPECTED))
  }
  for (const cmd of migrateStepCommands(t.env)) {
    const r = await run(ctx, cmd)
    if (r.status !== 0) return result('migrate', 'fail', `${cmd.args.slice(2, 5).join(' ')} ${cmd.args[5]} failed (exit ${r.status})`)
  }
  const after = await applied()
  if (statusOf(after, EXPECTED) !== 'current') return result('migrate', 'fail', 'migrations are not current after apply', formatMigrationDiff(after, EXPECTED))
  return result('migrate', 'update', 'applied', formatMigrationDiff(after, EXPECTED))
}

const bootstrap: Step = async (ctx) => {
  const b = blocked(ctx, 'bootstrap')
  if (b) return b
  const t = target(ctx)
  const { opts } = ctx
  const marker = parseMarkerOutput((await run(ctx, markerCommand(t.env))).stdout)
  if (marker === 'no-table') return opts.dryRun ? result('bootstrap', 'blocked', 'the database is not migrated yet') : result('bootstrap', 'fail', 'the database is not migrated: run migrate first')
  if (marker !== null) {
    if (marker.authProvider === 'none' && marker.authOrgId === opts.env) {
      const flags = opts.operatorAgent !== undefined
      return result('bootstrap', 'ok', flags ? `marker none:${opts.env} present: bootstrap already ran, so --operator-agent and --key-env were not applied; create another agent key with the bootstrap script (see the README Deploy section)` : `marker none:${opts.env} present`)
    }
    return result('bootstrap', 'fail', `the database is marked ${marker.authProvider}:${marker.authOrgId}, not none:${opts.env}: it belongs to another deployment`)
  }
  const operator = opts.operatorAgent !== undefined
  if (operator && new RegExp(`^\\s*(export\\s+)?${opts.keyEnv}=`, 'm').test(ctx.deps.readEnvText())) {
    return result('bootstrap', 'fail', `${opts.keyEnv} is already set in .env: refusing to overwrite a key`)
  }
  const what = operator ? `marker none:${opts.env}, organisation ${opts.org}, operator agent ${opts.operatorAgent} (key to .env as ${opts.keyEnv})` : `marker none:${opts.env}`
  if (opts.dryRun) {
    ctx.pending = true
    return result('bootstrap', 'create', `would write ${what}`)
  }
  const { d1, dispose } = await ctx.deps.openD1(opts.env)
  try {
    const link = { organizationId: uuidv7(), authProvider: 'none', authOrgId: opts.env }
    const probe = await probeBatchAtomicity(d1, link)
    if (probe === 'not-atomic') return result('bootstrap', 'fail', 'atomicity probe failed (a failed batch left a row): stopping')
    if (!operator) {
      await execute(d1Binding(d1, link), { kind: 'internal', organizationId: link.organizationId }, initDeploymentOperation(link))
      return result('bootstrap', 'create', `wrote ${what}`)
    }
    const r = await bootstrapD1(d1, { organizationName: opts.org, email: opts.ownerEmail, agentName: opts.operatorAgent!, authProvider: 'none', authOrgId: opts.env, organizationId: link.organizationId })
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

/**
 * Decision (OPS65 cycle 1): the sha `verify` waits for is HEAD only when `deploy` ran in the same invocation; run alone
 * (`--only verify`, or after a no-op `--only` set without deploy) it requires `migrations.status = current` and reports the sha it found.
 */
const verify: Step = async (ctx) => {
  const b = blocked(ctx, 'verify')
  if (b) return b
  const ready = (h: Awaited<ReturnType<typeof readHealth>>) => h !== null && h.migrations === 'current' && (ctx.expectSha === undefined || h.version === ctx.expectSha)
  let health = await readHealth(ctx)
  if (ctx.opts.dryRun) {
    if (ready(health)) return result('verify', 'ok', `https://${ctx.opts.apiHost}/health is current (${health!.version?.slice(0, 12) ?? 'no version'})`)
    return ctx.pending ? result('verify', 'blocked', 'waits on the changes planned above') : result('verify', 'fail', `https://${ctx.opts.apiHost}/health is not at the expected version with migrations current`)
  }
  const start = ctx.deps.now()
  while (!ready(health) && ctx.deps.now() - start < VERIFY_BOUND_MS) {
    await ctx.deps.sleep(VERIFY_INTERVAL_MS)
    health = await readHealth(ctx)
  }
  if (!ready(health)) {
    const seen = health === null ? 'no answer' : `version ${health.version ?? '?'}, migrations ${health.migrations ?? '?'}`
    return result('verify', 'fail', `https://${ctx.opts.apiHost}/health did not become current within ${VERIFY_BOUND_MS / 1000}s (${seen})`)
  }
  const repair = `CONFIRM_REMOTE=1 pnpm -C packages/server-d1 bootstrap -- --remote --env ${ctx.opts.env} --key-env <NAME> --org <name> --auth-provider none --auth-org-id ${ctx.opts.env} --email <email> --agent <name>`
  const next = [`API: https://${ctx.opts.apiHost}`, ...(ctx.keyWritten ? [`agents use the operator key in .env (${ctx.opts.keyEnv}) as a Bearer token`] : ['no operator key was created in this run; to create an agent and key:', `  ${repair}`])]
  return result('verify', 'ok', `https://${ctx.opts.apiHost}/health is current (${health!.version?.slice(0, 12) ?? 'no version'})`, next)
}

export const STEPS: Record<StepName, Step> = {
  preflight,
  'config:resources': configResources,
  'config:write': configWrite,
  migrate,
  bootstrap,
  deploy,
  verify,
}

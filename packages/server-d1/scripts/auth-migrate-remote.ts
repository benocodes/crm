// `CONFIRM_REMOTE=1 pnpm -C packages/server-d1 auth:migrate:remote -- plan --env <name> [--plan <path>] [--dry-run]` ([[OPS365]], [[OPS250]] D2, D3) and `apply --env <name> [--plan <path>] [--dry-run]` ([[OPS392]], [[OPS393]]): moving a Clerk instance onto Better Auth.
// `plan` reads the Clerk instance (Backend API, GET only) and both D1 databases (wrangler, SELECT and Time Travel info only) and writes the reviewable plan file that apply and revert (#394) consume. Nothing is written but the plan file.
// `claim --env <name> [--plan <path>] [--email <address>] [--dry-run]` ([[OPS397]]) prints one reset link per migrated person and per relinked agent account, and the caps of the disabled delegated agents; it writes only the links' verification and audit rows.
// `apply` opens the two remote databases and runs: checks, fresh export, control batch, `AUTH_SECRET`, the deploy with the provider switched, and then the CRM batch (P1). A refusal exits 1 before any write; a failure after a write began exits 2.
// `revert --env <name> [--plan <path>] [--dry-run]` ([[OPS394]]) undoes an applied migration: the CRM batch first, then the guarded deploy; the operator has committed the revert of the config switch first. Nothing in the control database is written.
// A source script, not part of the release bin ([[OPS250]] "Tooling home").
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, parseEnv } from 'node:util'
import { unstable_readConfig } from 'wrangler'
import {
  CONTROL_MIGRATIONS,
  MIGRATIONS,
  openControlDb,
  readControlMarker,
  readMigrationState,
  type D1Like,
} from '@vibase/storage-d1'
import { uuidv7 } from '@vibase/storage'
import { ApplyFailure, ApplyRefusal, applyBatches, assessRun, describePlan, exitCodeFor } from './auth-migrate/apply.js'
import { ClaimRefusal, claim } from './auth-migrate/claim.js'
import { assessRevert, claimedAccounts, describeRevert, insertedMemberships, revertCrm, revertLine } from './auth-migrate/revert.js'
import { classify } from './auth-migrate/classify.js'
import { exportClerkUsers } from './auth-migrate/clerk-export.js'
import { AGENTS_SQL, MEMBERSHIPS_SQL, USERS_SQL, readCrmExport } from './auth-migrate/crm-export.js'
import type { AuthPlan, PlanDatabase, Snapshot } from './auth-migrate/types.js'
import {
  CONFIG_PATH,
  PACKAGE_DIR,
  REPO_ROOT,
  ROOT_ENV_PATH,
  RemoteRefusal,
  loadRemoteEnv,
  requireConfirm,
  requireControlTarget,
  resolveTarget,
  type Cmd,
  type ConfigLike,
} from './remote.js'
import { createWorkspaceAuthAdapter } from '@vibase/api'
import { parseBuiltInAuthConfig, AUTH_SECRET_MIN_LENGTH } from '../src/auth-config.js'
import { readDeployment } from '../src/init-deployment.js'
import { realDeployDeps, requireCleanTree, runDeploy } from './deploy.js'
import { remoteProxyOptions } from './bootstrap.js'
import { loadBetterAuth, newAuthSecret, providerFromVars } from './setup/better-auth.js'
import { appendEnvFileVar, probeEnvFile } from './setup/env-file.js'
import type { EnvFileProbe } from './setup/types.js'

export const USAGE =
  'usage: CONFIRM_REMOTE=1 pnpm -C packages/server-d1 auth:migrate:remote -- plan|apply|claim|revert --env <name> [--plan <path>] [--dry-run] (claim also takes --email <address>)'

export interface PlanDeps {
  /** Loads the Cloudflare credentials (and refuses when they are missing). */
  loadEnv(envName: string): void
  readConfig(envName: string): ConfigLike & { vars?: Record<string, unknown> }
  /** The instance's own env file `.env.<env>`, where `CLERK_SECRET_KEY` is read from and from nowhere else. */
  readInstanceEnv(envName: string): EnvFileProbe
  exec(cmd: Cmd): { status: number | null; stdout: string }
  fetch: typeof fetch
  /** Does the path exist? */
  exists(path: string): boolean
  /** Is the path inside the repository checkout and not ignored by git? */
  repoPathNotIgnored(path: string): boolean
  /** Runs git in the checkout (the clean-tree guard, shared with the deploy). */
  git(args: string[]): { status: number | null; stdout: string }
  /** Opens the instance's remote CRM and control databases for `fn` and closes them after ([[OPS393]]; the way `bootstrap --owner-reset` opens them). */
  withDatabases<T>(envName: string, fn: (dbs: { crm: D1Like; control: D1Like }) => Promise<T>): Promise<T>
  /** Runs one writing command with `input` on its stdin (`wrangler secret put`); returns its exit status. */
  run(cmd: Cmd, input?: string): number | null
  /** Appends `NAME=value` to the instance's own env file, never over a line that is there, mode 600. */
  appendEnvVar(envName: string, name: string, value: string): void
  /** The guarded deploy (`deploy:remote`'s own path); returns its exit status. */
  deploy(envName: string, procEnv: NodeJS.ProcessEnv): number | null
  /** The text of a file (the plan file `apply` reads); throws when it is missing or unreadable. */
  readText(path: string): string
  /** Creates the file exclusively (never over an existing one) with the mode, and its directory when missing. */
  writeNew(path: string, text: string, mode: number): void
  now(): Date
  newId(): string
  log(line: string): void
  error(line: string): void
}

/** P3: beside the instance settings of [[OPS210]] D10, outside the checkout. */
export function defaultPlanPath(envName: string, procEnv: NodeJS.ProcessEnv, home: string): string {
  const root = procEnv.XDG_CONFIG_HOME ? procEnv.XDG_CONFIG_HOME : join(home, '.config')
  return join(root, 'vibase', 'instances', `${envName}.auth-plan.json`)
}

/** Appends `NAME=value` to the instance's own env file (never over a line that is there) and leaves it mode 600: the file holds secrets ([[OPS393]] P4). */
export function appendInstanceVar(
  file: string | undefined,
  envName: string,
  name: string,
  value: string,
  repoRoot: string,
  rootEnvPath: string,
): void {
  appendEnvFileVar(file, envName, name, value, repoRoot, rootEnvPath)
  const given = file ?? `.env.${envName}`
  chmodSync(isAbsolute(given) ? given : resolve(repoRoot, given), 0o600)
}

export const realFileDeps: Pick<PlanDeps, 'exists' | 'repoPathNotIgnored' | 'writeNew' | 'readText'> = {
  exists: (path) => existsSync(path),
  readText: (path) => readFileSync(path, 'utf8'),
  repoPathNotIgnored(path) {
    const rel = relative(REPO_ROOT, resolve(path))
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false // outside the checkout
    return spawnSync('git', ['check-ignore', '-q', '--', resolve(path)], { cwd: REPO_ROOT }).status !== 0
  },
  writeNew(path, text, mode) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, text, { flag: 'wx', mode })
    chmodSync(path, mode)
  },
}

export const realDeps: PlanDeps = {
  ...realFileDeps,
  loadEnv: (envName) => loadRemoteEnv(envName),
  readConfig: (envName) =>
    unstable_readConfig({ config: CONFIG_PATH, env: envName }) as unknown as ConfigLike & {
      vars?: Record<string, unknown>
    },
  readInstanceEnv: (envName) => probeEnvFile(undefined, envName, REPO_ROOT, ROOT_ENV_PATH),
  exec: (cmd) => {
    const r = spawnSync(cmd.command, cmd.args, {
      cwd: PACKAGE_DIR,
      encoding: 'utf-8',
      env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
    })
    return { status: r.status, stdout: r.stdout ?? '' }
  },
  fetch: (input, init) => globalThis.fetch(input, init),
  git: (args) => {
    const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
    return { status: r.status, stdout: r.stdout ?? '' }
  },
  withDatabases: async (envName, fn) => {
    const { getPlatformProxy } = await import('wrangler')
    const proxy = await getPlatformProxy<{ DB: D1Like; CONTROL_DB: D1Like }>(remoteProxyOptions(envName))
    try {
      return await fn({ crm: proxy.env.DB, control: proxy.env.CONTROL_DB })
    } finally {
      await proxy.dispose()
    }
  },
  run: (cmd, input) => {
    const r = spawnSync(cmd.command, cmd.args, {
      cwd: PACKAGE_DIR,
      encoding: 'utf-8',
      input,
      env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
    })
    if (r.status !== 0 && r.stderr) process.stderr.write(r.stderr)
    return r.status
  },
  appendEnvVar: (envName, name, value) => appendInstanceVar(undefined, envName, name, value, REPO_ROOT, ROOT_ENV_PATH),
  deploy: (envName, procEnv) => runDeploy(['--env', envName], procEnv, realDeployDeps),
  now: () => new Date(),
  newId: () => uuidv7(),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
}

interface PlanArgs {
  sub: 'plan' | 'apply' | 'claim' | 'revert'
  env: string
  plan: string | undefined
  dryRun: boolean
  /** claim only: limit the run to one target */
  email: string | undefined
}
function parsePlanArgs(argv: string[]): PlanArgs {
  let parsed: ReturnType<
    typeof parseArgs<{
      options: {
        env: { type: 'string' }
        plan: { type: 'string' }
        'dry-run': { type: 'boolean' }
        email: { type: 'string' }
      }
      allowPositionals: true
    }>
  >
  try {
    parsed = parseArgs({
      args: argv.filter((a) => a !== '--'),
      strict: true,
      allowPositionals: true,
      options: {
        env: { type: 'string' },
        plan: { type: 'string' },
        'dry-run': { type: 'boolean' },
        email: { type: 'string' },
      },
    })
  } catch (e) {
    throw new RemoteRefusal(`${e instanceof Error ? e.message : 'bad arguments'}; ${USAGE}`)
  }
  const [sub, ...rest] = parsed.positionals
  if ((sub !== 'plan' && sub !== 'apply' && sub !== 'claim' && sub !== 'revert') || rest.length > 0)
    throw new RemoteRefusal(`only the plan, apply, claim and revert subcommands exist; ${USAGE}`)
  if (!parsed.values.env) throw new RemoteRefusal(`--env <name> is required; ${USAGE}`)
  if (parsed.values.email !== undefined && sub !== 'claim')
    throw new RemoteRefusal(`--email limits a claim run: only the claim subcommand takes it; ${USAGE}`)
  return {
    sub,
    env: parsed.values.env,
    plan: parsed.values.plan,
    dryRun: parsed.values['dry-run'] === true,
    email: parsed.values.email,
  }
}

const wranglerD1 = (...args: string[]): Cmd => ({ command: 'pnpm', args: ['exec', 'wrangler', 'd1', ...args] })

/** Time Travel's current bookmark of one database: `wrangler d1 time-travel info <name> --json` prints `{ "bookmark": "..." }` (wrangler 4.149). */
function readBookmark(deps: PlanDeps, envName: string, databaseName: string): string {
  const r = deps.exec(wranglerD1('time-travel', 'info', databaseName, '--env', envName, '--json'))
  if (r.status !== 0) throw new Error(`wrangler d1 time-travel info failed for ${databaseName}`)
  const bookmark = (JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) as { bookmark?: unknown }).bookmark
  if (typeof bookmark !== 'string' || bookmark === '')
    throw new Error(`unexpected output from wrangler d1 time-travel info for ${databaseName}`)
  return bookmark
}

function summary(plan: AuthPlan): string {
  const n = <T>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length
  return `plan: ${plan.people.length} people (${n(plan.people, (p) => p.action === 'migrate')} migrate, ${n(plan.people, (p) => p.action === 'none')} none), ${plan.agents.length} agents (${n(plan.agents, (a) => a.action === 'keep')} keep, ${n(plan.agents, (a) => a.action === 'relink')} relink, ${n(plan.agents, (a) => a.action === 'disable')} disable), ${plan.clerk_only.length} Clerk-only users (none)`
}

/** What both commands check before any wrangler or Clerk call: the record names a control database and a Clerk instance, and the instance's own env file holds the Clerk key. */
function resolveInstance(envName: string, deps: PlanDeps, command: 'plan' | 'apply' | 'revert' = 'plan') {
  deps.loadEnv(envName)
  const config = deps.readConfig(envName)
  const target = requireControlTarget(config, envName)
  const provider = providerFromVars(config.vars, `wrangler.jsonc env ${envName}`)
  if (command === 'plan') {
    // P2 of [[OPS365]]: only a Clerk instance has a Clerk to migrate from.
    if (provider !== 'clerk')
      throw new RemoteRefusal(
        `env ${envName} runs AUTH_PROVIDER ${provider}: the migration plan reads a clerk instance only`,
      )
    return target
  }
  if (command === 'revert') {
    // [[OPS394]] P2: the way back is the operator's committed `git revert` of the apply-time config commit, so the block must already be a Clerk one the Worker would accept (the secrets are placeholders: the block is what is judged).
    if (provider !== 'clerk')
      throw new RemoteRefusal(
        `the provider switch back is not committed: env ${envName} still runs AUTH_PROVIDER ${provider}. git revert the commit that switched wrangler.jsonc's env block to Better Auth (it must be committed), then run revert again`,
      )
    const vars = Object.fromEntries(
      Object.entries(config.vars ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'),
    )
    try {
      createWorkspaceAuthAdapter({
        ...vars,
        CLERK_JWT_KEY: 'placeholder-jwt-key',
        CLERK_SECRET_KEY: 'placeholder-secret-key',
      })
    } catch (e) {
      throw new RemoteRefusal(
        `env ${envName}'s block does not parse as a Clerk config: ${e instanceof Error ? e.message : 'invalid'}. Fix it in wrangler.jsonc and commit, then run revert again`,
      )
    }
    return target
  }
  // [[OPS393]] P2: the provider switch is the operator's commit, so the block must already be a Better Auth one (the guarded deploy needs a clean tree; nothing here edits the file).
  if (provider !== 'better-auth')
    throw new RemoteRefusal(
      `the provider switch is not committed: env ${envName} still runs AUTH_PROVIDER ${provider}. Set AUTH_PROVIDER=better-auth and PUBLIC_BASE_URL in wrangler.jsonc's env block and commit it, then run apply again`,
    )
  const vars = Object.fromEntries(
    Object.entries(config.vars ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'),
  )
  try {
    parseBuiltInAuthConfig({ ...vars, AUTH_SECRET: 'x'.repeat(AUTH_SECRET_MIN_LENGTH) }) // the secret is a placeholder: the block is what is judged
  } catch (e) {
    throw new RemoteRefusal(
      `env ${envName}'s block does not parse as a Better Auth config: ${e instanceof Error ? e.message : 'invalid'}. Fix it in wrangler.jsonc and commit, then run apply again`,
    )
  }
  return target
}
function readSecretKey(envName: string, deps: PlanDeps): string {
  const file = deps.readInstanceEnv(envName)
  if (file.status === 'root-env')
    throw new RemoteRefusal(
      `${file.display} is the root .env, which holds another instance's values: use the instance's own file (.env.${envName})`,
    )
  if (file.status === 'missing')
    throw new RemoteRefusal(
      `${file.display} does not exist: it holds this instance's CLERK_SECRET_KEY, which the plan needs`,
    )
  if (file.status === 'not-ignored')
    throw new RemoteRefusal(`${file.display} is not ignored by git: add it to .gitignore before it holds a secret`)
  const secretKey = parseEnv(file.text ?? '').CLERK_SECRET_KEY?.trim()
  if (!secretKey) throw new RemoteRefusal(`CLERK_SECRET_KEY is not set in ${file.display}`)
  return secretKey
}
/** The normalized export, read-only: every Clerk user and the CRM's identity rows. */
async function readSnapshot(envName: string, secretKey: string, deps: PlanDeps): Promise<Snapshot> {
  const clerk_users = await exportClerkUsers({ secretKey, fetch: deps.fetch })
  const rows = readCrmExport((sql) => {
    const r = deps.exec(wranglerD1('execute', 'DB', '--remote', '--env', envName, '--json', '--command', sql))
    if (r.status !== 0) throw new Error('wrangler d1 execute failed')
    return r.stdout
  })
  return { clerk_users, ...rows }
}

/** The same export through the opened CRM handle ([[OPS393]]): the three SELECTs run there and go through the same normalizer as `plan`'s. */
async function readSnapshotFrom(crm: D1Like, secretKey: string, deps: PlanDeps): Promise<Snapshot> {
  const clerk_users = await exportClerkUsers({ secretKey, fetch: deps.fetch })
  const answers = new Map<string, string>()
  for (const sql of [USERS_SQL, AGENTS_SQL, MEMBERSHIPS_SQL])
    answers.set(sql, JSON.stringify([{ results: (await crm.prepare(sql).all()).results ?? [], success: true }]))
  return { clerk_users, ...readCrmExport((sql) => answers.get(sql)!) }
}

/** The plan command. Every refusal is raised before the first wrangler or Clerk call. */
async function runPlan(args: PlanArgs, procEnv: NodeJS.ProcessEnv, deps: PlanDeps): Promise<void> {
  requireConfirm(procEnv)
  const envName = args.env
  const target = resolveInstance(envName, deps)
  const secretKey = readSecretKey(envName, deps)

  // P3: the plan is never overwritten and never lands in the checkout unless git ignores it.
  const planPath = resolve(args.plan ?? defaultPlanPath(envName, procEnv, homedir()))
  if (!args.dryRun) {
    if (deps.exists(planPath))
      throw new RemoteRefusal(
        `${planPath} already exists: a plan is never overwritten (move it, or pass another --plan)`,
      )
    if (deps.repoPathNotIgnored(planPath))
      throw new RemoteRefusal(
        `${planPath} is inside the repository and not ignored by git: pick a path outside it, or an ignored one`,
      )
  }

  deps.log(
    `target: env ${target.env}, database ${target.databaseName} (${target.databaseId}), control database ${target.control.databaseName} (${target.control.databaseId})`,
  )
  // Bookmarks first: the plan names the point in time just before the reads, so a revert can return to it.
  const crm: PlanDatabase = {
    database_name: target.databaseName,
    database_id: target.databaseId,
    bookmark: readBookmark(deps, envName, target.databaseName),
  }
  const control: PlanDatabase = {
    database_name: target.control.databaseName,
    database_id: target.control.databaseId,
    bookmark: readBookmark(deps, envName, target.control.databaseName),
  }
  const snapshot = await readSnapshot(envName, secretKey, deps)
  const plan: AuthPlan = {
    version: 1,
    env: envName,
    created_at: deps.now().toISOString(),
    crm,
    control,
    ...classify(snapshot, deps.newId),
    snapshot,
  }
  deps.log(summary(plan))
  if (args.dryRun) {
    deps.log('dry run: no plan file written')
    return
  }
  deps.writeNew(planPath, `${JSON.stringify(plan, null, 2)}\n`, 0o600)
  deps.log(`plan written to ${planPath} (mode 600)`)
}

/** P3: the plan file is read and checked against the instance before any wrangler or Clerk call. */
function readPlanFile(
  path: string,
  envName: string,
  target: ReturnType<typeof requireControlTarget>,
  deps: PlanDeps,
): AuthPlan {
  let text: string
  try {
    text = deps.readText(path)
  } catch {
    throw new RemoteRefusal(`the plan file ${path} is missing or unreadable (run plan first, or pass --plan <path>)`)
  }
  let plan: AuthPlan
  try {
    plan = JSON.parse(text) as AuthPlan
  } catch {
    throw new RemoteRefusal(`the plan file ${path} is unreadable: it is not valid JSON`)
  }
  if (
    plan === null ||
    typeof plan !== 'object' ||
    typeof plan.crm !== 'object' ||
    typeof plan.control !== 'object' ||
    typeof plan.snapshot !== 'object'
  )
    throw new RemoteRefusal(`the plan file ${path} is unreadable: it is not a plan file`)
  if (plan.version !== 1)
    throw new RemoteRefusal(`the plan file has version ${String(plan.version)}; this apply reads version 1`)
  if (plan.env !== envName)
    throw new RemoteRefusal(`the plan file was made for env ${String(plan.env)}, not ${envName}`)
  const expected = [
    ['CRM', plan.crm, target.databaseName, target.databaseId],
    ['control', plan.control, target.control.databaseName, target.control.databaseId],
  ] as const
  for (const [which, db, name, id] of expected)
    if (db?.database_name !== name || db?.database_id !== id)
      throw new RemoteRefusal(
        `the plan file names the ${which} database ${String(db?.database_name)} (${String(db?.database_id)}), not the record's ${name} (${id}): it is another instance's plan`,
      )
  return plan
}

/** P3: neither database has a pending migration, and the control database is paired with the CRM's organisation (the condition the Worker's control gate checks). Each failure is a refusal naming its remedy. */
async function requireReady(envName: string, crm: D1Like, control: D1Like): Promise<void> {
  const migrate = `CONFIRM_REMOTE=1 pnpm -C packages/server-d1 db:migrate:remote -- --env ${envName}`
  for (const [which, d1, names] of [
    ['CRM', crm, MIGRATIONS.map((m) => m.name)],
    ['control', control, CONTROL_MIGRATIONS.map((m) => m.name)],
  ] as const) {
    const state = await readMigrationState(d1, names)
    if (state.readFailed) throw new Error(`could not read the ${which} database's migration tracker`)
    if (state.status !== 'current' && state.status !== 'ahead')
      throw new RemoteRefusal(`the ${which} database has pending migrations (${state.status}): run ${migrate} first`)
  }
  const link = await readDeployment(crm)
  if (!link) throw new RemoteRefusal('the CRM database has no deployment row: it is not an initialised instance')
  const marker = await readControlMarker(openControlDb(control))
  if (!marker || marker.organizationId !== link.organizationId)
    throw new RemoteRefusal(
      `the control database is not paired with this CRM's organisation: the Better Auth Worker would refuse every request (control database not paired). Run CONFIRM_REMOTE=1 pnpm -C packages/server-d1 setup:remote -- --env ${envName} ...`,
    )
}

/**
 * `apply`: the guards, the plan file, the pre-write checks (P2, P3), a fresh export and the state check, then (without `--dry-run`) the control batch, `AUTH_SECRET`, the deploy and the CRM batch, in that order (P1).
 * Everything up to and including the state check is read-only and runs under `--dry-run` too.
 */
async function runApply(args: PlanArgs, procEnv: NodeJS.ProcessEnv, deps: PlanDeps): Promise<void> {
  requireConfirm(procEnv)
  const envName = args.env
  const target = resolveInstance(envName, deps, 'apply')
  // 393.15: the deploy needs a clean tree, so an uncommitted provider switch is a refusal now, not a failure after the control batch
  requireCleanTree(deps.git, 'commit the provider switch (and anything else) in wrangler.jsonc, then run apply again')
  const planPath = resolve(args.plan ?? defaultPlanPath(envName, procEnv, homedir()))
  const plan = readPlanFile(planPath, envName, target, deps)
  const secretKey = readSecretKey(envName, deps)
  const file = deps.readInstanceEnv(envName)
  loadBetterAuth({ auth: 'better-auth' }, file.text, file.display) // an AUTH_SECRET the Worker would refuse is a refusal now, before any write
  deps.log(
    `target: env ${target.env}, database ${target.databaseName} (${target.databaseId}), control database ${target.control.databaseName} (${target.control.databaseId})`,
  )
  await deps.withDatabases(envName, async ({ crm, control }) => {
    await requireReady(envName, crm, control)
    const fresh = await readSnapshotFrom(crm, secretKey, deps)
    const link = (await readDeployment(crm))!
    const state = assessRun(plan, fresh, link.authProvider)
    if (state === 'applied') {
      deps.log('state: already applied: the instance is as the plan leaves it, nothing to write')
      return
    }
    deps.log('state: not applied')
    for (const line of describePlan(plan)) deps.log(line)
    if (args.dryRun) {
      deps.log('dry run: nothing written')
      return
    }
    const outcome = await applyBatches({
      plan,
      fresh,
      crm,
      control,
      now: () => deps.now(),
      newId: () => deps.newId(),
      between: () => secretAndDeploy(envName, procEnv, deps),
    })
    deps.log(
      `CRM batch committed: users re-pointed ${outcome.users_repointed}, agents relinked ${outcome.agents_relinked}, agents disabled ${outcome.agents_disabled}, memberships inserted ${outcome.memberships_inserted} (control rows inserted this run: ${outcome.control_inserted})`,
    )
    deps.log(`applied: env ${envName} now runs Better Auth, and the deployment marker says so`)
    deps.log(
      `next: CONFIRM_REMOTE=1 pnpm -C packages/server-d1 auth:migrate:remote -- claim --env ${envName} --plan ${planPath} (claim links for the people and the agent accounts, and the caps of the disabled delegated agents; until then nobody can sign in, and API keys keep working)`,
    )
  })
}

/**
 * `revert` ([[OPS394]] P1-P6): the guards, the Clerk block, the clean tree, the plan file, the migration level, then a fresh export and its state (applied, restored or a refusal). Everything up to and including the state is read-only and runs under `--dry-run` too.
 * Applied: the CRM batch, then the guarded deploy (P1). Restored: no batch, the deploy again. Nothing is written to the control database, a file or a secret (P3, P6).
 */
async function runRevert(args: PlanArgs, procEnv: NodeJS.ProcessEnv, deps: PlanDeps): Promise<void> {
  requireConfirm(procEnv)
  const envName = args.env
  const target = resolveInstance(envName, deps, 'revert')
  requireCleanTree(deps.git, 'commit the revert of the provider switch (and anything else) in wrangler.jsonc, then run revert again')
  const planPath = resolve(args.plan ?? defaultPlanPath(envName, procEnv, homedir()))
  const plan = readPlanFile(planPath, envName, target, deps)
  const secretKey = readSecretKey(envName, deps)
  deps.log(
    `target: env ${target.env}, database ${target.databaseName} (${target.databaseId}), control database ${target.control.databaseName} (${target.control.databaseId})`,
  )
  await deps.withDatabases(envName, async ({ crm, control }) => {
    await requireReady(envName, crm, control)
    const fresh = await readSnapshotFrom(crm, secretKey, deps)
    const link = (await crm.prepare('select organization_id, auth_provider, auth_org_id from deployment').first()) as {
      organization_id: string
      auth_provider: string
      auth_org_id: string
    } | null
    if (!link) throw new RemoteRefusal('the CRM database has no deployment row: it is not an initialised instance')
    const state = assessRevert(plan, fresh, link.auth_provider)
    const inert = await claimedAccounts(plan, control)
    const leftInert = () => {
      for (const email of inert)
        deps.log(
          `left inert: ${email} (a password or Google account in the control database; revert does not touch it, and CORE259 D10's sweep owns it)`,
        )
    }
    if (state === 'restored') {
      deps.log('state: restored: the CRM already matches the plan, no CRM batch is needed')
      if (args.dryRun) {
        deps.log('dry run: nothing written, no deploy')
        leftInert()
        return
      }
    } else {
      deps.log('state: applied')
      deps.log(revertLine(describeRevert(plan, insertedMemberships(plan, fresh))))
      if (args.dryRun) {
        deps.log('dry run: nothing written, no deploy')
        leftInert()
        return
      }
      const outcome = await revertCrm({
        plan,
        fresh,
        crm,
        link,
        now: () => deps.now(),
        newId: () => deps.newId(),
      })
      deps.log(
        `CRM batch committed: users restored ${outcome.users_restored}, agents relinked back ${outcome.agents_relinked_back}, agents re-enabled ${outcome.agents_reenabled}, memberships removed ${outcome.memberships_removed}; the deployment marker reads clerk`,
      )
    }
    deps.log('deploying the Worker from this checkout (the provider is back to Clerk)')
    let status: number | null
    try {
      status = deps.deploy(envName, procEnv)
    } catch (e) {
      throw new ApplyFailure(
        `the deploy was refused (${e instanceof Error ? e.message : 'failed'}): the CRM is already restored; fix it and re-run revert, which deploys`,
      )
    }
    if (status !== 0)
      throw new ApplyFailure(
        `the deploy failed (exit ${status ?? 'none'}): the CRM is already restored; re-run revert, which deploys`,
      )
    leftInert()
    deps.log(`reverted: env ${envName} runs Clerk again, and the deployment marker says so`)
  })
}

/** P1, P4: between the two batches. `AUTH_SECRET` is the instance file's when valid, else generated into it; it reaches the Worker on stdin only. Any failure here is a failure after a write began (exit 2) that a re-run resumes from. */
async function secretAndDeploy(envName: string, procEnv: NodeJS.ProcessEnv, deps: PlanDeps): Promise<void> {
  const file = deps.readInstanceEnv(envName)
  let secret = loadBetterAuth({ auth: 'better-auth' }, file.text, file.display)?.authSecret
  const reused = secret !== undefined
  if (secret === undefined) {
    secret = newAuthSecret()
    try {
      deps.appendEnvVar(envName, 'AUTH_SECRET', secret)
    } catch {
      throw new ApplyFailure(
        `AUTH_SECRET could not be written to ${file.display}, so nothing was put: the control rows are in, the CRM is untouched; re-run apply`,
      )
    }
  }
  const put = deps.run(
    { command: 'pnpm', args: ['exec', 'wrangler', 'secret', 'put', 'AUTH_SECRET', '--env', envName] },
    secret,
  )
  if (put !== 0)
    throw new ApplyFailure(
      `wrangler secret put AUTH_SECRET failed (exit ${put ?? 'none'}): the secret is in ${file.display}, the CRM is untouched; re-run apply`,
    )
  deps.log(
    `AUTH_SECRET: ${reused ? `reused from ${file.display}` : `generated into ${file.display}`} and set on the Worker`,
  )
  deps.log('deploying the Worker with the provider switched (the CRM batch follows)')
  let status: number | null
  try {
    status = deps.deploy(envName, procEnv)
  } catch (e) {
    throw new ApplyFailure(
      `the deploy was refused (${e instanceof Error ? e.message : 'failed'}): the CRM is untouched; fix it and re-run apply`,
    )
  }
  if (status !== 0)
    throw new ApplyFailure(`the deploy failed (exit ${status ?? 'none'}): the CRM is untouched; re-run apply`)
}

/**
 * `claim` ([[OPS397]] P1-P6): the guards, the record, the plan file and `AUTH_SECRET`, then (inside the opened databases) the applied check, and only then the targets. Every refusal is raised before a write, `--dry-run` included.
 * It writes only the reset links' verification and audit rows in the control database: never the CRM, a file or a command.
 */
async function runClaim(args: PlanArgs, procEnv: NodeJS.ProcessEnv, deps: PlanDeps): Promise<void> {
  requireConfirm(procEnv)
  const envName = args.env
  deps.loadEnv(envName)
  const config = deps.readConfig(envName)
  const resolved = resolveTarget(config, envName)
  if (!resolved.control)
    throw new RemoteRefusal(
      `claim needs a control database: env ${envName} has no CONTROL_DB binding, and a Better Auth instance keeps its accounts there`,
    )
  const target = resolved as ReturnType<typeof requireControlTarget>
  const provider = providerFromVars(config.vars, `wrangler.jsonc env ${envName}`)
  if (provider !== 'better-auth')
    throw new RemoteRefusal(
      `claim needs a better-auth instance: env ${envName} runs AUTH_PROVIDER ${provider}. Run apply first, with the provider switch committed`,
    )
  const publicBaseUrl = config.vars?.PUBLIC_BASE_URL
  if (typeof publicBaseUrl !== 'string' || publicBaseUrl === '')
    throw new RemoteRefusal(
      `claim needs PUBLIC_BASE_URL in wrangler.jsonc's env ${envName} block: it is the origin of the links`,
    )
  const planPath = resolve(args.plan ?? defaultPlanPath(envName, procEnv, homedir()))
  const plan = readPlanFile(planPath, envName, target, deps)
  const secretKey = readSecretKey(envName, deps)
  const file = deps.readInstanceEnv(envName)
  const authSecret = parseEnv(file.text ?? '').AUTH_SECRET?.trim()
  if (!authSecret)
    throw new RemoteRefusal(
      `claim needs AUTH_SECRET in ${file.display}: it composes Better Auth as the Worker does (apply put it there). If the Worker has one, copy it in; a new value would sign everyone out`,
    )
  if (authSecret.length < AUTH_SECRET_MIN_LENGTH)
    throw new RemoteRefusal(
      `AUTH_SECRET in ${file.display} is shorter than ${AUTH_SECRET_MIN_LENGTH} characters: it is not the value the Worker holds`,
    )
  deps.log(
    `target: env ${target.env}, database ${target.databaseName} (${target.databaseId}), control database ${target.control.databaseName} (${target.control.databaseId})`,
  )
  await deps.withDatabases(envName, async ({ crm, control }) => {
    const link = await readDeployment(crm)
    if (!link) throw new RemoteRefusal('the CRM database has no deployment row: it is not an initialised instance')
    const fresh = await readSnapshotFrom(crm, secretKey, deps)
    let state: ReturnType<typeof assessRun>
    try {
      state = assessRun(plan, fresh, link.authProvider)
    } catch (e) {
      if (e instanceof ApplyRefusal) throw new ClaimRefusal(`claim needs an applied instance: ${e.message}`)
      throw e
    }
    if (state !== 'applied')
      throw new ClaimRefusal(
        `claim needs an applied instance: this one is not applied yet. Run CONFIRM_REMOTE=1 pnpm -C packages/server-d1 auth:migrate:remote -- apply --env ${envName} --plan ${planPath} first`,
      )
    await claim({
      plan,
      crm,
      control,
      authSecret,
      baseUrl: publicBaseUrl.replace(/\/+$/, ''),
      email: args.email,
      dryRun: args.dryRun,
      now: () => deps.now(),
      newId: () => deps.newId(),
      log: (l) => deps.log(l),
    })
  })
}

/** Returns the exit code: 0 done or already applied, 1 refused (or a read failed) before any write, 2 failed after a write began (apply, claim and revert, [[OPS393]] P5, [[OPS397]] P6, [[OPS394]] P5). */
export async function runAuthMigrate(argv: string[], procEnv: NodeJS.ProcessEnv, deps: PlanDeps): Promise<number> {
  try {
    const args = parsePlanArgs(argv)
    await (args.sub === 'apply'
      ? runApply
      : args.sub === 'claim'
        ? runClaim
        : args.sub === 'revert'
          ? runRevert
          : runPlan)(args, procEnv, deps)
    return 0
  } catch (e) {
    deps.error(`auth-migrate: ${e instanceof Error ? e.message : 'failed'}`)
    return e instanceof ApplyRefusal || e instanceof ApplyFailure ? exitCodeFor(e) : 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runAuthMigrate(process.argv.slice(2), process.env, realDeps)
}

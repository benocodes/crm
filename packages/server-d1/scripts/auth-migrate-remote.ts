// `CONFIRM_REMOTE=1 pnpm -C packages/server-d1 auth:migrate:remote -- plan --env <name> [--plan <path>] [--dry-run]` ([[OPS365]], [[OPS250]] D2, D3), and `apply --env <name> [--plan <path>] --dry-run` ([[OPS392]]): the read side of moving a Clerk instance onto Better Auth.
// It reads the Clerk instance (Backend API, GET only) and both D1 databases (wrangler, SELECT and Time Travel info only) and writes the reviewable plan file that apply (#392) and revert (#394) consume.
// A source script, not part of the release bin ([[OPS250]] "Tooling home"). Nothing is written but the plan file; a refusal exits 1 before any call.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, parseEnv } from 'node:util'
import { unstable_readConfig } from 'wrangler'
import type { D1Like } from '@vibase/storage-d1'
import { uuidv7 } from '@vibase/storage'
import { ApplyFailure, ApplyRefusal, assessState, describePlan, exitCodeFor } from './auth-migrate/apply.js'
import { classify } from './auth-migrate/classify.js'
import { exportClerkUsers } from './auth-migrate/clerk-export.js'
import { readCrmExport } from './auth-migrate/crm-export.js'
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
  type Cmd,
  type ConfigLike,
} from './remote.js'
import { providerFromVars } from './setup/better-auth.js'
import { probeEnvFile } from './setup/env-file.js'
import type { EnvFileProbe } from './setup/types.js'

export const USAGE =
  'usage: CONFIRM_REMOTE=1 pnpm -C packages/server-d1 auth:migrate:remote -- plan|apply --env <name> [--plan <path>] [--dry-run] (apply needs --dry-run until #393)'

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

/** Appends `NAME=value` to the instance's own env file and leaves it mode 600 (stub: [[OPS393]] P4 builds it). */
export function appendInstanceVar(
  _file: string | undefined,
  _envName: string,
  _name: string,
  _value: string,
  _repoRoot: string,
  _rootEnvPath: string,
): void {
  throw new Error('not implemented')
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
  withDatabases: () => Promise.reject(new Error('not wired yet')),
  run: () => 1,
  appendEnvVar: () => undefined,
  deploy: () => 1,
  now: () => new Date(),
  newId: () => uuidv7(),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
}

interface PlanArgs {
  sub: 'plan' | 'apply'
  env: string
  plan: string | undefined
  dryRun: boolean
}
function parsePlanArgs(argv: string[]): PlanArgs {
  let parsed: ReturnType<
    typeof parseArgs<{
      options: { env: { type: 'string' }; plan: { type: 'string' }; 'dry-run': { type: 'boolean' } }
      allowPositionals: true
    }>
  >
  try {
    parsed = parseArgs({
      args: argv.filter((a) => a !== '--'),
      strict: true,
      allowPositionals: true,
      options: { env: { type: 'string' }, plan: { type: 'string' }, 'dry-run': { type: 'boolean' } },
    })
  } catch (e) {
    throw new RemoteRefusal(`${e instanceof Error ? e.message : 'bad arguments'}; ${USAGE}`)
  }
  const [sub, ...rest] = parsed.positionals
  if ((sub !== 'plan' && sub !== 'apply') || rest.length > 0)
    throw new RemoteRefusal(`only the plan and apply subcommands exist so far (revert is #394); ${USAGE}`)
  if (!parsed.values.env) throw new RemoteRefusal(`--env <name> is required; ${USAGE}`)
  return { sub, env: parsed.values.env, plan: parsed.values.plan, dryRun: parsed.values['dry-run'] === true }
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
function resolveInstance(envName: string, deps: PlanDeps) {
  deps.loadEnv(envName)
  const config = deps.readConfig(envName)
  const target = requireControlTarget(config, envName)
  // P2: only a Clerk instance has a Clerk to migrate from.
  const provider = providerFromVars(config.vars, `wrangler.jsonc env ${envName}`)
  if (provider !== 'clerk')
    throw new RemoteRefusal(
      `env ${envName} runs AUTH_PROVIDER ${provider}: the migration plan reads a clerk instance only`,
    )
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

/**
 * `apply --dry-run`: the guards, the plan file, a fresh read-only export and the state check, then what each batch would write. Nothing is written.
 * Without `--dry-run` it refuses before any call: the batches exist ([[OPS392]]) but the provider switch they must be followed by is #393's, and batches alone would leave the instance on Clerk with re-pointed subjects.
 */
async function runApply(args: PlanArgs, procEnv: NodeJS.ProcessEnv, deps: PlanDeps): Promise<void> {
  requireConfirm(procEnv)
  if (!args.dryRun)
    throw new RemoteRefusal(
      'apply without --dry-run is not available yet: the provider switch is not built (#393), and the batches alone would leave the instance on Clerk with re-pointed subjects. Use --dry-run',
    )
  const envName = args.env
  const target = resolveInstance(envName, deps)
  const planPath = resolve(args.plan ?? defaultPlanPath(envName, procEnv, homedir()))
  const plan = readPlanFile(planPath, envName, target, deps)
  const secretKey = readSecretKey(envName, deps)
  deps.log(
    `target: env ${target.env}, database ${target.databaseName} (${target.databaseId}), control database ${target.control.databaseName} (${target.control.databaseId})`,
  )
  const fresh = await readSnapshot(envName, secretKey, deps)
  const state = assessState(plan, fresh)
  if (state === 'applied') {
    deps.log('state: already applied: the instance is as the plan leaves it, nothing to write')
    return
  }
  deps.log('state: not applied')
  for (const line of describePlan(plan)) deps.log(line)
  deps.log('dry run: nothing written')
}

/** Returns the exit code: 0 done, 1 refused or failed, 2 failed after a write began (apply, #393 wires it). */
export async function runAuthMigrate(argv: string[], procEnv: NodeJS.ProcessEnv, deps: PlanDeps): Promise<number> {
  try {
    const args = parsePlanArgs(argv)
    await (args.sub === 'apply' ? runApply : runPlan)(args, procEnv, deps)
    return 0
  } catch (e) {
    deps.error(`auth-migrate: ${e instanceof Error ? e.message : 'failed'}`)
    return e instanceof ApplyRefusal || e instanceof ApplyFailure ? exitCodeFor(e) : 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runAuthMigrate(process.argv.slice(2), process.env, realDeps)
}

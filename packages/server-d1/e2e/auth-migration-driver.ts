// The test-only driver of the auth migration E2E ([[OPS397]], [[OPS394]]): the REAL `plan`, `apply`, `claim` and `revert` code (`runAuthMigrate`) driven against a local Worker and a local D1 pair. It swaps EVERY dependency that only exists remotely or on the operator's machine:
//  - `withDatabases` opens the local Worker's persisted D1 pair (`getPlatformProxy` over the persist directory);
//  - `exec` answers `time-travel info` with a fixed bookmark and runs the export's SELECTs with `wrangler d1 execute --local`;
//  - `deploy` and `run` (`wrangler secret put AUTH_SECRET` is captured, not run) switch the local Worker to the provider the committed record names (Clerk to Better Auth for `apply`, back to Clerk for `revert`): it is started again, on the new variables, once the command has closed its databases. `deploy` is the faked seam of both directions; its real counterpart (the guarded `deploy:remote`) is the operator's check on `hq`, and `revert` makes no `secret put`, so `run` stays refused for it;
//  - `readConfig` returns an in-memory record (a `clerk` block for `plan` and `revert`, a `better-auth` one for `apply` and `claim`) instead of reading the committed env block of `wrangler.jsonc`: the operator's committed `git revert` of the config switch is `record = 'clerk'` here, and the real Clerk-config parse of `revert` runs on that block;
//  - `git` answers a clean tree, so apply's clean-tree check never sees a real tree;
//  - `appendEnvVar` and `readInstanceEnv` use a temp env file (`.env.e2e`), not the instance's `.env.<env>`.
// `loadEnv`, `fetch` (the real Clerk Backend API), `now`, `newId` and the file deps are the real ones. The Worker runs on plain `http://localhost:<port>` (Better Auth accepts `http://localhost`; no CLI login is run here, so the HTTPS recipe of `writing-tests` section 7 is not needed), started with `--env-file`.
// Why the Worker is stopped around every command: it and the command would otherwise open the same SQLite files in two processes. The shipped command gets no `--local` flag; everything else it does is its own code.
// Nothing here is part of the shipped package: it lives under `e2e/`, outside the gate.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPlatformProxy } from 'wrangler'
import { openControlDb, type D1Like } from '@vibase/storage-d1'
import { bootstrapD1 } from '../src/bootstrap-d1.js'
import { appendInstanceVar, realFileDeps, runAuthMigrate, type PlanDeps } from '../scripts/auth-migrate-remote.js'
import { uuidv7 } from '@vibase/storage'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const CONFIG = join(PKG, 'wrangler.jsonc')
const CRM_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const CTL_ID = '9f8e7d6c-5b4a-4398-8765-4321fedcba98'
export const ENV_NAME = 'e2e'
const BOOKMARK = '00000001-0000000a-00004e20-e2e000000000000000000000000000aa'

export interface ClerkKeys {
  secretKey: string
  publishableKey: string
  issuer: string
  /** The PEM public key, as `.env.dev` holds it (one line, `\n` escapes). */
  jwtKey: string
}

export class LocalInstance {
  readonly base: string
  private readonly state: string
  private readonly persist: string
  private readonly envFile: string
  private worker: ChildProcess | undefined
  /** What the committed record says: `plan` and `revert` read a `clerk` record, `apply` and `claim` a `better-auth` one (the operator's commits). */
  record: 'clerk' | 'better-auth' = 'clerk'
  /** What the running Worker is configured for; `deploy` moves it. */
  workerMode: 'clerk' | 'better-auth' = 'clerk'
  private authSecret: string | undefined
  operatorKey: string | undefined
  readonly logLines: string[] = []

  constructor(
    readonly dir: string,
    readonly port: number,
    private readonly clerk: ClerkKeys,
  ) {
    this.base = `http://localhost:${port}`
    this.state = join(dir, 'state')
    this.persist = join(this.state, 'v3')
    this.envFile = join(dir, '.env.e2e')
    mkdirSync(this.persist, { recursive: true })
    writeFileSync(this.envFile, `CLERK_SECRET_KEY=${clerk.secretKey}\n`, { mode: 0o600 })
  }

  private wrangler(args: string[]) {
    return spawnSync('pnpm', ['exec', 'wrangler', ...args], {
      cwd: PKG,
      encoding: 'utf8',
      env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
    })
  }

  /** Both local databases migrated, and the Clerk deployment bootstrapped (it writes the control marker) with an API-key agent. */
  async setUp(): Promise<void> {
    for (const binding of ['DB', 'CONTROL_DB']) {
      const r = this.wrangler(['d1', 'migrations', 'apply', binding, '--local', '--persist-to', this.state])
      if (r.status !== 0) throw new Error(`migrations apply ${binding} failed: ${r.stderr}`)
    }
    const proxy = await getPlatformProxy<{ DB: D1Like; CONTROL_DB: D1Like }>({
      configPath: CONFIG,
      persist: { path: this.persist },
      remoteBindings: false,
    })
    try {
      const r = await bootstrapD1(
        proxy.env.DB,
        { organizationName: 'E2E', authProvider: 'clerk', authOrgId: this.clerk.issuer, agentName: 'operator' },
        { control: openControlDb(proxy.env.CONTROL_DB) },
      )
      this.operatorKey = r.key ?? undefined
    } finally {
      await proxy.dispose()
    }
  }

  private workerVars(): Record<string, string> {
    if (this.workerMode === 'clerk')
      return {
        AUTH_PROVIDER: 'clerk',
        CLERK_ISSUER: this.clerk.issuer,
        CLERK_AUTHORIZED_PARTIES: this.base,
        CLERK_PUBLISHABLE_KEY: this.clerk.publishableKey,
        CLERK_JWT_KEY: this.clerk.jwtKey,
        CLERK_SECRET_KEY: this.clerk.secretKey,
      }
    if (!this.authSecret) throw new Error('the Worker was asked to run on better-auth before apply put AUTH_SECRET')
    return { AUTH_PROVIDER: 'better-auth', AUTH_SECRET: this.authSecret, PUBLIC_BASE_URL: this.base }
  }

  async startWorker(): Promise<void> {
    if (this.worker) return
    const file = join(this.dir, 'worker.env')
    // double quotes: dotenv expands the `\n` escapes of the PEM
    writeFileSync(
      file,
      Object.entries(this.workerVars())
        .map(([k, v]) => `${k}="${v.replace(/\n/g, '\\n')}"`)
        .join('\n') + '\n',
      { mode: 0o600 },
    )
    const child = spawn(
      'pnpm',
      [
        'exec',
        'wrangler',
        'dev',
        '--local',
        '--port',
        String(this.port),
        '--persist-to',
        this.state,
        '--env-file',
        file,
        '--show-interactive-dev-session=false',
      ],
      {
        cwd: PKG,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
      },
    )
    const keep = (b: Buffer) => this.logLines.push(...b.toString().split('\n').filter(Boolean))
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    this.worker = child
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`the Worker exited early: ${this.logLines.slice(-10).join('\n')}`)
      try {
        const res = await fetch(`${this.base}/.well-known/vibase`)
        if (res.ok) return
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error(`the Worker did not come up: ${this.logLines.slice(-10).join('\n')}`)
  }

  async stopWorker(): Promise<void> {
    const child = this.worker
    if (!child) return
    this.worker = undefined
    const done = new Promise<void>((r) => child.once('exit', () => r()))
    try {
      process.kill(-child.pid!, 'SIGTERM')
    } catch {
      /* already gone */
    }
    await Promise.race([done, new Promise((r) => setTimeout(r, 10_000))])
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      /* gone */
    }
  }

  /** A SELECT on one local database, read the way the export reads (`wrangler d1 execute --local`). */
  sql(binding: 'DB' | 'CONTROL_DB', query: string): Array<Record<string, any>> {
    const r = this.wrangler([
      'd1',
      'execute',
      binding,
      '--local',
      '--persist-to',
      this.state,
      '--json',
      '--command',
      query,
    ])
    if (r.status !== 0) throw new Error(`d1 execute failed: ${r.stderr}`)
    return (JSON.parse(r.stdout.slice(r.stdout.indexOf('[\n'))) as Array<{ results: Array<Record<string, any>> }>)[0]!
      .results
  }

  /** One command of the real script, with the Worker stopped around it and started again, on the Worker mode `deploy` may have moved, after it. */
  async run(
    argv: string[],
    env: NodeJS.ProcessEnv = { CONFIRM_REMOTE: '1' },
  ): Promise<{ code: number; out: string[]; err: string[] }> {
    await this.stopWorker()
    const out: string[] = []
    const err: string[] = []
    const deps: PlanDeps = {
      ...realFileDeps,
      loadEnv: () => {},
      readConfig: () => ({
        name: 'vb-e2e',
        d1_databases: [
          { binding: 'DB', database_name: 'vb-crm-e2e', database_id: CRM_ID, remote: true },
          { binding: 'CONTROL_DB', database_name: 'vb-control-e2e', database_id: CTL_ID, remote: true },
        ],
        vars:
          this.record === 'clerk'
            ? { AUTH_PROVIDER: 'clerk', CLERK_ISSUER: this.clerk.issuer }
            : { AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: this.base },
      }),
      readInstanceEnv: () => ({ display: '.env.e2e', status: 'ok', text: readFileSync(this.envFile, 'utf8') }),
      exec: (cmd) => {
        const a = cmd.args
        if (a.includes('time-travel')) return { status: 0, stdout: JSON.stringify({ bookmark: BOOKMARK }) }
        if (a.includes('execute')) {
          const r = this.wrangler([
            'd1',
            'execute',
            a[a.indexOf('execute') + 1]!,
            '--local',
            '--persist-to',
            this.state,
            '--json',
            '--command',
            a[a.indexOf('--command') + 1]!,
          ])
          return { status: r.status, stdout: r.stdout.slice(Math.max(0, r.stdout.indexOf('[\n'))) }
        }
        return { status: 1, stdout: '' }
      },
      fetch: (input, init) => globalThis.fetch(input, init),
      git: (args) => ({ status: 0, stdout: args[0] === 'status' ? '' : 'e2e\n' }),
      withDatabases: async (_env, fn) => {
        const proxy = await getPlatformProxy<{ DB: D1Like; CONTROL_DB: D1Like }>({
          configPath: CONFIG,
          persist: { path: this.persist },
          remoteBindings: false,
        })
        try {
          return await fn({ crm: proxy.env.DB, control: proxy.env.CONTROL_DB })
        } finally {
          await proxy.dispose()
        }
      },
      run: (cmd, input) => {
        if (cmd.args.join(' ').includes('secret put AUTH_SECRET')) {
          this.authSecret = input?.trim()
          return 0
        }
        return 1
      },
      appendEnvVar: (envName, name, value) =>
        appendInstanceVar(this.envFile, envName, name, value, this.dir, join(this.dir, 'root.env')),
      deploy: () => {
        this.workerMode = this.record // the committed record is what the guarded deploy ships
        return 0
      },
      now: () => new Date(),
      newId: () => uuidv7(),
      log: (l) => void out.push(l),
      error: (l) => void err.push(l),
    }
    try {
      const code = await runAuthMigrate(argv, env, deps)
      return { code, out, err }
    } finally {
      await this.startWorker()
    }
  }

  async tearDown(): Promise<void> {
    await this.stopWorker()
    rmSync(this.dir, { recursive: true, force: true })
  }
}

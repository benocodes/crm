// [[OPS307]] D9, D10 on the source twin `bootstrap --remote --env <name> --owner-reset`: the shared suite, then its arguments, its guards (CONFIRM_REMOTE, the instance's own `.env.<env>`) and exit codes.
// P6: bootstrap's refusals and failures both exit 1; there is no dry run on this path.
import { describe, expect, it } from 'vitest'
import { runOwnerResetRemote, type OwnerResetRemoteDeps } from './bootstrap-owner-reset.js'
import { ownerResetSuite, BASE, SECRET, type Driver, type RunOptions } from './owner-reset.suite.js'

const UUID = '0f5a1c2e-3b4d-4e6f-8a9b-1c2d3e4f5a6b'
const CTL = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

function deps(o: RunOptions, over: Partial<OwnerResetRemoteDeps> = {}): OwnerResetRemoteDeps & { out: string[]; err: string[] } {
  const r = o.record ?? {}
  const provider = r.provider ?? 'better-auth'
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    loadEnv: () => {},
    readConfig: () => ({
      name: 'vb-demo',
      d1_databases: [
        { binding: 'DB', database_name: 'vb-crm-demo', database_id: UUID, remote: true },
        ...(r.control === false ? [] : [{ binding: 'CONTROL_DB', database_name: 'vb-control-demo', database_id: CTL, remote: true }]),
      ],
      vars: { AUTH_PROVIDER: provider === 'none' ? '' : provider, ...(r.baseUrl === null ? {} : { PUBLIC_BASE_URL: r.baseUrl ?? BASE }) },
    }),
    readInstanceEnv: () => ({ display: '.env.demo', status: 'ok', text: `CLOUDFLARE_ACCOUNT_ID=x\n${r.secret === null ? '' : `AUTH_SECRET=${r.secret ?? SECRET}\n`}` }),
    getPlatformProxy: async () => ({ env: { DB: o.crm, CONTROL_DB: o.control }, dispose: async () => {} }),
    log: (l) => void out.push(l),
    error: (l) => void err.push(l),
    ...over,
  }
}

const driver: Driver = {
  refused: 1,
  failed: 1,
  dryRun: false,
  async run(o) {
    const d = deps(o)
    const code = await runOwnerResetRemote(['--remote', '--env', 'demo', '--owner-reset', ...(o.email ? ['--email', o.email] : [])], { CONFIRM_REMOTE: '1' }, d)
    return { code, out: d.out, err: d.err }
  },
}
ownerResetSuite('bootstrap --remote --owner-reset', () => driver, { dryRun: false })

describe('bootstrap --owner-reset: arguments and guards', () => {
  const run = async (argv: string[], env: NodeJS.ProcessEnv = { CONFIRM_REMOTE: '1' }, over: Partial<OwnerResetRemoteDeps> = {}) => {
    const d = deps({ crm: {} as never, control: {} as never }, { getPlatformProxy: async () => { throw new Error('the proxy must not be opened') }, ...over })
    const code = await runOwnerResetRemote(argv, env, d)
    return { code, text: [...d.out, ...d.err].join('\n') }
  }
  it('needs --remote and --env, and refuses every flag that belongs to a bootstrap run', async () => {
    for (const argv of [['--owner-reset'], ['--remote', '--owner-reset'], ['--env', 'demo', '--owner-reset'], ['--remote', '--env', 'demo', '--owner-reset', '--org', 'x'], ['--remote', '--env', 'demo', '--owner-reset', '--key-env', 'K'], ['--remote', '--env', 'demo', '--owner-reset', '--dry-run']]) {
      const r = await run(argv)
      expect(r.code, argv.join(' ')).toBe(1)
      expect(r.text).toContain('bootstrap')
    }
  })
  it('needs CONFIRM_REMOTE=1 before anything is read or opened', async () => {
    const r = await run(['--remote', '--env', 'demo', '--owner-reset'], {})
    expect(r.code).toBe(1)
    expect(r.text).toContain('CONFIRM_REMOTE=1')
  })
  it('the instance env file: missing, not ignored by git or the root .env are each refused, naming the file and never a value', async () => {
    for (const status of ['missing', 'not-ignored', 'root-env'] as const) {
      const r = await run(['--remote', '--env', 'demo', '--owner-reset'], { CONFIRM_REMOTE: '1' }, { readInstanceEnv: () => ({ display: '.env.demo', status }) })
      expect(r.code, status).toBe(1)
      expect(r.text).toContain('.env.demo')
    }
  })
  it('an env whose config is the placeholder is refused through resolveTarget', async () => {
    const r = await run(['--remote', '--env', 'demo', '--owner-reset'], { CONFIRM_REMOTE: '1' }, { readConfig: () => ({ name: 'vb-demo', d1_databases: [] }) })
    expect(r.code).toBe(1)
    expect(r.text).toMatch(/DB binding/)
  })
})

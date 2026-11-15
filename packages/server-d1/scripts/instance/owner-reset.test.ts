// [[OPS307]] D9, D10 on `vibase-server owner-reset`: the shared suite (refusals and targeting, the reset link, the no-owner invitation), then what only this front-end has: its arguments, its exit codes,
// the CONFIRM_REMOTE rule and its place in the help text. Settings and secrets are real files; the instance's databases are the two local D1s behind the kit's `openD1`.
import { afterEach, describe, expect, it } from 'vitest'
import { runInstance, INSTANCE_HELP } from './main.js'
import { runOwnerReset } from './owner-reset.js'
import { serverHelpProblems } from '../../../release/src/help-assertions.js'
import { ownerResetSuite, SECRET, BASE, type Driver, type RunOptions } from '../owner-reset.suite.js'
import { SECRETS_TEXT, cleanup, controlSettings, makeWorld } from './test-kit.js'

afterEach(() => cleanup())

function world(o: RunOptions) {
  const r = o.record ?? {}
  const provider = r.provider ?? 'better-auth'
  const vars: Record<string, string> = {
    AUTH_PROVIDER: provider === 'none' ? '' : provider,
    ...(r.baseUrl === null ? {} : { PUBLIC_BASE_URL: r.baseUrl ?? BASE }),
  }
  const settings = controlSettings({ vars, ...(r.control === false ? { control_d1: undefined } : {}) })
  const secrets = r.secret === null ? SECRETS_TEXT : `${SECRETS_TEXT}AUTH_SECRET=${r.secret ?? SECRET}\n`
  return makeWorld({
    settings,
    secretsText: secrets,
    processEnv: { CONFIRM_REMOTE: '1' },
    openD1: async () => ({ d1: o.crm, control: o.control, dispose: async () => {} }),
  })
}

const driver: Driver = {
  refused: 2,
  failed: 3,
  async run(o) {
    const w = world(o)
    const argv = ['--env', 'demo', ...(o.email ? ['--email', o.email] : []), ...(o.dryRun ? ['--dry-run'] : [])]
    const code = await runOwnerReset(argv, w.deps)
    return { code, out: w.out, err: w.err }
  },
}
ownerResetSuite('vibase-server owner-reset', () => driver, { dryRun: true })

describe('vibase-server owner-reset: arguments and exit codes', () => {
  const go = async (argv: string[], env: Record<string, string | undefined> = {}) => {
    const w = makeWorld({
      settings: controlSettings({ vars: { AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: BASE } }),
      secretsText: `${SECRETS_TEXT}AUTH_SECRET=${SECRET}\n`,
      processEnv: env,
      openD1: async () => {
        throw new Error('the databases must not be opened')
      },
    })
    const code = await runOwnerReset(argv, w.deps)
    return { code, text: w.all(), w }
  }

  it('--env is required, an unknown flag is refused, and each refusal is exit 2 with the usage', async () => {
    for (const argv of [[], ['--env', 'demo', '--bogus'], ['--env', 'Bad_Name']]) {
      const r = await go(argv, { CONFIRM_REMOTE: '1' })
      expect(r.code, argv.join(' ')).toBe(2)
      expect(r.text).toContain('vibase-server owner-reset')
    }
  })

  it('a real run needs CONFIRM_REMOTE=1 and is refused before the databases are opened', async () => {
    const r = await go(['--env', 'demo'], {})
    expect(r.code).toBe(2)
    expect(r.text).toMatch(/CONFIRM_REMOTE=1/)
    expect(r.w.openD1Calls).toEqual([])
  })

  it('a missing settings file is refused naming the path', async () => {
    const w = makeWorld({ settings: null, processEnv: { CONFIRM_REMOTE: '1' } })
    expect(await runOwnerReset(['--env', 'demo'], w.deps)).toBe(2)
    expect(w.all()).toContain(w.settingsPath)
  })

  it('a secrets file group- or world-readable is refused (mode 644) and AUTH_SECRET is never printed on any failure', async () => {
    const w = makeWorld({
      settings: controlSettings({ vars: { AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: BASE } }),
      secretsMode: 0o644,
      secretsText: `${SECRETS_TEXT}AUTH_SECRET=${SECRET}\n`,
      processEnv: { CONFIRM_REMOTE: '1' },
    })
    expect(await runOwnerReset(['--env', 'demo'], w.deps)).toBe(2)
    expect(w.all()).not.toContain(SECRET)
  })

  it('the databases are opened with the instance settings and the two Cloudflare values only', async () => {
    const opened: unknown[] = []
    const w = makeWorld({
      settings: controlSettings({ vars: { AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: BASE } }),
      secretsText: `${SECRETS_TEXT}AUTH_SECRET=${SECRET}\n`,
      processEnv: { CONFIRM_REMOTE: '1' },
      openD1: async (o) => {
        opened.push(o)
        throw new Error('stop here')
      },
    })
    expect(await runOwnerReset(['--env', 'demo', '--email', 'a@x.test'], w.deps)).toBe(2)
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ remoteBindings: true, persist: false })
    expect(Object.keys((opened[0] as { env: object }).env).sort()).toEqual([
      'CI',
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_TOKEN',
      'HOME',
      'PATH',
      'WRANGLER_SEND_METRICS',
    ])
    expect(w.all()).not.toContain(SECRET)
  })
})

describe('6. help and routing', () => {
  it('INSTANCE_HELP lists owner-reset --env <name>', () => {
    expect(INSTANCE_HELP).toContain('vibase-server owner-reset --env <name>')
    expect(INSTANCE_HELP).toMatch(/--dry-run/)
    expect(INSTANCE_HELP).toMatch(/Exit 0[\s\S]*2[\s\S]*3/)
  })
  it("release:check's help assertions pass on the real help text, and each one names what it misses (a help without owner-reset fails)", () => {
    expect(serverHelpProblems(INSTANCE_HELP)).toEqual([])
    expect(
      serverHelpProblems(INSTANCE_HELP.replace('vibase-server owner-reset --env <name>', 'vibase-server owner-reset')),
    ).toEqual(['owner-reset --env <name>'])
    expect(serverHelpProblems('')).toHaveLength(4)
  })
  it('runInstance routes owner-reset to the command (a missing --env is its refusal, not "unknown command")', async () => {
    const out: string[] = []
    const err: string[] = []
    const code = await runInstance(['owner-reset'], {
      stdout: (t) => void out.push(t),
      stderr: (t) => void err.push(t),
      env: {},
    })
    expect(code).toBe(2)
    expect(err.join('')).toContain('vibase-server owner-reset')
    expect(err.join('')).not.toContain('unknown command')
  })
})

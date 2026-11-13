import { readdirSync } from 'node:fs'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runStatus } from './status.js'
import { ACCOUNT, captureHealthBody, cleanup, makeWorld, NO_TRACKER_JSON, TOKEN, trackerJson, validSettings, type World, type WorldOptions } from './test-kit.js'

afterEach(cleanup)
let HEALTH: Record<string, any>
beforeAll(async () => { HEALTH = await captureHealthBody() })
const healthRes = (version: string) => () => new Response(JSON.stringify({ ...HEALTH, version }), { status: 200, headers: { 'content-type': 'application/json' } })
const status = async (o: WorldOptions & { version?: string; argv?: string[] } = {}) => {
  const w = makeWorld({ health: healthRes(o.version ?? '0.1.0'), ...o })
  return { w, code: await runStatus(o.argv ?? ['--env', 'demo'], w.deps) }
}
/** The fake runner saw only the tracker read: `d1 execute ... --command select ...`, no write command, no `--env`. */
const onlyTrackerReads = (w: World) => {
  for (const c of w.wrangler) {
    expect(c.args.slice(0, 2)).toEqual(['d1', 'execute'])
    expect(c.args.join(' ')).toMatch(/--command select name from d1_migrations/i)
    expect(c.args).toContain('--remote')
    expect(c.args).toContain('-c')
    expect(c.args).not.toContain('--env')
    expect(c.args.join(' ')).not.toMatch(/migrations apply|deploy|secret|versions/)
  }
}

describe('D15 status', () => {
  it('equal version and current migrations: exit 0, never CONFIRM_REMOTE, only the tracker read', async () => {
    const { w, code } = await status()
    expect(code).toBe(0)
    expect(w.deps.env.CONFIRM_REMOTE).toBeUndefined()
    expect(w.wrangler).toHaveLength(1)
    onlyTrackerReads(w)
    expect(w.out.join('\n')).toMatch(/0\.1\.0/)
    expect(w.out.join('\n')).toMatch(/migrations: current \(2 applied, 2 expected\)/)
    expect(w.err).toEqual([])
    expect(readdirSync(w.tmpRoot)).toEqual([])
  })

  it('an older live version prints the plan (both versions, the pending names in order) and exits 1', async () => {
    const { w, code } = await status({ version: '0.0.9', runner: () => ({ status: 0, stdout: trackerJson([]), stderr: '' }) })
    expect(code).toBe(1)
    const out = w.out.join('\n')
    expect(out).toMatch(/0\.0\.9/)
    expect(out).toMatch(/0\.1\.0/)
    expect(out.indexOf('0001_a.sql')).toBeGreaterThan(-1)
    expect(out.indexOf('0002_b.sql')).toBeGreaterThan(out.indexOf('0001_a.sql'))
    onlyTrackerReads(w)
  })

  it('equal version but a pending migration exits 1', async () => {
    const { w, code } = await status({ runner: () => ({ status: 0, stdout: trackerJson(['0001_a.sql']), stderr: '' }) })
    expect(code).toBe(1)
    expect(w.out.join('\n')).toMatch(/migrations: behind/)
    expect(w.out.join('\n')).toMatch(/0002_b\.sql/)
  })

  it('no tracker table: migrations unknown, exit 1 (CORE61 D7)', async () => {
    const { w, code } = await status({ runner: () => ({ status: 1, stdout: NO_TRACKER_JSON, stderr: '' }) })
    expect(code).toBe(1)
    expect(w.out.join('\n')).toMatch(/migrations: unknown/)
  })

  it('a non-semver live version prints the note and exits 1', async () => {
    const { w, code } = await status({ version: 'dev' })
    expect(code).toBe(1)
    expect(w.out.join('\n')).toMatch(/dev.*not a release version/)
  })

  it('a refusal exits 2 and prints one line on stderr naming the cause', async () => {
    const { w, code } = await status({ settings: validSettings({ extra: 1 }) })
    expect(code).toBe(2)
    expect(w.err.join('\n')).toMatch(/vibase instance status: .*extra/)
    expect(w.wrangler).toEqual([])
  })
  it('a newer live version exits 2', async () => {
    const { code } = await status({ version: '9.9.9' })
    expect(code).toBe(2)
  })

  it('--env is required; --rollback is not accepted (it arrives with upgrade); no call is made', async () => {
    for (const argv of [[], ['--env', 'demo', '--rollback']]) {
      const { w, code } = await status({ argv })
      expect(code).toBe(2)
      expect(w.err.join('\n')).toMatch(/--env|--rollback/)
      expect(w.fetchUrls).toEqual([])
      expect(w.wrangler).toEqual([])
    }
  })

  it('--settings and --secrets-file read those files', async () => {
    const w = makeWorld({ health: healthRes('0.1.0') })
    // the default location is moved away: only the flags can find the files
    const moved = { ...w.deps, env: { ...w.deps.env, XDG_CONFIG_HOME: '/nonexistent' } }
    expect(await runStatus(['--env', 'demo'], moved)).toBe(2)
    expect(await runStatus(['--env', 'demo', '--settings', w.settingsPath, '--secrets-file', w.secretsPath], moved)).toBe(0)
  })
})

describe('D10 secrets are never printed', () => {
  const leaks = (w: World) => {
    const text = w.all()
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(ACCOUNT)
    for (const c of w.wrangler) {
      expect(c.configText ?? '').not.toContain(TOKEN)
      expect(c.configText ?? '').not.toContain(ACCOUNT)
      expect(c.args.join(' ')).not.toContain(TOKEN)
    }
  }
  it('reach the wrangler child environment and nothing else', async () => {
    const { w, code } = await status({ processEnv: { CONFIRM_REMOTE: '1', CLERK_SECRET_KEY: 'sk_live_nope' } })
    expect(code).toBe(0)
    const env = w.wrangler[0]!.env
    expect(env.CLOUDFLARE_API_TOKEN).toBe(TOKEN)
    expect(env.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT)
    expect(Object.keys(env).sort()).toEqual(['CI', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'HOME', 'PATH', 'WRANGLER_SEND_METRICS'])
    leaks(w)
  })
  it('process env wins for the two names', async () => {
    const { w, code } = await status({ processEnv: { CLOUDFLARE_API_TOKEN: 'process-token-1' } })
    expect(code).toBe(0)
    expect(w.wrangler[0]!.env.CLOUDFLARE_API_TOKEN).toBe('process-token-1')
    expect(w.wrangler[0]!.env.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT)
  })
  it('a wrangler failure that echoes its whole environment prints no secret', async () => {
    const { w, code } = await status({ runner: (_a, env) => ({ status: 1, stdout: JSON.stringify(env), stderr: `failed with env ${JSON.stringify(env)} token=${env.CLOUDFLARE_API_TOKEN}` }) })
    expect(code).toBe(2)
    expect(w.err.join('\n')).toMatch(/wrangler d1 execute failed/)
    leaks(w)
    expect(readdirSync(w.tmpRoot)).toEqual([])
  })
  it('a refusal for the secrets file mode prints no secret', async () => {
    const { w, code } = await status({ secretsMode: 0o644 })
    expect(code).toBe(2)
    expect(w.err.join('\n')).toMatch(/demo\.env/)
    leaks(w)
  })
  it('the generated config as wrangler saw it holds no secret value', async () => {
    const { w } = await status()
    expect(w.wrangler[0]!.configText).toContain('vault-demo')
    leaks(w)
  })
})

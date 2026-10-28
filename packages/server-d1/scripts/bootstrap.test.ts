import { describe, expect, it, vi } from 'vitest'
import { appendEnvVar, parseBootstrapArgs, proxyOptions, remoteProxyOptions, reportLines, runRemoteGuards } from './bootstrap.js'
import { RemoteRefusal } from './remote.js'
import type { BootstrapD1Result } from '../src/bootstrap-d1.js'

describe('the bootstrap CLI never reaches a remote (spec D7)', () => {
  it('opens the local persisted state and never a remote binding', () => {
    const o = proxyOptions('/x/wrangler.jsonc')
    expect(o.remoteBindings).toBe(false)
    expect(o.persist).toBe(true)
    expect(o.configPath).toBe('/x/wrangler.jsonc')
  })
})

const REQUIRED = ['--org', 'smoked1', '--email', 'x@y.z', '--agent', 'operator', '--auth-org-id', 'smoked1']
const UUID = '0f5a1c2e-3b4d-4e6f-8a9b-1c2d3e4f5a6b'

describe('remote mode (C7)', () => {
  it('remote proxy options name the environment and allow remote bindings', () => {
    expect(remoteProxyOptions('smoked1', '/x/wrangler.jsonc')).toEqual({ configPath: '/x/wrangler.jsonc', environment: 'smoked1', persist: false, remoteBindings: true })
  })

  it('local args are unchanged', () => {
    const p = parseBootstrapArgs(['--', ...REQUIRED, '--auth-provider', 'clerk'])
    expect(p.mode).toBe('local')
    expect(p.envName).toBeUndefined()
    expect(p.values.org).toBe('smoked1')
  })

  it('remote needs --env and --key-env', () => {
    const msg = '--remote requires --env <name> and --key-env <NAME>'
    expect(() => parseBootstrapArgs([...REQUIRED, '--remote', '--key-env', 'K'])).toThrow(msg)
    expect(() => parseBootstrapArgs([...REQUIRED, '--remote', '--env', 'smoked1'])).toThrow(msg)
    const p = parseBootstrapArgs([...REQUIRED, '--remote', '--env', 'smoked1', '--key-env', 'K'])
    expect(p).toMatchObject({ mode: 'remote', envName: 'smoked1', keyEnv: 'K' })
  })

  it('the key-env name must be UPPER_SNAKE', () => {
    expect(() => parseBootstrapArgs([...REQUIRED, '--remote', '--env', 'smoked1', '--key-env', 'lower'])).toThrow()
  })

  it('the confirmation gate runs before any query or proxy', async () => {
    const getPlatformProxy = vi.fn()
    const loadEnv = vi.fn()
    const readConfig = vi.fn()
    await expect(
      runRemoteGuards({ envName: 'smoked1', keyEnv: 'K' }, {}, { loadEnv, readEnvText: () => '', readConfig, getPlatformProxy }),
    ).rejects.toThrow('set CONFIRM_REMOTE=1 to run against a remote instance')
    expect(getPlatformProxy).not.toHaveBeenCalled()
    expect(readConfig).not.toHaveBeenCalled()
  })

  it('refuses when the key variable is already in .env, before the proxy', async () => {
    const getPlatformProxy = vi.fn()
    await expect(
      runRemoteGuards({ envName: 'smoked1', keyEnv: 'K' }, { CONFIRM_REMOTE: '1' }, { loadEnv: () => {}, readEnvText: () => 'K=old\n', readConfig: () => ({}), getPlatformProxy }),
    ).rejects.toThrow(RemoteRefusal)
    expect(getPlatformProxy).not.toHaveBeenCalled()
  })

  it('opens the remote proxy only after every guard passes', async () => {
    const proxy = { env: { DB: {} }, dispose: async () => {} }
    const getPlatformProxy = vi.fn().mockResolvedValue(proxy)
    const config = { name: 'vault-smoked1', d1_databases: [{ binding: 'DB', database_name: 'vault-smoked1', database_id: UUID, remote: true }] }
    const r = await runRemoteGuards({ envName: 'smoked1', keyEnv: 'K' }, { CONFIRM_REMOTE: '1' }, { loadEnv: () => {}, readEnvText: () => 'A=1\n', readConfig: () => config, getPlatformProxy, log: () => {} })
    expect(getPlatformProxy).toHaveBeenCalledTimes(1)
    expect(getPlatformProxy.mock.calls[0]![0]).toMatchObject({ environment: 'smoked1', remoteBindings: true, persist: false })
    expect(r).toMatchObject({ target: { databaseId: UUID }, proxy })
  })
})

describe('appendEnvVar (C7)', () => {
  it('appends after adding a trailing newline', () => {
    expect(appendEnvVar('A=1', 'K', 'v')).toBe('A=1\nK=v\n')
  })
  it.each(['K=old\n', 'export K=old\n', '  K=\n'])('refuses an existing assignment %j', (t) => {
    expect(() => appendEnvVar(t, 'K', 'v')).toThrow('K is already set in .env: refusing to overwrite a key')
  })
  it('ignores a name that merely starts with it', () => {
    expect(appendEnvVar('KEY=1\n', 'K', 'v')).toBe('KEY=1\nK=v\n')
  })
})

describe('reportLines (C7)', () => {
  const r: BootstrapD1Result = { organizationId: 'o', userId: 'u', agentId: 'a', apiKeyId: 'k', key: 'vk_SECRETVALUE', deployment: 'created' }
  it('the remote report hides the key', () => {
    const lines = reportLines(r, 'remote', 'K')
    expect(lines.some((l) => l.includes('vk_SECRETVALUE'))).toBe(false)
    expect(lines).toContain('api_key: written to .env as K (not shown)')
  })
  it('the local report is unchanged', () => {
    expect(reportLines(r, 'local')).toContain('api_key:         vk_SECRETVALUE   (shown once)')
  })
})

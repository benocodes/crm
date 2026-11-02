import { describe, expect, it } from 'vitest'
import { RemoteRefusal } from '../remote.js'
import { parseSetupArgs } from './args.js'

const base = ['--env', 'acme', '--auth', 'none', '--api-host', 'api.acme.vibase.ai']

describe('parseSetupArgs: valid input (D6, D9, D18, D20)', () => {
  it('derives names from the env and defaults the organisation to the env name', () => {
    const o = parseSetupArgs(['--', ...base])
    expect(o).toMatchObject({ env: 'acme', apiHost: 'api.acme.vibase.ai', auth: 'none', org: 'acme', workerName: 'vault-acme', d1Name: 'vault-acme', r2Name: 'vault-acme-bodies', origins: [], dryRun: false })
  })
  it('overrides names, collects origins in order, and reads --only in the given order', () => {
    const o = parseSetupArgs([...base, '--worker-name', 'w', '--d1-name', 'd', '--r2-name', 'r', '--org', 'Acme Ltd', '--operator-agent', 'operator', '--key-env', 'K', '--owner-email', 'o@example.com', '--web-origin', 'https://app.example.com', '--extra-origin', 'https://a.example.com', '--extra-origin', 'https://b.example.com:8443', '--only', 'migrate,verify', '--dry-run'])
    expect(o).toMatchObject({ workerName: 'w', d1Name: 'd', r2Name: 'r', org: 'Acme Ltd', origins: ['https://app.example.com', 'https://a.example.com', 'https://b.example.com:8443'], only: ['migrate', 'verify'], dryRun: true })
  })
  it('takes the operator agent and key variable together', () => {
    const o = parseSetupArgs([...base, '--operator-agent', 'operator', '--key-env', 'ACME_KEY', '--owner-email', 'o@example.com'])
    expect(o).toMatchObject({ operatorAgent: 'operator', keyEnv: 'ACME_KEY', ownerEmail: 'o@example.com' })
  })
})

describe('parseSetupArgs: refusals before any network call (D19, D20, D18, D6)', () => {
  const cases: [string, string[], RegExp][] = [
    ['missing --env', ['--auth', 'none', '--api-host', 'api.acme.vibase.ai'], /--env/],
    ['missing --api-host', ['--env', 'acme', '--auth', 'none'], /--api-host/],
    ['api host with a scheme', ['--env', 'acme', '--auth', 'none', '--api-host', 'https://api.acme.vibase.ai'], /--api-host/],
    ['api host with a path', ['--env', 'acme', '--auth', 'none', '--api-host', 'api.acme.vibase.ai/v1'], /--api-host/],
    ['api host wildcard', ['--env', 'acme', '--auth', 'none', '--api-host', '*.vibase.ai'], /--api-host/],
    ['http web origin', [...base, '--web-origin', 'http://app.example.com'], /https/],
    ['web origin with a path', [...base, '--web-origin', 'https://app.example.com/app'], /path/],
    ['wildcard host origin', [...base, '--extra-origin', 'https://*.example.com'], /wildcard/],
    ['bare star origin', [...base, '--extra-origin', '*'], /wildcard|https/],
    ['--auth clerk', ['--env', 'acme', '--auth', 'clerk', '--api-host', 'api.acme.vibase.ai'], /OPS87/],
    ['--auth omitted', ['--env', 'acme', '--api-host', 'api.acme.vibase.ai'], /--auth none/],
    ['unknown step in --only', [...base, '--only', 'migrate,bogus'], /bogus/],
    ['operator agent without key env', [...base, '--operator-agent', 'operator'], /together/],
    ['key env without operator agent', [...base, '--key-env', 'ACME_KEY'], /together/],
    ['key env not UPPER_SNAKE', [...base, '--operator-agent', 'operator', '--key-env', 'lower', '--owner-email', 'o@example.com'], /UPPER_SNAKE/],
    ['operator without an owner email (none needs a human owner)', [...base, '--operator-agent', 'operator', '--key-env', 'K'], /--owner-email/],
    ['--org without an operator agent (only the marker is written, the name would be ignored)', [...base, '--org', 'Acme'], /--org/],
    ['a Clerk-only flag', [...base, '--clerk-publishable-key', 'pk_test_x'], /OPS87/],
  ]
  it.each(cases)('%s', (_name, argv, message) => {
    let thrown: unknown
    try {
      parseSetupArgs(argv)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(RemoteRefusal)
    expect((thrown as Error).message).toMatch(message)
  })
})

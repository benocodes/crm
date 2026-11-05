import { describe, expect, it } from 'vitest'
import { gmailConfigNotice, parseGmailConfig } from './config.js'

// CHN140 D58: the Gmail surface is configured when the four required values are set and the key decodes to 32 bytes.
const KEY = Buffer.alloc(32, 7).toString('base64')
const FULL = { GOOGLE_CLIENT_ID: 'id.apps.test', GOOGLE_CLIENT_SECRET: 'sekret-value-1', OAUTH_STATE_SECRET: 'state-secret-value-2', CREDENTIALS_KEY: KEY }

describe('parseGmailConfig (D58)', () => {
  it('reads the four values, defaults the key version to 1 and leaves the optional URLs null', () => {
    const { config, problems } = parseGmailConfig(FULL)
    expect(problems).toEqual([])
    expect(config).toMatchObject({ clientId: 'id.apps.test', clientSecret: 'sekret-value-1', stateSecret: 'state-secret-value-2', keyVersion: 1, publicBaseUrl: null, returnUrl: null })
    expect(config!.credentialsKey).toHaveLength(32)
  })

  it('reads CREDENTIALS_KEY_VERSION, PUBLIC_BASE_URL (no trailing slash) and CONNECT_RETURN_URL', () => {
    const { config } = parseGmailConfig({ ...FULL, CREDENTIALS_KEY_VERSION: '4', PUBLIC_BASE_URL: 'https://api.example.test/', CONNECT_RETURN_URL: 'https://app.example.test/connected' })
    expect(config).toMatchObject({ keyVersion: 4, publicBaseUrl: 'https://api.example.test', returnUrl: 'https://app.example.test/connected' })
  })

  it.each(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OAUTH_STATE_SECRET', 'CREDENTIALS_KEY'] as const)('without %s the surface is unconfigured and the problem names only that variable', (name) => {
    const env: Record<string, string | undefined> = { ...FULL }
    delete env[name]
    const { config, problems } = parseGmailConfig(env)
    expect(config).toBeNull()
    expect(problems).toEqual([name])
  })

  it('a blank value counts as missing', () => {
    expect(parseGmailConfig({ ...FULL, GOOGLE_CLIENT_SECRET: '   ' }).problems).toEqual(['GOOGLE_CLIENT_SECRET'])
  })

  it.each([
    ['not base64', '!!!not-base64!!!'],
    ['16 bytes', Buffer.alloc(16, 1).toString('base64')],
    ['33 bytes', Buffer.alloc(33, 1).toString('base64')],
  ])('a CREDENTIALS_KEY that is %s is a configuration problem, not a weaker key', (_name, value) => {
    const { config, problems } = parseGmailConfig({ ...FULL, CREDENTIALS_KEY: value })
    expect(config).toBeNull()
    expect(problems).toEqual(['CREDENTIALS_KEY'])
  })

  it.each(['0', '-1', 'x', '1.5'])('CREDENTIALS_KEY_VERSION "%s" is a problem', (v) => {
    expect(parseGmailConfig({ ...FULL, CREDENTIALS_KEY_VERSION: v }).problems).toEqual(['CREDENTIALS_KEY_VERSION'])
  })

  it('the notice names the variables and carries no value', () => {
    const { problems } = parseGmailConfig({ ...FULL, GOOGLE_CLIENT_SECRET: undefined, CREDENTIALS_KEY: 'bad-key-value-zzz' })
    const notice = gmailConfigNotice(problems)
    expect(notice).toContain('GOOGLE_CLIENT_SECRET')
    expect(notice).toContain('CREDENTIALS_KEY')
    for (const value of [FULL.GOOGLE_CLIENT_ID, FULL.OAUTH_STATE_SECRET, 'bad-key-value-zzz']) expect(notice).not.toContain(value)
  })
})

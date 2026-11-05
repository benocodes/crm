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

// [[CHN5]] D71 ([[CHN149]]): the two capture values are parsed here, with defaults, and a malformed one is named without its value.
describe('GMAIL_BACKFILL_DAYS and ATTACHMENT_MAX_BYTES (D71)', () => {
  it('default to 30 days and 50 MiB', () => {
    expect(parseGmailConfig(FULL).config).toMatchObject({ backfillDays: 30, attachmentMaxBytes: 50 * 1024 * 1024 })
  })
  it('read both values', () => {
    expect(parseGmailConfig({ ...FULL, GMAIL_BACKFILL_DAYS: '7', ATTACHMENT_MAX_BYTES: '1048576' }).config).toMatchObject({ backfillDays: 7, attachmentMaxBytes: 1048576 })
  })
  it.each([
    ['GMAIL_BACKFILL_DAYS', '0'],
    ['GMAIL_BACKFILL_DAYS', '-3'],
    ['GMAIL_BACKFILL_DAYS', 'thirty'],
    ['GMAIL_BACKFILL_DAYS', '1.5'],
    ['GMAIL_BACKFILL_DAYS', '1234567890'],
    ['ATTACHMENT_MAX_BYTES', '0'],
    ['ATTACHMENT_MAX_BYTES', '12 MB'],
    ['ATTACHMENT_MAX_BYTES', '1234567890'],
  ])('%s "%s" is a named problem that turns the surface off, and the notice carries no value', (name, value) => {
    const { config, problems } = parseGmailConfig({ ...FULL, [name]: value })
    expect(config).toBeNull()
    expect(problems).toEqual([name])
    expect(gmailConfigNotice(problems)).not.toContain(value)
  })
  it('the largest accepted value has nine digits', () => {
    expect(parseGmailConfig({ ...FULL, GMAIL_BACKFILL_DAYS: '999999999' }).config?.backfillDays).toBe(999999999)
  })
})

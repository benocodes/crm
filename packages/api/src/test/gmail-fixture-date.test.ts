import { describe, expect, it } from 'vitest'
import { parseGmailConfig } from '../connections/config.js'
import { buildGmailMessage } from './gmail.js'
import { gmailFixture } from './gmail-fixtures.js'

// The sync's backfill window runs from the real clock, so a fixed default date silently rots (#520, #500).
const DAY = 86_400_000
const { config } = parseGmailConfig({
  GOOGLE_CLIENT_ID: 'id.apps.test',
  GOOGLE_CLIENT_SECRET: 'sekret-value-1',
  OAUTH_STATE_SECRET: 'state-secret-value-2',
  CREDENTIALS_KEY: Buffer.alloc(32, 7).toString('base64'),
})

describe('Gmail fixture default internalDate', () => {
  it('is inside the default backfill window, whenever it is built', () => {
    const backfillDays = config?.backfillDays ?? Number.NaN
    expect(backfillDays).toBeGreaterThan(0)
    const age = Date.now() - Number(gmailFixture('plain').resource.internalDate)
    expect(age).toBeGreaterThanOrEqual(0)
    expect(age).toBeLessThan(backfillDays * DAY)
  })

  it('is relative to the call: a later clock gives a later default', () => {
    const real = Date.now
    try {
      Date.now = () => Date.parse('2030-01-01T00:00:00.000Z')
      expect(Number(gmailFixture('plain').resource.internalDate)).toBe(Date.parse('2029-12-31T00:00:00.000Z'))
    } finally {
      Date.now = real
    }
  })

  it('an explicit internalDate still pins the date', () => {
    const m = buildGmailMessage({
      id: 'pin',
      internalDate: 1_000,
      headers: [['Subject', 'x']],
      payload: { mimeType: 'text/plain', text: 'x' },
    })
    expect(m.resource.internalDate).toBe('1000')
  })
})

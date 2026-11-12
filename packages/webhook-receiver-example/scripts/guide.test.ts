import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ATTEMPT_TIMEOUT_MS, DEFAULT_EVENT_TYPES, DEFAULT_TICK_BUDGET, DELIVERY_CANCEL_CODES, DELIVERY_FAILURE_CODES, RETRY_DELAYS_MS, SEND_MAX_ATTEMPTS, WEBHOOK_HEADERS, webhookOperations } from '@vault/api'
import { ROTATION_OVERLAP_MS } from '../../api/src/webhooks/secrets.js'
import { eventOperations } from '../../api/src/events/operations.js'
import { TOLERANCE_SECONDS } from '../src/verify.js'
import { REQUIRED_SCOPES } from '../src/vault.js'

// The guide states facts the code defines; each is checked against the code's own constant, never a copy ([[CORE201]]'s lesson). The guide is read as text and a fact is a backticked name or a rendered number.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GUIDE = join(root, 'docs/src/content/docs/guides/webhooks.md')
const guide = readFileSync(GUIDE, 'utf8')
const unit = (ms: number) => (ms % 3_600_000 === 0 ? `${ms / 3_600_000} hours` : ms % 60_000 === 0 ? `${ms / 60_000} minutes` : `${ms / 1000} seconds`)

describe('the webhooks guide states what the code defines', () => {
  it('names the three headers the sender sets', () => {
    for (const h of Object.values(WEBHOOK_HEADERS)) expect(guide, h).toContain(`\`${h}\``)
  })
  it('states the receiver tolerance and the timeout', () => {
    expect(guide).toContain(`${TOLERANCE_SECONDS / 60} minutes`)
    expect(guide).toContain(`${ATTEMPT_TIMEOUT_MS / 1000} seconds`)
  })
  it('lists the retry delays in order and the number of attempts', () => {
    expect(guide).toContain(RETRY_DELAYS_MS.map(unit).join(', '))
    expect(guide).toContain(`${SEND_MAX_ATTEMPTS} attempts`)
  })
  it('lists every last_error code', () => {
    for (const code of [...DELIVERY_FAILURE_CODES, ...DELIVERY_CANCEL_CODES]) expect(guide, code).toContain(`\`${code}\``)
  })
  it('names the scopes the operations declare, and the ones the example needs', () => {
    const declared = new Set<string>()
    for (const op of [...webhookOperations(null, () => undefined as never), ...eventOperations(() => undefined as never)]) if (op.scope) declared.add(`${op.scope.resource}:${op.scope.action}`)
    expect([...declared].sort()).toEqual(['events:read', 'webhooks:read', 'webhooks:write'])
    for (const s of [...declared, ...REQUIRED_SCOPES]) expect(guide, s).toContain(`\`${s}\``)
  })
  it('names the default event type, the rotation overlap and the default tick budget', () => {
    for (const t of DEFAULT_EVENT_TYPES) expect(guide).toContain(`\`${t}\``)
    expect(guide).toContain(`${ROTATION_OVERLAP_MS / 3_600_000} hours`)
    expect(guide).toContain(`CRON_TICK_BUDGET`)
    expect(guide).toContain(`${DEFAULT_TICK_BUDGET}`)
  })
  it('names the operator variables and does not promise behaviour that has not shipped', () => {
    for (const v of ['CREDENTIALS_KEY', 'WEBHOOK_ALLOW_INSECURE_URLS', 'CRON_TICK_BUDGET']) expect(guide, v).toContain(v)
    expect(guide).toMatch(/410/)
    expect(guide).toMatch(/Retry-After/)
    expect(guide).not.toMatch(/auto-?disable[sd]? (the|a) subscription (on|after|when)|is purged|are purged/i)
  })
  it('is in the sidebar under "Connect your agents"', () => {
    const config = readFileSync(join(root, 'docs/astro.config.mjs'), 'utf8')
    const group = config.slice(config.indexOf("label: 'Connect your agents'"))
    expect(group.slice(0, group.indexOf('] }'))).toContain("slug: 'guides/webhooks'")
  })
})

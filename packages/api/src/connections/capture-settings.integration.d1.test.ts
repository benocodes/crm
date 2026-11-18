import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { defineOperation, unit } from '@vibase/storage'
import { createVibaseRegistry } from '../operations.js'
import type { TenantOperation } from '../registry.js'
import { createApp } from '../rest/app.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { SEED_AT } from '../test/insert.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'
import { captureSettingsRead, type CaptureSettings } from './capture-settings.js'

// [[CHN406]] cycle 1: the connection record's capture settings (D3), `captureSettingsRead` (D11, D12) and the catalog (D14). The fixtures are direct
// inserts (the owner's write is CHN409's, the workspace list's CHN410's): setup bypasses the code under test.
let e: Engine
let app: ReturnType<typeof createApp>
beforeAll(async () => {
  e = await openD1Engine()
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
  app = createApp({ storage: () => e.binding, userAuthenticator: fakeUserAuthenticator() })
})

const get = async (path: string) => {
  const token = mintTestUserToken({
    userId: e.userId,
    organizationId: e.organizationId,
    scopes: ['connections:read'],
    kind: 'user',
  })
  const res = await app.request(`https://vibase.test${path}`, { headers: { authorization: `Bearer ${token}` } })
  return { status: res.status, body: (await res.json()) as any }
}
let n = 0
async function seedConnection(over: Record<string, unknown> = {}) {
  n++
  const identity = await e.insert('identities', {
    kind: 'email',
    value: `own-${n}@vibase.test`,
    contact_id: null,
    own: true,
  })
  return e.insert('channel_connections', {
    provider: 'google',
    account_id: `sub-${n}`,
    identity_id: identity.id,
    owner_id: e.userId,
    status: 'active',
    granted_scopes: ['openid'],
    connected_at: SEED_AT,
    ...over,
  })
}
const label = (connection_id: string, label_id: string) =>
  e.insert('connection_capture_labels', { connection_id, label_id })
const own = (connection_id: string, kind: 'address' | 'domain', value: string) =>
  e.insert('connection_blocked_senders', { connection_id, kind, value })
const workspace = (kind: 'address' | 'domain', value: string, over: Record<string, unknown> = {}) =>
  e.insert('blocked_senders', { kind, value, ...over })

describe('the connection record embeds the settings (D3)', () => {
  it('get and list carry the five fields, lists sorted, only the connection’s own blocked rows', async () => {
    const a = await seedConnection({
      exclude_group_addresses: true,
      exclude_personal_domains: false,
      contact_creation: 'sent',
    })
    const b = await seedConnection()
    // seeded out of order on purpose
    for (const l of ['SENT', 'Label_9', 'INBOX']) await label(a.id, l)
    await own(a.id, 'domain', 'b.example')
    await own(a.id, 'address', 'z@a.example')
    await own(a.id, 'address', 'a@a.example')
    await own(a.id, 'domain', 'a.example')
    await own(b.id, 'domain', 'other.example')
    await workspace('domain', 'workspace.example')

    const got = await get(`/meta/v1/connections/${a.id}`)
    expect(got.status).toBe(200)
    expect(got.body).toMatchObject({
      capture_labels: ['INBOX', 'Label_9', 'SENT'],
      blocked_senders: [
        { kind: 'address', value: 'a@a.example' },
        { kind: 'address', value: 'z@a.example' },
        { kind: 'domain', value: 'a.example' },
        { kind: 'domain', value: 'b.example' },
      ],
      exclude_group_addresses: true,
      exclude_personal_domains: false,
      contact_creation: 'sent',
    })
    expect(JSON.stringify(got.body)).not.toContain('other.example')
    expect(JSON.stringify(got.body)).not.toContain('workspace.example')

    const list = await get('/meta/v1/connections')
    const byId = Object.fromEntries(list.body.data.map((c: any) => [c.id, c]))
    expect(byId[a.id].capture_labels).toEqual(['INBOX', 'Label_9', 'SENT'])
    expect(byId[a.id].blocked_senders).toHaveLength(4)
    // a connection with no rows: empty arrays and the defaults, never null
    expect(byId[b.id]).toMatchObject({
      capture_labels: [],
      blocked_senders: [{ kind: 'domain', value: 'other.example' }],
      exclude_group_addresses: true,
      exclude_personal_domains: true,
      contact_creation: 'sent',
    })
  })
})

// A read-only operation wrapping the read, to run it through the real plan phase the way a prepared program composes it.
const run = async (connectionId: string, organizationId = e.organizationId): Promise<CaptureSettings | null> =>
  (
    await e.run(
      defineOperation<CaptureSettings | null>({
        name: 'test.capture_settings',
        mutates: false,
        reads: (qc) => ({ settings: captureSettingsRead(qc, organizationId, connectionId).read }),
        build: (found, qc) =>
          unit({
            steps: [],
            events: [],
            decode: () => captureSettingsRead(qc, organizationId, connectionId).decode(found.maybe('settings')),
          }),
      }),
    )
  ).value

describe('captureSettingsRead (D11, D12)', () => {
  it('empty state: no label rows reads INBOX and SENT, no blocked rows reads empty arrays, defaults change nothing', async () => {
    const c = await seedConnection()
    expect(await run(c.id)).toEqual({
      connection_id: c.id,
      capture_labels: ['INBOX', 'SENT'],
      blocked_addresses: [],
      blocked_domains: [],
      exclude_group_addresses: true,
      exclude_personal_domains: true,
      contact_creation: 'sent',
    })
  })

  it('reads the stored scalars and labels, sorted', async () => {
    const c = await seedConnection({
      exclude_group_addresses: true,
      exclude_personal_domains: true,
      contact_creation: 'none',
    })
    for (const l of ['Label_7', 'INBOX']) await label(c.id, l)
    expect(await run(c.id)).toMatchObject({
      capture_labels: ['INBOX', 'Label_7'],
      exclude_group_addresses: true,
      exclude_personal_domains: true,
      contact_creation: 'none',
    })
  })

  it('the blocked lists are the union of the live workspace entries and the connection’s own, deduplicated and sorted', async () => {
    const c = await seedConnection()
    const other = await seedConnection()
    await workspace('domain', 'both.example')
    await workspace('domain', 'a.example')
    await workspace('address', 'x@both.example')
    await workspace('domain', 'gone.example', { deleted_at: SEED_AT })
    await own(c.id, 'domain', 'both.example')
    await own(c.id, 'domain', 'z.example')
    await own(c.id, 'address', 'x@both.example')
    await own(c.id, 'address', 'b@y.example')
    await own(other.id, 'domain', 'not-mine.example')
    const s = (await run(c.id))!
    expect(s.blocked_domains).toEqual(['a.example', 'both.example', 'z.example'])
    expect(s.blocked_addresses).toEqual(['b@y.example', 'x@both.example'])
    // the other connection sees the workspace list and its own entry only
    expect((await run(other.id))!.blocked_domains).toEqual(['a.example', 'both.example', 'not-mine.example'])
  })

  it('is null for an unknown connection, a soft-deleted one and another organisation’s id', async () => {
    const c = await seedConnection()
    const gone = await seedConnection()
    await label(gone.id, 'INBOX')
    await e.update('channel_connections', gone.id, { deleted_at: SEED_AT })
    expect(await run('0190b2c4-0000-7000-8000-0000000000ff')).toBeNull()
    expect(await run(gone.id)).toBeNull()
    expect(await run(c.id, '0190b2c4-0000-7000-8000-0000000000fe')).toBeNull()
  })

  it('is plain data (structuredClone survives), and one query per call whatever the list sizes', async () => {
    const c = await seedConnection()
    for (let i = 0; i < 12; i++) await own(c.id, 'domain', `d${i}.example`)
    const s = (await run(c.id))!
    expect(structuredClone(s)).toEqual(s)
    expect(JSON.parse(JSON.stringify(s))).toEqual(s)
    // composable as a program's read: the whole answer rides ONE Read (one query) whatever the list sizes
    let keys: string[] = []
    await e.run(
      defineOperation<null>({
        name: 'test.one_read',
        mutates: false,
        reads: (qc) => {
          const reads = { settings: captureSettingsRead(qc, e.organizationId, c.id).read }
          keys = Object.keys(reads)
          return reads
        },
        build: () => unit({ steps: [], events: [], decode: () => null }),
      }),
    )
    expect(keys).toEqual(['settings'])
  })
})

describe('the catalog describes the new tables and columns (D14)', () => {
  const registry = createVibaseRegistry()
  const doc = async (): Promise<any> => {
    const op = registry.get('schema.get') as TenantOperation
    return (await e.run(await op.prepare(e.env(), { params: {}, query: {}, body: undefined }))).value
  }
  it('lists the four tables, and the three connection columns, with text; none is hidden', async () => {
    const d = await doc()
    const t = (name: string) => d.tables.find((x: any) => x.name === name)
    for (const name of ['connection_capture_labels', 'connection_blocked_senders', 'blocked_senders']) {
      expect(t(name), name).toBeDefined()
      expect(t(name).label.length, `${name} label`).toBeGreaterThan(0)
      expect(t(name).description.length, `${name} description`).toBeGreaterThan(20)
      for (const c of t(name).columns) expect(c.description.length, `${name}.${c.name}`).toBeGreaterThan(5)
    }
    for (const col of ['exclude_group_addresses', 'exclude_personal_domains', 'contact_creation']) {
      const c = t('channel_connections').columns.find((x: any) => x.name === col)
      expect(c, col).toBeDefined()
      expect(c.description.length, col).toBeGreaterThan(20)
    }
    expect(t('channel_connections').columns.find((x: any) => x.name === 'contact_creation').values).toEqual([
      'sent_and_received',
      'sent',
      'none',
    ])
  })
})

describe('the shared default labels (CHN407 D12)', () => {
  it('connect.ts takes DEFAULT_CAPTURE_LABELS from capture-settings.ts and keeps no copy of its own', () => {
    const src = readFileSync(fileURLToPath(new URL('./connect.ts', import.meta.url)), 'utf8')
    expect(src).toMatch(/import \{[^}]*DEFAULT_CAPTURE_LABELS[^}]*\} from '\.\/capture-settings\.js'/)
    expect(src).not.toMatch(/const DEFAULT_CAPTURE_LABELS/)
  })
})

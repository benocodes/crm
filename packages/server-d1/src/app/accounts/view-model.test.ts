import { describe, expect, it } from 'vitest'
import { buildAccountsView, relativeTime, type ConnectionLike } from './view-model.js'

// [[UI467]] group 1 (D2, D10, D12, P1, P3): the view model decides rows by scope, ownership and status.
const NOW = new Date('2026-11-18T12:00:00.000Z')
const ME = 'user-me'
const OTHER = 'user-other'
const conn = (id: string, over: Partial<ConnectionLike> = {}): ConnectionLike => ({
  id,
  owner_id: ME,
  identity_id: `i-${id}`,
  status: 'active',
  last_synced_at: null,
  last_error_code: null,
  ...over,
})
const view = (
  connections: ConnectionLike[],
  over: { scopes?: string[]; addresses?: Record<string, string | null> } = {},
) =>
  buildAccountsView({
    scopes: over.scopes ?? ['connections:read', 'connections:write'],
    userId: ME,
    connections,
    addresses: over.addresses ?? {},
    now: NOW,
  })

describe('relativeTime (wording pinned)', () => {
  it.each([
    ['2026-11-18T11:59:30.000Z', 'just now'],
    ['2026-11-18T12:30:00.000Z', 'just now'], // a clock a little ahead is not "in the future"
    ['2026-11-18T11:59:00.000Z', '1 minute ago'],
    ['2026-11-18T11:15:00.000Z', '45 minutes ago'],
    ['2026-11-18T11:00:00.000Z', '1 hour ago'],
    ['2026-11-18T01:00:00.000Z', '11 hours ago'],
    ['2026-11-17T12:00:00.000Z', '1 day ago'],
    ['2026-11-04T12:00:00.000Z', '14 days ago'],
    ['2026-09-01T08:00:00.000Z', 'on 2026-09-01'],
    ['not a date', 'on not a date'],
  ])('%s -> %s', (iso, text) => {
    expect(relativeTime(iso, NOW)).toBe(text)
  })
})

describe('split, order and title', () => {
  it('splits by owner_id, orders each section by address (not by the list order), and titles rows by address', () => {
    const v = view(
      [conn('c1'), conn('c2', { owner_id: OTHER }), conn('c3'), conn('c4', { owner_id: OTHER }), conn('c5')],
      {
        addresses: {
          c1: 'zed@x.test',
          c2: 'yan@x.test',
          c3: 'amy@x.test',
          c4: 'bob@x.test',
          c5: 'mia@x.test',
        },
      },
    )
    expect(v.yours.map((r) => r.title)).toEqual(['amy@x.test', 'mia@x.test', 'zed@x.test'])
    expect(v.others.map((r) => r.title)).toEqual(['bob@x.test', 'yan@x.test'])
    expect(v.yours.map((r) => r.id)).toEqual(['c3', 'c5', 'c1'])
  })

  it('a row whose address read failed (null or missing) is titled "Gmail account"', () => {
    const v = view([conn('c1'), conn('c2')], { addresses: { c1: null } })
    expect(v.yours.map((r) => r.title)).toEqual(['Gmail account', 'Gmail account'])
  })

  it('Other mailboxes is empty when nobody else owns one, and says "Another member\'s mailbox" in the meta otherwise, never an owner', () => {
    expect(view([conn('c1')]).others).toEqual([])
    const v = view([conn('c2', { owner_id: OTHER })], { addresses: { c2: 'b@x.test' } })
    expect(v.others[0]!.meta[0]).toBe("Another member's mailbox")
    expect(JSON.stringify(v)).not.toContain(OTHER)
    expect(v.yours).toEqual([])
  })
})

describe('meta, status and actions', () => {
  it('meta: Not synced yet, Last synced <relative>, and the sync error (known sentence plus code; unknown code with the fallback)', () => {
    const v = view([
      conn('a'),
      conn('b', { last_synced_at: '2026-11-18T09:00:00.000Z' }),
      conn('c', { status: 'reauth_required', last_error_code: 'invalid_grant' }),
      conn('d', { status: 'suspended', last_error_code: 'owner_not_admitted' }),
      conn('e', { last_error_code: 'rate_limited' }),
    ])
    const metaOf = (id: string) => [...v.yours, ...v.others].find((r) => r.id === id)!.meta
    expect(metaOf('a')).toEqual(['Not synced yet'])
    expect(metaOf('b')).toEqual(['Last synced 3 hours ago'])
    expect(metaOf('c')).toEqual([
      'Not synced yet',
      'Google no longer accepts this connection. Reconnect to resume syncing. (invalid_grant)',
    ])
    expect(metaOf('d')[1]).toBe(
      'The person who connected this mailbox is no longer a member of this workspace. (owner_not_admitted)',
    )
    expect(metaOf('e')).toEqual(['Not synced yet', 'Last sync failed. (rate_limited)'])
  })

  it.each([
    ['active', 'Connected', 'neutral'],
    ['reauth_required', 'Needs reconnect', 'warning'],
    ['suspended', 'Suspended', 'warning'],
  ])('status %s reads "%s" with tone %s', (status, text, tone) => {
    expect(view([conn('a', { status })]).yours[0]!.status).toEqual({ text, tone })
  })

  // The matrix: scopes x ownership x status ([[UI468]] group 1, P4: Settings on every row, Disconnect on every row with write, Sync now on active rows with write, Reconnect unchanged).
  const matrix: [string, string[], 'yours' | 'others', string, string[]][] = []
  for (const [label, scopes] of [
    ['read+write', ['connections:read', 'connections:write']],
    ['read only', ['connections:read']],
  ] as const)
    for (const who of ['yours', 'others'] as const)
      for (const status of ['active', 'reauth_required', 'suspended'])
        matrix.push([
          label,
          [...scopes],
          who,
          status,
          label === 'read+write'
            ? [
                'settings',
                ...(status === 'active' ? ['sync'] : []),
                ...(who === 'yours' && status !== 'active' ? ['reconnect'] : []),
                'disconnect',
              ]
            : ['settings'],
        ])
  it.each(matrix)('actions: %s, %s row, status %s -> %j', (_label, scopes, who, status, actions) => {
    const v = view([conn('a', { status, owner_id: who === 'yours' ? ME : OTHER })], { scopes })
    expect(v[who][0]!.actions).toEqual(actions)
  })
})

describe('access (D12) and the empty state (D2)', () => {
  it('without connections:read there is no access and no rows, and canConnect is false even with write', () => {
    const v = view([conn('a')], { scopes: ['connections:write'] })
    expect(v).toMatchObject({ access: false, canConnect: false, yours: [], others: [] })
  })
  it('connections:read gives access; canConnect needs connections:write', () => {
    expect(view([], { scopes: ['connections:read'] })).toMatchObject({ access: true, canConnect: false })
    expect(view([])).toMatchObject({ access: true, canConnect: true, yours: [], others: [] })
  })
})

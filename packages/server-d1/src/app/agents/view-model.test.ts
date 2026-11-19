import { describe, expect, it } from 'vitest'
import type { AgentRecord } from '../session/types.js'
import {
  buildAgentsView,
  connectedText,
  datesLine,
  FORM_MANAGED_LINE,
  grantCommand,
  permissionsLine,
  sortAgents,
  toggleOutcome,
} from './view-model.js'

// [[UI459]] groups 1, 2 (D3, D4, D5, D6, D7, D8) and the pure half of 5: the page's logic with no DOM and no network.
const ME = 'user-me'
const agent = (id: string, over: Partial<AgentRecord> = {}): AgentRecord => ({
  id,
  name: id,
  scopes: ['contacts:read'],
  disabled_at: null,
  created_at: '2026-11-01T10:00:00.000Z',
  auth_subject: null,
  auth_client_id: null,
  delegated_by: null,
  ...over,
})
const fmt = (iso: string) => `D(${iso.slice(0, 10)})`

describe('connectedText (D3: the order of /connect view-model, new wording)', () => {
  it.each([
    ['delegated by me', { delegated_by: ME, auth_client_id: 'c1' }, 'Signed in through you'],
    [
      'delegated by another member',
      { delegated_by: 'other', auth_client_id: 'c1' },
      'Signed in through another member',
    ],
    ['OAuth client, no delegator', { auth_client_id: 'client-9' }, 'Connected through OAuth client client-9'],
    ['agent account', { auth_subject: 'sub-1' }, 'Agent account'],
    ['API key', {}, 'API-key agent'],
    [
      'delegated wins over an agent subject',
      { delegated_by: 'other', auth_subject: 's' },
      'Signed in through another member',
    ],
    [
      'OAuth client wins over an agent subject',
      { auth_client_id: 'c2', auth_subject: 's' },
      'Connected through OAuth client c2',
    ],
  ] as const)('%s', (_n, over, text) => {
    expect(connectedText(agent('a', over), ME)).toBe(text)
  })
  it('a form agent reads Website form <name>, whatever else the record says', () => {
    expect(connectedText(agent('a', { delegated_by: ME }), ME, 'Contact us')).toBe('Website form Contact us')
  })
})

describe('permissionsLine (D4)', () => {
  it('groups by resource in sorted scope order, read, propose, write, then others by name', () => {
    expect(permissionsLine(['tasks:read', 'contacts:write', 'contacts:read'])).toBe(
      'Permissions: contacts (read, write), tasks (read)',
    )
    expect(permissionsLine(['messages:send', 'messages:write', 'messages:request_approval', 'messages:read'])).toBe(
      'Permissions: messages (read, propose, write, send)',
    )
  })
  it('request_approval is shown as propose, never raw', () => {
    const line = permissionsLine(['deals:request_approval'])
    expect(line).toBe('Permissions: deals (propose)')
    expect(line).not.toContain('request_approval')
  })
  it('other actions sort by name after write', () => {
    expect(permissionsLine(['x:zeta', 'x:alpha', 'x:write'])).toBe('Permissions: x (write, alpha, zeta)')
  })
  it('an empty list reads No permissions yet', () => {
    expect(permissionsLine([])).toBe('No permissions yet')
  })
})

describe('datesLine (D3)', () => {
  it('created only when enabled', () => {
    expect(datesLine(agent('a'), fmt)).toBe('Created D(2026-11-01)')
  })
  it('adds "; disabled <date>" only when disabled', () => {
    expect(datesLine(agent('a', { disabled_at: '2026-11-05T00:00:00.000Z' }), fmt)).toBe(
      'Created D(2026-11-01); disabled D(2026-11-05)',
    )
  })
})

describe('sortAgents (D3)', () => {
  it('enabled first, then name case-insensitively, then id', () => {
    const sorted = sortAgents([
      agent('3', { name: 'beta', disabled_at: 'x' }),
      agent('2', { name: 'Zed' }),
      agent('1', { name: 'alpha', disabled_at: 'x' }),
      agent('5', { name: 'Zed' }),
      agent('4', { name: 'apple' }),
    ])
    expect(sorted.map((a) => a.id)).toEqual(['4', '2', '5', '1', '3'])
  })
  it('a disabled agent named A sorts after an enabled agent named Z (state before name)', () => {
    expect(
      sortAgents([agent('1', { name: 'A', disabled_at: 'x' }), agent('2', { name: 'Z' })]).map((a) => a.id),
    ).toEqual(['2', '1'])
  })
  it('does not mutate its input', () => {
    const input = [agent('b'), agent('a')]
    sortAgents(input)
    expect(input.map((a) => a.id)).toEqual(['b', 'a'])
  })
})

const RO = ['agents:read']
const RW = ['agents:read', 'agents:write']
const build = (scopes: string[], withForms: boolean, agents: AgentRecord[]) =>
  buildAgentsView({
    scopes,
    meId: ME,
    agents,
    forms: withForms ? new Map([['form-1', 'Contact us']]) : null,
    formatDate: fmt,
  })
const FIXTURE = () => [
  agent('on', { name: 'on' }),
  agent('off', { name: 'off', disabled_at: '2026-11-05T00:00:00.000Z' }),
  agent('bare', { name: 'bare', scopes: [] }),
  agent('form-1', { name: 'Contact us', scopes: [] }),
]
const row = (v: ReturnType<typeof build>, id: string) => v.rows.find((r) => r.id === id)!

describe('rows by scope x agent state (group 2: D5, D6, D7, D8)', () => {
  for (const withForms of [false, true])
    for (const scopes of [RO, RW]) {
      const label = `${scopes.join('+')} ${withForms ? 'with' : 'without'} forms:read`
      const writer = scopes.includes('agents:write')
      it(`${label}: toggle and grant command`, () => {
        const v = build(scopes, withForms, FIXTURE())
        expect(v.access).toBe(true)
        expect(v.canWrite).toBe(writer)
        expect(row(v, 'on').action).toBe(writer ? 'disable' : null)
        expect(row(v, 'off').action).toBe(writer ? 'enable' : null)
        expect(row(v, 'on').grantCommand).toBeNull()
        expect(row(v, 'off').grantCommand).toBeNull()
        // no scopes: the grant command for a writer, on a non-form agent only
        expect(row(v, 'bare').grantCommand).toBe(writer ? grantCommand('bare') : null)
        expect(row(v, 'bare').grantCommand === null || row(v, 'bare').grantCommand!.includes('bare')).toBe(true)
        const form = row(v, 'form-1')
        if (withForms) {
          expect(form.formManaged).toBe(true)
          expect(form.action).toBeNull()
          expect(form.grantCommand).toBeNull()
          expect(form.meta[0]).toBe('Website form Contact us')
          expect(form.meta).toContain(FORM_MANAGED_LINE)
        } else {
          // unmarked: the 409 is the fallback
          expect(form.formManaged).toBe(false)
          expect(form.action).toBe(writer ? 'disable' : null)
          expect(form.grantCommand).toBe(writer ? grantCommand('form-1') : null)
          expect(form.meta).not.toContain(FORM_MANAGED_LINE)
        }
      })
    }
  it('the grant command is exactly the one /connect shows, with the agent id', () => {
    expect(grantCommand('abc')).toBe(`vibase agents update abc --scopes '["contacts:read","contacts:write"]'`)
  })
  it('the managed-by line reads as D6 says', () => {
    expect(FORM_MANAGED_LINE).toBe('Managed by its form: disable or delete the form to stop it.')
  })
  it('without agents:read there is no access and no rows, whatever else is held', () => {
    const v = build(['agents:write', 'forms:read'], true, FIXTURE())
    expect(v).toEqual({ access: false, canWrite: false, rows: [] })
  })
  it('a row: status badge, meta lines in order (how connected, permissions, dates), rows sorted', () => {
    const v = build(RW, false, FIXTURE())
    expect(v.rows.map((r) => r.id)).toEqual(['bare', 'form-1', 'on', 'off'])
    expect(row(v, 'on')).toMatchObject({
      name: 'on',
      status: { text: 'Enabled', tone: 'success' },
      meta: ['API-key agent', 'Permissions: contacts (read)', 'Created D(2026-11-01)'],
    })
    expect(row(v, 'off').status).toEqual({ text: 'Disabled', tone: 'neutral' })
    expect(row(v, 'off').meta[2]).toBe('Created D(2026-11-01); disabled D(2026-11-05)')
    expect(row(v, 'bare').meta[1]).toBe('No permissions yet')
  })
  it('the form is matched by id, not by name', () => {
    const v = buildAgentsView({
      scopes: RW,
      meId: ME,
      agents: [agent('x', { name: 'Contact us' })],
      forms: new Map([['form-1', 'Contact us']]),
      formatDate: fmt,
    })
    expect(v.rows[0]!.formManaged).toBe(false)
  })
})

describe('toggleOutcome (D5, pure half of group 5)', () => {
  const rec = agent('a', { name: 'Ada', disabled_at: '2026-11-06T00:00:00.000Z' })
  it('200 is updated with the RETURNED record and the announcement', () => {
    expect(toggleOutcome({ status: 200, body: rec }, 'Ada', true)).toEqual({
      kind: 'updated',
      record: rec,
      announce: 'Disabled Ada.',
    })
    const enabled = { ...rec, disabled_at: null }
    expect(toggleOutcome({ status: 200, body: enabled }, 'Ada', false)).toMatchObject({ announce: 'Enabled Ada.' })
  })
  it('404 reads the list again', () => {
    expect(toggleOutcome({ status: 404, body: null, code: 'not_found' }, 'Ada', true)).toEqual({ kind: 'reload' })
  })
  it('409 form_principal is the form sentence; another 409 is an error', () => {
    expect(toggleOutcome({ status: 409, body: null, code: 'form_principal' }, 'Ada', true)).toEqual({
      kind: 'form',
      text: FORM_MANAGED_LINE,
    })
    expect(toggleOutcome({ status: 409, body: null, code: 'other' }, 'Ada', true).kind).toBe('error')
  })
  it('another failure is an error carrying the code (or the status without one)', () => {
    expect(toggleOutcome({ status: 500, body: null, code: 'boom' }, 'Ada', true)).toEqual({
      kind: 'error',
      text: 'Could not disable Ada (boom). Try again.',
    })
    expect(toggleOutcome({ status: 502, body: null }, 'Ada', false)).toEqual({
      kind: 'error',
      text: 'Could not enable Ada (502). Try again.',
    })
  })
})

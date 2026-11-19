import { describe, expect, it } from 'vitest'
import {
  buildUpdate,
  saveAction,
  SYSTEM_LABEL_OPTIONS,
  valuesFromRecord,
  type CaptureRecord,
} from './settings-model.js'

// [[UI468]] group 3 (D7, P2, P3): the form model sends only what changed.
const record = (over: Partial<CaptureRecord> = {}): CaptureRecord => ({
  capture_labels: ['INBOX', 'Label_1'],
  blocked_senders: [],
  exclude_group_addresses: false,
  exclude_personal_domains: false,
  contact_creation: 'sent',
  ...over,
})
const start = (over: Partial<CaptureRecord> = {}) => valuesFromRecord(record(over))

describe('record to values (P2)', () => {
  it('a stored INBOX and Label_1 give the Inbox switch on and Label_1 in the editor', () => {
    expect(start()).toEqual({
      labels: ['INBOX'],
      otherLabels: ['Label_1'],
      blocked: [],
      excludeGroupAddresses: false,
      excludePersonalDomains: false,
      contactCreation: 'sent',
    })
  })
  it('offers the nine system labels by name in order', () => {
    expect(SYSTEM_LABEL_OPTIONS.map((o) => o.id)).toEqual([
      'INBOX',
      'SENT',
      'STARRED',
      'IMPORTANT',
      'CATEGORY_PERSONAL',
      'CATEGORY_SOCIAL',
      'CATEGORY_PROMOTIONS',
      'CATEGORY_UPDATES',
      'CATEGORY_FORUMS',
    ])
    expect(SYSTEM_LABEL_OPTIONS.slice(0, 4).map((o) => o.name)).toEqual(['Inbox', 'Sent', 'Starred', 'Important'])
  })
  it('blocked senders become their values', () => {
    expect(
      start({
        blocked_senders: [
          { kind: 'address', value: 'a@x.com' },
          { kind: 'domain', value: 'x.org' },
        ],
      }).blocked,
    ).toEqual(['a@x.com', 'x.org'])
  })
})

describe('values to body (P3)', () => {
  it('an untouched form is unchanged', () => {
    expect(buildUpdate(start(), start())).toEqual({ kind: 'unchanged' })
  })
  it('one switch toggled sends only that field', () => {
    expect(buildUpdate(start(), { ...start(), excludeGroupAddresses: true })).toEqual({
      kind: 'changes',
      body: { exclude_group_addresses: true },
    })
  })
  it('a changed contact choice sends only contact_creation', () => {
    expect(buildUpdate(start(), { ...start(), contactCreation: 'none' })).toEqual({
      kind: 'changes',
      body: { contact_creation: 'none' },
    })
  })
  it('a reordered but equal label or blocked list sends nothing (sets)', () => {
    const initial = start({
      capture_labels: ['INBOX', 'SENT', 'Label_1', 'Label_2'],
      blocked_senders: [
        { kind: 'address', value: 'a@x.com' },
        { kind: 'domain', value: 'x.org' },
      ],
    })
    expect(
      buildUpdate(initial, {
        ...initial,
        labels: ['SENT', 'INBOX'],
        otherLabels: ['Label_2', 'Label_1'],
        blocked: ['x.org', 'a@x.com'],
      }),
    ).toEqual({ kind: 'unchanged' })
  })
  it('blocked senders compare lowercased, as the server stores them', () => {
    const initial = start({ blocked_senders: [{ kind: 'address', value: 'spam@example.com' }] })
    expect(buildUpdate(initial, { ...initial, blocked: ['Spam@Example.com'] })).toEqual({ kind: 'unchanged' })
  })
  it('a changed label list is sent whole: checked system labels in offered order, then the editor ids, without duplicates', () => {
    const r = buildUpdate(start(), {
      ...start(),
      labels: ['SENT', 'INBOX'],
      otherLabels: ['Label_1', 'Label_2', 'Label_1'],
    })
    expect(r).toEqual({ kind: 'changes', body: { capture_labels: ['INBOX', 'SENT', 'Label_1', 'Label_2'] } })
  })
  it('blocked a@x.com and x.org become an address and a domain, sent whole', () => {
    const r = buildUpdate(start(), { ...start(), blocked: ['a@x.com', 'x.org'] })
    expect(r).toEqual({
      kind: 'changes',
      body: {
        blocked_senders: [
          { kind: 'address', value: 'a@x.com' },
          { kind: 'domain', value: 'x.org' },
        ],
      },
    })
  })
  it('no labels at all is refused with the message and no body', () => {
    expect(buildUpdate(start(), { ...start(), labels: [], otherLabels: [] })).toEqual({
      kind: 'invalid',
      message: 'Choose at least one label.',
    })
  })
  it('only the changed fields are in the body when several change', () => {
    const r = buildUpdate(start(), { ...start(), excludePersonalDomains: true, contactCreation: 'sent_and_received' })
    expect(r).toEqual({
      kind: 'changes',
      body: { exclude_personal_domains: true, contact_creation: 'sent_and_received' },
    })
  })
})

describe('what a save answer means (D7)', () => {
  it.each([
    [200, undefined, 'saved'],
    [400, 'validation_error', 'invalid'],
    [403, 'not_connection_owner', 'reload'],
    [404, 'not_found', 'reload'],
    [500, undefined, 'failed'],
    [403, 'user_required', 'failed'],
  ])('%s %s is %s', (status, code, expected) => {
    expect(saveAction({ status, ...(code ? { code } : {}) })).toBe(expected)
  })
})

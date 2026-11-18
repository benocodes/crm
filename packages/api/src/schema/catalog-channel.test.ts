import { describe, expect, it } from 'vitest'
import { CATALOG, type ColumnText } from './catalog.js'

// [[CHN432]] P5 (432.7): the three `channel` descriptions name both values the column can take.
const text = (c: string | ColumnText | undefined) => (typeof c === 'string' ? c : (c?.description ?? ''))

describe('the channel column descriptions', () => {
  it.each(['threads', 'messages', 'interactions'])('%s.channel names email and form, not "email today"', (table) => {
    const d = text(CATALOG.tables[table]!.columns.channel)
    expect(d).toMatch(/\bemail\b/)
    expect(d).toMatch(/\bform\b/)
    expect(d).not.toMatch(/today/)
  })

  it('no catalog text calls the channel email-only', () => {
    const all = Object.values(CATALOG.tables).flatMap((t) => [t.description, ...Object.values(t.columns).map(text)])
    expect(all.filter((s) => /email today|email only|only email/i.test(s))).toEqual([])
  })
})

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildSyntheticRecordings } from '../../test/google-recordings.js'
import { replay, type RecordingFixture } from '../../test/recording-replay.js'
import { dishonestStrings } from '../../test/recorded-honesty.js'

// [[CHN5]] D80 ([[CHN153]]): every file under test/fixtures/google/ is served, rebuilt to Google's wire form, to the real client, token code, channel and mapper.
// Adding a recording needs a file and its `expect`, no code here.
const DIR = fileURLToPath(new URL('../../test/fixtures/google/', import.meta.url))
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()
const load = (f: string): RecordingFixture => JSON.parse(readFileSync(`${DIR}${f}`, 'utf8')) as RecordingFixture
/** `"$string"` in an expectation stands for any non-empty string (a pseudonym cannot be written down). */
const withMatchers = (v: unknown): unknown => (v === '$string' ? expect.stringMatching(/./) : Array.isArray(v) ? v.map(withMatchers) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withMatchers(x)])) : v)
const check = async (fx: RecordingFixture): Promise<void> => {
  const out = await replay(fx)
  if (fx.expect.error !== undefined) {
    expect(out).toHaveProperty('error')
    expect((out as { error: unknown }).error).toMatchObject(withMatchers(fx.expect.error) as object)
  } else {
    expect(out).toHaveProperty('result')
    expect((out as { result: unknown }).result).toMatchObject(withMatchers(fx.expect.result) as object)
  }
}

describe('synthetic recordings', () => {
  it('cover every call kind the vault makes, an empty page of each list, and the two failures', () => {
    const fixtures = files.map(load)
    const kinds = new Set<string>(fixtures.map((f) => f.recording.kind))
    for (const k of ['token_refresh', 'token_exchange', 'profile', 'send_as', 'history_list', 'messages_list', 'message_full', 'message_raw', 'attachment_get', 'watch', 'stop']) expect(kinds.has(k)).toBe(true)
    const names = new Set(fixtures.map((f) => f.name))
    for (const n of ['history-list-empty', 'messages-list-empty', 'history-list-404', 'token-refresh-invalid-grant', 'watch-403']) expect(names.has(n)).toBe(true)
    expect(fixtures.every((f) => f.recording.source === 'synthetic' || f.recording.source === 'recorded')).toBe(true)
  })
  it('the committed files are exactly what the recorder makes from the documented shapes (the generator is not stale)', async () => {
    const built = await buildSyntheticRecordings()
    expect(built.map((b) => b.name).sort()).toEqual(files.filter((f) => load(f).recording.source === 'synthetic').map((f) => load(f).name).sort())
    for (const b of built) expect(load(`${b.name}.json`)).toEqual(b)
  })
})

describe('replay through the real parsers', () => {
  for (const f of files) it(`${f}`, async () => check(load(f)))

  it('every fixture is replayed (a new file is picked up with no test code)', () => {
    expect(files.length).toBeGreaterThanOrEqual(25)
  })

  it('absence mutation: a list page without its `messages` member no longer replays', async () => {
    const fx = load('messages-list.json')
    const body = fx.recording.response.body as Record<string, unknown>
    delete body.messages
    await expect(check(fx)).rejects.toThrow()
  })
  it('absence mutation: a profile without historyId, a history page without `history`, a full message without its attachment part no longer replay', async () => {
    const profile = load('profile.json')
    delete (profile.recording.response.body as Record<string, unknown>).historyId
    await expect(check(profile)).rejects.toThrow()
    const hist = load('history-list.json')
    delete (hist.recording.response.body as Record<string, unknown>).history
    await expect(check(hist)).rejects.toThrow()
    const full = load('message-full.json')
    ;(full.recording.response.body as { payload: { parts: unknown[] } }).payload.parts.pop()
    await expect(check(full)).rejects.toThrow()
  })
  it('absence mutation: an attachment whose data summary is shortened no longer matches its expectation', async () => {
    const fx = load('attachment.json')
    ;((fx.recording.response.body as { data: { length: number } }).data).length -= 4
    await expect(check(fx)).rejects.toThrow()
  })
})

// [[CHN5]] D86 ([[CHN153b]]): the files of the user's supervised `hq` backfill, committed as they were pulled.
const recordedFiles = files.filter((f) => load(f).recording.source === 'recorded')
describe('recorded files (D86)', () => {
  it('cover the kinds and statuses the real run produced', () => {
    const seen = new Set(recordedFiles.map((f) => `${load(f).recording.kind}:${load(f).recording.response.status}`))
    for (const k of ['token_refresh:200', 'messages_list:200', 'messages_list:403', 'message_full:200', 'message_full:403', 'message_raw:200', 'message_raw:403', 'attachment_get:200', 'history_list:200']) expect(seen.has(k), k).toBe(true)
    expect(recordedFiles.length).toBe(10)
  })
  it('the inbox and the sent message are both there (quoted-printable HTML; a quoted display name equal to the address in a To list)', () => {
    const labels = recordedFiles.map((f) => load(f).recording).filter((r) => r.kind === 'message_full' && r.response.status === 200).map((r) => (r.response.body as { labelIds: string[] }).labelIds)
    expect(labels.some((l) => l.includes('INBOX'))).toBe(true)
    expect(labels.some((l) => l.includes('SENT'))).toBe(true)
  })
  for (const f of recordedFiles) {
    it(`${f}: every string is allow-listed or in mask, pseudonym or <redacted> form`, () => {
      expect(dishonestStrings(load(f).recording)).toEqual([])
    })
  }
  it('absence mutation: one plain word hand-inserted into a recorded file turns the check red', () => {
    for (const [file, edit] of [
      ['recorded-message-full-inbox-200.json', (b: { snippet: string }) => void (b.snippet = 'hello Maria')],
      ['recorded-messages-list-403.json', (b: { error: { errors: Array<{ message: string }> } }) => void (b.error.errors[0]!.message = 'Maria called')],
      ['recorded-history-list-200.json', (b: { history: Array<{ id: string }> }) => void (b.history[0]!.id = 'a b')],
    ] as const) {
      const fx = load(file)
      expect(dishonestStrings(fx.recording)).toEqual([])
      ;(edit as (b: unknown) => void)(fx.recording.response.body)
      expect(dishonestStrings(fx.recording), file).not.toEqual([])
    }
  })
  it('absence mutation: dropping `messages` from the recorded list page turns its replay red', async () => {
    const fx = load('recorded-messages-list-200.json')
    delete (fx.recording.response.body as Record<string, unknown>).messages
    await expect(check(fx)).rejects.toThrow()
  })
  it('absence mutation: a recorded history record without its labelIds turns its replay red', async () => {
    const fx = load('recorded-history-list-200.json')
    delete (fx.recording.response.body as { history: Array<{ messagesAdded: Array<{ message: Record<string, unknown> }> }> }).history[0]!.messagesAdded[0]!.message.labelIds
    await expect(check(fx)).rejects.toThrow()
  })
  it('the generator test covers exactly the synthetic files: a recorded file is never regenerated', async () => {
    const built = await buildSyntheticRecordings()
    expect(built.map((b) => b.name).some((n) => n.startsWith('recorded-'))).toBe(false)
  })
})

// [[CHN5]] D86 ([[CHN153b]]): the synthetic files are aligned to the recorded ones. For every observed kind the key-path set of the synthetic response equals the
// recorded one, apart from members that only the synthetic file carries because it covers a shape the real run did not reach (each with its reason).
type J = null | boolean | number | string | J[] | { [k: string]: J }
const keyPaths = (v: J, at = ''): string[] => (Array.isArray(v) ? v.flatMap((e) => keyPaths(e, `${at}[]`)) : v !== null && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => keyPaths(x, `${at}.${k}`)) : [at])
const pathSet = (name: string): string[] => [...new Set(keyPaths(load(`${name}.json`).recording.response.body as J))].sort()
const ONLY_SYNTHETIC: Record<string, string[]> = {
  // The synthetic message carries an attachment part (D51, #160: not observed) and an RFC 2047 subject; the real sample had two text parts.
  'message-full': ['.payload.parts[].body.attachmentId'],
  // The synthetic page also has a labels-only record and a record with no messagesAdded (the kinds capture ignores, D6); the real page had only messagesAdded records.
  'history-list': ['.history[].labelsAdded[].labelIds[]', '.history[].labelsAdded[].message.id', '.history[].labelsAdded[].message.threadId', '.nextPageToken'],
  // The real refresh's id_token summary is the same, so nothing is listed for the token.
}
describe('synthetic and recorded files agree (D86)', () => {
  const pairs: Array<[string, string]> = [
    ['recorded-token-refresh-200', 'token-refresh-ok'],
    ['recorded-messages-list-200', 'messages-list'],
    ['recorded-message-full-inbox-200', 'message-full'],
    ['recorded-message-full-sent-200', 'message-full'],
    ['recorded-message-raw-200', 'message-raw'],
    ['recorded-attachment-get-200', 'attachment'],
    ['recorded-history-list-200', 'history-list'],
    ['recorded-messages-list-403', 'messages-list-403'],
    ['recorded-message-full-403', 'messages-list-403'],
    ['recorded-message-raw-403', 'messages-list-403'],
  ]
  for (const [rec, syn] of pairs) {
    it(`${syn} has the key paths of ${rec}`, () => {
      const extra = ONLY_SYNTHETIC[syn] ?? []
      const want = pathSet(rec)
      const have = pathSet(syn).filter((p) => !extra.includes(p))
      expect({ missing: want.filter((p) => !have.includes(p)), extra: have.filter((p) => !want.includes(p)) }).toEqual({ missing: [], extra: [] })
    })
  }
})


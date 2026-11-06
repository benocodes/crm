import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildSyntheticRecordings } from '../../test/google-recordings.js'
import { replay, type RecordingFixture } from '../../test/recording-replay.js'

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
    for (const k of ['token_refresh', 'token_exchange', 'profile', 'send_as', 'history_list', 'messages_list', 'message_full', 'message_raw', 'attachment_get']) expect(kinds.has(k)).toBe(true)
    const names = new Set(fixtures.map((f) => f.name))
    for (const n of ['history-list-empty', 'messages-list-empty', 'history-list-404', 'token-refresh-invalid-grant']) expect(names.has(n)).toBe(true)
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
    expect(files.length).toBeGreaterThanOrEqual(15)
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

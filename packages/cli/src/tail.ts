import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { CliError, usage } from './errors.js'
import { apiError, sendRequest } from './http.js'
import { parseInvocation } from './invoke.js'
import type { Command, Deps } from './types.js'

/** What `tail` needs per request: resolved each time, so an OAuth grant is refreshed ahead of expiry in a long `--follow` ([[API6]] D20). */
export type Credential = () => Promise<{ server: string; key: string; refresh?: (rejected: string) => Promise<string> }>

export const TAIL_USAGE = `vibase events tail [--after <id>] [--follow] [--interval <seconds>] [--cursor-file <path>] [--type <t>] [--resource-type <t>] [--resource-id <id>] [--limit <n>]`

export const TAIL_HELP = `${TAIL_USAGE}

Prints the workspace's events after a position, one compact JSON record per line, in order, then exits 0.
With --follow it sleeps --interval seconds (a number >= 1, default 5) and polls again after the last printed event.

  --after <id>         start after this event (the first run only: a non-empty --cursor-file wins)
  --cursor-file <path> read the position from the file and rewrite it (temp file and rename) after every printed event, so
                       a restart resumes; an event is printed before the file is written, so delivery is at least once
  --type, --resource-type, --resource-id, --limit   pass through to events.list (limit is the page size)

An API or network error ends the run with exit 1 and leaves the file as it was; run it again to resume.
A malformed cursor file or a bad flag is exit 2.
`

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The saved position: `undefined` when the file is missing or empty; a usage error naming the file when it is anything but one id. */
async function readCursor(path: string): Promise<string | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw usage(`cannot read the cursor file ${path}: ${e instanceof Error ? e.message : 'error'}`, 'cursor_file_invalid')
  }
  if (text.trim() === '') return undefined
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  if (lines.length !== 1 || !UUID.test(lines[0]!.trim())) throw usage(`the cursor file ${path} must hold one event id and nothing else: fix it or delete it to start from the beginning`, 'cursor_file_invalid')
  return lines[0]!.trim()
}

/** Replaces the file by rename, so no reader (or crash) ever sees a partial file. The temp file is beside it: a rename across filesystems is not atomic. */
async function writeCursor(path: string, id: string): Promise<void> {
  const tmp = `${path}.tmp`
  try {
    await writeFile(tmp, id + '\n')
    await rename(tmp, path)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw new CliError(1, 'cursor_file_failed', `cannot write the cursor file ${path}: ${e instanceof Error ? e.message : 'error'}`)
  }
}

/**
 * `vibase events tail` ([[API6]] D9, [[API215]]): pages `events.list`, prints each event as one JSON line, and optionally keeps polling.
 * Runs on the same request path as every command (origin check, bearer, OAuth refresh).
 */
export async function tail(list: Command, args: string[], credential: Credential, deps: Deps): Promise<number> {
  let values: Record<string, string | boolean | undefined>
  try {
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        after: { type: 'string' },
        follow: { type: 'boolean' },
        interval: { type: 'string' },
        'cursor-file': { type: 'string' },
        type: { type: 'string' },
        'resource-type': { type: 'string' },
        'resource-id': { type: 'string' },
        limit: { type: 'string' },
        // the flags every command shares, already applied by the caller
        server: { type: 'string' },
        profile: { type: 'string' },
        refresh: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    })
    if (parsed.positionals.length > 0) throw new Error(`unexpected argument "${parsed.positionals[0]}"`)
    values = parsed.values
  } catch (e) {
    throw usage(`${e instanceof Error ? e.message.split('. ')[0] : 'invalid arguments'}\nusage: ${TAIL_USAGE}`)
  }
  const follow = values.follow === true
  let intervalSeconds = 5
  if (values.interval !== undefined) {
    if (!follow) throw usage('--interval applies with --follow only')
    const raw = values.interval as string
    intervalSeconds = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(intervalSeconds) || intervalSeconds < 1) throw usage('--interval takes a number of seconds, at least 1')
  }
  // The filters go through the derived command, so they are typed and checked exactly as `events list` checks them.
  const filterArgs: string[] = []
  for (const name of ['type', 'resource-type', 'resource-id', 'limit']) if (typeof values[name] === 'string') filterArgs.push(`--${name}`, values[name] as string)
  const inv = await parseInvocation(list, filterArgs, { readFile: async () => '', readStdin: async () => '' })
  const baseQuery = inv.query.filter(([k]) => k !== 'after')

  const cursorFile = values['cursor-file'] as string | undefined
  const saved = cursorFile === undefined ? undefined : await readCursor(cursorFile)
  let last: string | undefined = saved ?? (values.after as string | undefined)

  const page = async (after: string | undefined) => {
    const query: [string, string][] = after === undefined ? baseQuery : [...baseQuery, ['after', after]]
    const c = await credential()
    let key = c.key
    let res = await sendRequest(list, inv, query, key, deps, c.server)
    if (res.status === 401 && c.refresh) {
      await res.body?.cancel().catch(() => undefined)
      key = await c.refresh(key)
      res = await sendRequest(list, inv, query, key, deps, c.server)
    }
    if (!res.ok) throw await apiError(res)
    const body = (await res.json().catch(() => undefined)) as { data?: unknown[]; next_cursor?: unknown } | undefined
    if (!body || !Array.isArray(body.data)) throw new CliError(1, 'invalid_response', 'a list response had no data array')
    return body as { data: { id?: unknown }[]; next_cursor?: unknown }
  }

  for (;;) {
    let next: unknown
    do {
      const sent = last
      const body = await page(sent)
      for (const event of body.data) {
        if (typeof event.id !== 'string') throw new CliError(1, 'invalid_response', 'an event had no id')
        await deps.stdout.write(JSON.stringify(event) + '\n')
        last = event.id
        if (cursorFile !== undefined) await writeCursor(cursorFile, event.id)
      }
      next = body.next_cursor
      if (typeof next === 'string' && next !== '' && next === sent) throw new CliError(1, 'invalid_response', 'the server repeated a cursor; stopping')
    } while (typeof next === 'string' && next !== '')
    if (!follow || deps.signal?.aborted) return 0
    await deps.sleep(intervalSeconds * 1000)
    if (deps.signal?.aborted) return 0
  }
}

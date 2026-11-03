import { open, rename, rm } from 'node:fs/promises'
import { CliError, usage } from './errors.js'
import type { Command, Deps, Invocation } from './types.js'

export const json = (deps: Deps, sink: 'stdout' | 'stderr', value: unknown) => deps[sink].write(JSON.stringify(value, null, deps[sink].isTTY ? 2 : undefined) + '\n')

const network = (url: string, e: unknown) => new CliError(1, 'network_error', `could not reach ${url}: ${e instanceof Error ? e.message : 'request failed'}`)

/** The API's own `{ error: { code, message } }` when the body has it; otherwise one built from the status. */
async function apiError(res: Response): Promise<CliError> {
  const text = await res.text().catch(() => '')
  try {
    const body = JSON.parse(text)
    if (typeof body?.error?.code === 'string' && typeof body.error.message === 'string') return new CliError(1, body.error.code, body.error.message)
  } catch {
    // not JSON
  }
  return new CliError(1, `http_${res.status}`, text.trim().slice(0, 200) || res.statusText || `HTTP ${res.status}`)
}

/** Runs one invocation against `server` with `key` and prints the result ([[API6]] D8, D14). Returns the exit code. */
export async function execute(cmd: Command, inv: Invocation, conn: { server: string; key: string }, deps: Deps): Promise<number> {
  const toStdout = cmd.binary && (inv.output === undefined || inv.output === '-')
  if (cmd.binary && inv.output === undefined && deps.stdout.isTTY) throw usage('this command returns bytes: pass --output <path>, or --output - to write them to the terminal')

  const send = async (query: [string, string][]): Promise<Response> => {
    // The path comes from a document the server served: it must stay on the server's origin, whatever it contains.
    const url = new URL(inv.path, conn.server)
    if (url.origin !== conn.server || !inv.path.startsWith('/') || inv.path.startsWith('//')) throw usage(`refusing to send the credential to ${url.origin}: ${cmd.operationId} is not on ${conn.server}`, 'origin_mismatch')
    for (const [k, v] of query) url.searchParams.append(k, v)
    const headers: Record<string, string> = { authorization: `Bearer ${conn.key}`, 'user-agent': `vibase-cli/${deps.version}`, accept: cmd.binary ? '*/*' : 'application/json' }
    let body: string | undefined
    if (inv.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(inv.body)
    }
    try {
      return await deps.fetch(url.toString(), { method: cmd.method, headers, body, redirect: 'error' })
    } catch (e) {
      throw network(url.origin + url.pathname, e)
    }
  }

  if (cmd.binary) {
    const res = await send(inv.query)
    if (!res.ok) throw await apiError(res)
    if (toStdout) {
      try {
        if (res.body) for await (const chunk of res.body) await deps.stdout.write(chunk)
      } catch (e) {
        throw new CliError(1, 'download_failed', e instanceof Error ? e.message : 'the download failed')
      }
      return 0
    }
    // Never a name from Content-Disposition: only the path the caller gave.
    const target = inv.output!
    const partial = `${target}.partial`
    const fh = await open(partial, 'w').catch((e) => {
      throw usage(`cannot write ${partial}: ${e instanceof Error ? e.message : 'error'}`)
    })
    try {
      if (res.body) for await (const chunk of res.body) await fh.write(chunk)
      await fh.close()
      await rename(partial, target)
    } catch (e) {
      await fh.close().catch(() => undefined)
      await rm(partial, { force: true })
      throw new CliError(1, 'download_failed', e instanceof Error ? e.message : 'the download failed')
    }
    return 0
  }

  if (inv.all) {
    let query = inv.query
    const seen = new Set<string>()
    for (;;) {
      const res = await send(query)
      if (!res.ok) throw await apiError(res)
      const page = (await res.json().catch(() => undefined)) as { data?: unknown[]; next_cursor?: unknown } | undefined
      if (!page || !Array.isArray(page.data)) throw new CliError(1, 'invalid_response', 'a list response had no data array')
      for (const item of page.data) await deps.stdout.write(JSON.stringify(item) + '\n')
      const next = page.next_cursor
      if (typeof next !== 'string' || next === '') return 0
      if (seen.has(next)) throw new CliError(1, 'invalid_response', 'the server repeated a cursor; stopping')
      seen.add(next)
      query = [...inv.query.filter(([k]) => k !== 'after'), ['after', next]]
    }
  }

  const res = await send(inv.query)
  if (!res.ok) throw await apiError(res)
  const text = await res.text()
  if (res.status === 204 || text === '') return 0
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CliError(1, 'invalid_response', 'the response was not JSON')
  }
  await json(deps, 'stdout', parsed)
  return 0
}

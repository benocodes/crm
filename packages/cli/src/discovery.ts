import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mergeDocuments } from './derive.js'
import { CliError, usage } from './errors.js'
import type { Deps, Operation } from './types.js'

export interface Discovered {
  ops: Operation[]
  /** The operations were fetched by this call, not read from the cache. */
  fresh: boolean
}

export const CACHE_TTL_MS = 60 * 60 * 1000
const CACHE_VERSION = 1

async function getJson(url: string, deps: Deps): Promise<unknown> {
  let res: Response
  try {
    res = await deps.fetch(url, { headers: { accept: 'application/json', 'user-agent': `vibase-cli/${deps.version}` }, redirect: 'error' })
  } catch (e) {
    throw new CliError(1, 'network_error', `could not reach ${url}: ${e instanceof Error ? e.message : 'request failed'}`)
  }
  if (!res.ok) throw usage(`${url} answered ${res.status}: this does not look like a Vibase instance`, 'discovery_failed')
  try {
    return await res.json()
  } catch {
    throw usage(`${url} did not answer JSON`, 'discovery_failed')
  }
}

const str = (v: unknown): v is string => typeof v === 'string' && v !== ''

/**
 * The operations of the instance at `server` (an origin): from the cache when it is under an hour old, else from
 * `/.well-known/vibase` and the two OpenAPI documents it names ([[API6]] D7). Neither request carries a credential.
 * Both document URLs must share the server's origin (D18) and are checked before either is fetched.
 */
export async function discover(server: string, deps: Deps, opts: { cacheDir: string; refresh: boolean }): Promise<Discovered> {
  const file = join(opts.cacheDir, `discovery-${createHash('sha256').update(server).digest('hex').slice(0, 16)}.json`)
  if (!opts.refresh) {
    try {
      const c = JSON.parse(readFileSync(file, 'utf8'))
      const age = deps.now() - c.fetched_at
      if (c.version === CACHE_VERSION && c.server === server && Array.isArray(c.ops) && age >= 0 && age < CACHE_TTL_MS) return { ops: c.ops as Operation[], fresh: false }
    } catch {
      // no cache, or an unreadable one: discover
    }
  }
  const wkUrl = `${server}/.well-known/vibase`
  const wk = (await getJson(wkUrl, deps)) as any
  const docs = { api: wk?.openapi?.api, meta: wk?.openapi?.meta }
  if (!str(docs.api) || !str(docs.meta)) throw usage(`${wkUrl} has no openapi.api and openapi.meta URLs`, 'discovery_failed')
  for (const [name, url] of Object.entries(docs) as [string, string][]) {
    let origin: string | undefined
    try {
      origin = new URL(url).origin
    } catch {
      // not a URL
    }
    if (origin !== server) throw usage(`${wkUrl} names the ${name} document at ${url}, which is not on ${server}: refusing to continue`, 'origin_mismatch')
  }
  const [api, meta] = await Promise.all([getJson(docs.api, deps), getJson(docs.meta, deps)])
  const ops = mergeDocuments([{ source: 'api', doc: api }, { source: 'meta', doc: meta }])
  try {
    mkdirSync(opts.cacheDir, { recursive: true })
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, server, fetched_at: deps.now(), ops }))
      renameSync(tmp, file)
    } catch (e) {
      try {
        unlinkSync(tmp)
      } catch {
        // gone
      }
      throw e
    }
  } catch {
    // the cache is an optimisation
  }
  return { ops, fresh: true }
}

// The Cloudflare API reads of `vibase-server setup` ([[OPS496]] D1, D4, P1): the Worker's settings, its custom domains, the workers.dev subdomain and the R2 bucket, over the
// injected `fetch` and the secrets file's account id and token. Read-only, and never a request to the instance's own host. Shapes were probed read-only on `smoked1` (decision 496.8).
import type { Credentials } from '../setup/types.js'

const CF = 'https://api.cloudflare.com/client/v4/'

/** A refused or failed read: `status` is the HTTP status, so a detail can say `HTTP 403`. */
export class CfApiError extends Error {
  constructor(
    readonly what: string,
    readonly status: number,
  ) {
    super(`${what} read failed: HTTP ${status}`)
  }
}

/** The Worker as its settings show it: its plain-text bindings and the names of its secrets. */
export interface WorkerSettings {
  plain: Record<string, string>
  secrets: string[]
}

async function get(creds: Credentials, path: string, f: typeof fetch): Promise<{ status: number; body: any }> {
  const res = await f(`${CF}accounts/${creds.accountId}/${path}`, {
    headers: { authorization: `Bearer ${creds.apiToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  let body: any = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body }
}

const hasCode = (body: any, code: number): boolean =>
  Array.isArray(body?.errors) && body.errors.some((e: { code?: unknown }) => e?.code === code)

/** The Worker's settings, or `null` when the script does not exist (code 10007). */
export async function readWorkerSettings(
  creds: Credentials,
  worker: string,
  f: typeof fetch,
): Promise<WorkerSettings | null> {
  const { status, body } = await get(creds, `workers/scripts/${worker}/settings`, f)
  if (hasCode(body, 10007)) return null
  if (status !== 200 || body?.success === false) throw new CfApiError('Worker settings', status)
  const bindings: { type?: unknown; name?: unknown; text?: unknown }[] = body?.result?.bindings ?? []
  const plain: Record<string, string> = {}
  const secrets: string[] = []
  for (const b of bindings) {
    if (typeof b.name !== 'string') continue
    if (b.type === 'plain_text' && typeof b.text === 'string') plain[b.name] = b.text
    if (b.type === 'secret_text') secrets.push(b.name)
  }
  return { plain, secrets }
}

/** The custom-domain hostnames attached to the Worker. */
export async function readDomains(creds: Credentials, worker: string, f: typeof fetch): Promise<string[]> {
  const { status, body } = await get(creds, `workers/domains?service=${encodeURIComponent(worker)}`, f)
  if (status !== 200) throw new CfApiError('custom domains', status)
  return ((body?.result ?? []) as { hostname?: unknown }[]).flatMap((d) =>
    typeof d.hostname === 'string' ? [d.hostname] : [],
  )
}

/** Whether the Worker's workers.dev subdomain is enabled. */
export async function readSubdomainEnabled(creds: Credentials, worker: string, f: typeof fetch): Promise<boolean> {
  const { status, body } = await get(creds, `workers/scripts/${worker}/subdomain`, f)
  if (status !== 200) throw new CfApiError('workers.dev subdomain', status)
  return body?.result?.enabled === true
}

/** Whether the R2 bucket exists (a 404 is absent). */
export async function readBucket(creds: Credentials, bucket: string, f: typeof fetch): Promise<boolean> {
  const { status, body } = await get(creds, `r2/buckets/${encodeURIComponent(bucket)}`, f)
  if (status === 404) return false
  if (status !== 200) throw new CfApiError('R2 bucket', status)
  return typeof body?.result?.name === 'string'
}

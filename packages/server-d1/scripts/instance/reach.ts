// One classifier of a request that got no answer ([[OPS496]] P2, D2, D6): the request threw. `dns` is the sub-case where the name did not resolve
// (`ENOTFOUND` or `EAI_AGAIN`, on the error, its code or its `cause`), used by setup's single `/health` read and by the gate's and the poll's wording.
const DNS = /\b(ENOTFOUND|EAI_AGAIN)\b/

export function isDnsFailure(e: unknown, depth = 0): boolean {
  if (e === null || typeof e !== 'object' || depth > 4) return false
  const x = e as { message?: unknown; code?: unknown; cause?: unknown }
  if (typeof x.code === 'string' && DNS.test(x.code)) return true
  if (typeof x.message === 'string' && DNS.test(x.message)) return true
  return isDnsFailure(x.cause, depth + 1)
}

export type Reach =
  | { answered: false; dns: boolean; reason: string }
  | { answered: true; status: number; body: unknown }

/** One bounded GET: no retry, no sleep. An answer is any response; a throw is "no answer". */
export async function readOnce(f: typeof fetch, url: string, timeoutMs = 10_000): Promise<Reach> {
  let res: Response
  try {
    res = await f(url, {
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    return { answered: false, dns: isDnsFailure(e), reason: e instanceof Error ? e.message : 'request failed' }
  }
  let body: unknown = null
  if (res.status === 200) {
    try {
      body = await res.json()
    } catch {
      body = null
    }
  }
  return { answered: true, status: res.status, body }
}

export const dnsRefusal = (host: string): string =>
  `cannot resolve ${host} from this machine (DNS): if it was just created, wait a few minutes or flush this machine's DNS cache`

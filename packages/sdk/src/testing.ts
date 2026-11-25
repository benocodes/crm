/** Test helpers: an injectable `fetch` that records its calls. Not part of the runtime entry. */
export type Call = { url: string; init: RequestInit }

export function fakeFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} }
    calls.push(call)
    return handler(call)
  }) as typeof fetch
  return Object.assign(fn, { calls })
}

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export const BASE = 'https://api.acme.example'

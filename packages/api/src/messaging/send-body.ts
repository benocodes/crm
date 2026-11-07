import type { ObjectStore } from '../objects/store.js'
import { ApiError } from '../errors.js'
export type SendBody = { sha256: string; size_bytes: number }
export const sendBodyKey = (org: string, hash: string): string => `orgs/${org}/outbound/sha256/${hash}/body.txt`
export async function describeSendBody(body: string): Promise<SendBody> {
  const bytes = new TextEncoder().encode(body)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return {sha256:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''),size_bytes:bytes.byteLength}
}
export async function storeSendBody(store: ObjectStore, org: string, text: string): Promise<SendBody> {
  const body = await describeSendBody(text)
  await store.put(sendBodyKey(org,body.sha256),new TextEncoder().encode(text),{contentType:'text/plain; charset=utf-8'})
  return body
}
const unavailable = () => new ApiError(404,'content_unavailable','authored content is unavailable')
export async function readSendBody(store: ObjectStore, org: string, body: unknown): Promise<string> {
  if (!body || typeof body !== 'object') throw unavailable()
  const d = body as SendBody
  if (!/^[a-f0-9]{64}$/.test(d.sha256) || !Number.isInteger(d.size_bytes) || d.size_bytes < 0 || d.size_bytes > 65536) throw unavailable()
  const object = await store.get(sendBodyKey(org,d.sha256))
  if (!object || object.size !== d.size_bytes) throw unavailable()
  const bytes = new Uint8Array(await new Response(object.body).arrayBuffer())
  let text: string
  try { text = new TextDecoder('utf-8',{fatal:true}).decode(bytes) } catch { throw unavailable() }
  const actual = await describeSendBody(text)
  if (actual.sha256 !== d.sha256 || actual.size_bytes !== d.size_bytes) throw unavailable()
  return text
}

export function requireSendStore(store: ObjectStore | undefined): ObjectStore {
  if (!store) throw new ApiError(503,'objects_unavailable','object storage is not configured')
  return store
}

/** Only authorised get operations call this object stage. Rows, audit producers and all other responses keep descriptors. */
export async function hydrateSendRecord(value: unknown, store: ObjectStore): Promise<unknown> {
  const r = value as Record<string, unknown>
  if (r.operation !== 'messages.send') return value
  const result = {...r}
  for (const field of ['arguments','edited_arguments']) {
    const args = r[field] as Record<string,unknown> | null | undefined
    if (args) result[field] = {...args,body:await readSendBody(store,String(r.organization_id),args.body)}
  }
  return result
}

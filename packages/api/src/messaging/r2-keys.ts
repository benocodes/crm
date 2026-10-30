// The R2 key layout ([[CORE25]] D23, CORE58 P7): one module owns it so the reader and cycle 2's writer agree.
//   message prefix  orgs/<org>/messages/<channel>/<sha256 hex of external_id>      (stored as messages.content_key)
//   body            <content_key>/v<version>/body.md
//   original        <content_key>/v<version>/original.<ext>
//   file prefix     orgs/<org>/files/<object id>                                    (stored as files.storage_key)
//   bytes           <storage_key>/blob

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')

export async function messageContentPrefix(organizationId: string, channel: 'email', externalId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(externalId))
  return `orgs/${organizationId.toLowerCase()}/messages/${channel}/${hex(digest)}`
}

function checkPrefix(prefix: string): void {
  if (prefix === '' || prefix.endsWith('/')) throw new Error('an object key prefix must be non-empty and have no trailing slash')
}
function checkVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) throw new Error('a message version is an integer of at least 1')
}

export function messageBodyKey(contentKey: string, version: number): string {
  checkPrefix(contentKey)
  checkVersion(version)
  return `${contentKey}/v${version}/body.md`
}

export function messageOriginalKey(contentKey: string, version: number, ext: 'eml' | 'json'): string {
  checkPrefix(contentKey)
  checkVersion(version)
  return `${contentKey}/v${version}/original.${ext}`
}

export function fileObjectPrefix(organizationId: string, objectId: string): string {
  return `orgs/${organizationId.toLowerCase()}/files/${objectId.toLowerCase()}`
}

export function fileBlobKey(storageKey: string): string {
  checkPrefix(storageKey)
  return `${storageKey}/blob`
}

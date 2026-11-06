// [[AGT8]] D51: the identity of an execution's input. `inputHash` is the SHA-256 of the canonical JSON of the operation name and its final arguments, so
// a repeated call with the same key is recognised whatever the order of its fields, and a changed call (or another operation) under the key is not.

/** JSON with object keys sorted at every depth (arrays keep their order); `undefined` fields are dropped as `JSON.stringify` does. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')

export async function inputHash(operation: string, args: Record<string, unknown>): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson({ operation, arguments: args }))))
}

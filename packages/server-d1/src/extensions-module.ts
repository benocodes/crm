// The extensions file as the Worker holds it ([[CORE315]] D12, D28, D29; [[CORE543]]): the Text module `vibase-extensions.json`, parsed once at start with the same validator the tooling used. A valid file becomes the definitions the
// composition hands to every registry it builds; an invalid one fails the Worker closed. Node-safe (no `cloudflare:` import), so a test passes any text.
import { defineCustomObject, parseExtensionsFile, type AnyResource } from '@vibase/api'

export const EXTENSIONS_INVALID_CODE = 'extensions_invalid'
/** The 503 body of every route but `/health` while the attached file cannot be loaded ([[CORE315]] D28). */
export const EXTENSIONS_INVALID = {
  error: {
    code: EXTENSIONS_INVALID_CODE,
    message: 'the attached extensions file is invalid: redeploy with a valid one',
  },
}

export interface AttachedExtensions {
  /** The module's text, the bytes the digest is taken over. */
  text: string
  /** Sorted `<key>__c` names; empty when the file declares none or could not be loaded. */
  objects: string[]
  definitions: AnyResource[]
  /** Set when the file could not be loaded; the rule code and path of the refusal, for the log only (never in a response). */
  error?: { rule: string; path: string }
}

export function readExtensions(text: string): AttachedExtensions {
  try {
    const file = parseExtensionsFile(text)
    const keys = Object.keys(file.objects).sort()
    return { text, objects: keys, definitions: keys.map((k) => defineCustomObject(k, file.objects[k]!)) }
  } catch (e) {
    const rule = (e as { rule?: unknown }).rule
    const path = (e as { path?: unknown }).path
    return {
      text,
      objects: [],
      definitions: [],
      error: { rule: typeof rule === 'string' ? rule : 'unreadable', path: typeof path === 'string' ? path : '' },
    }
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** What `/health.extensions` says ([[CORE543]] P1): `null` when the module declares no objects, else the digest and the names, or the digest and the error marker. */
export async function extensionsHealth(
  a: AttachedExtensions | undefined,
): Promise<null | { digest: string; objects: string[] } | { digest: string; error: string }> {
  if (a === undefined) return null
  if (a.error) return { digest: await sha256Hex(a.text), error: EXTENSIONS_INVALID_CODE }
  if (a.objects.length === 0) return null
  return { digest: await sha256Hex(a.text), objects: a.objects }
}

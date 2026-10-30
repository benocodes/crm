// Header builders for binary responses ([[CORE58]] P10). `mime_type` and `name` come from a mail sender (untrusted):
// no CR/LF or parameter can reach a header.

const TOKEN = '[a-z0-9][a-z0-9!#$&^_.+-]*'
const MIME = new RegExp(`^${TOKEN}/${TOKEN}$`)

/** `type/subtype` when the value is a valid lowercase token pair (parameters dropped), else `application/octet-stream`. */
export function safeContentType(mime: string): string {
  // A control character anywhere (a CR/LF smuggling a header) makes the whole value untrustworthy, parameters included.
  if (/[\x00-\x1f\x7f]/.test(mime)) return 'application/octet-stream'
  const bare = mime.split(';')[0]!.trim().toLowerCase()
  return MIME.test(bare) ? bare : 'application/octet-stream'
}

/** `attachment` with an ASCII fallback and an RFC 5987 `filename*`. */
export function contentDisposition(rawName: string): string {
  const name = rawName.replace(/\p{Surrogate}/gu, '\uFFFD')
  const fallback = [...name].map((ch) => (ch >= ' ' && ch <= '~' && ch !== '"' && ch !== '\\' ? ch : '_')).join('')
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

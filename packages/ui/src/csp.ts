/** The pages' Content-Security-Policy ([[UI445]] D6): one string, served by `server-d1` (`UI_CSP`) and by the React gallery's run, so the
 *  gallery is checked under the exact policy pages ship. No third-party script, no inline script or style, same-origin calls only.
 *  A plain string module with no imports, so a Worker and a Playwright harness can both read it. */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

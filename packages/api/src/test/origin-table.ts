/** [[API622]] D1/D3: [entry, origin, matches]; run through `originMatches` here and through Better Auth's matcher in `@vibase/auth` (the parity test). */
export const ORIGIN_MATCH_TABLE: [string, string, boolean][] = [
  ['https://*.hq.vibase.ai', 'https://a.hq.vibase.ai', true],
  ['https://*.hq.vibase.ai', 'https://a.b.hq.vibase.ai', true],
  ['https://*.hq.vibase.ai', 'https://hq.vibase.ai', false],
  ['https://*.hq.vibase.ai', 'http://a.hq.vibase.ai', false],
  ['https://*.hq.vibase.ai', 'https://a.hq.vibase.ai:8443', false],
  ['https://*.hq.vibase.ai', 'https://evilhq.vibase.ai', false],
  ['https://*.hq.vibase.ai', 'https://a.hq.vibase.ai.evil.com', false],
  ['https://*.hq.vibase.ai', 'https://xhq.vibase.ai', false],
  ['https://*.hq.vibase.ai:8443', 'https://a.hq.vibase.ai:8443', true],
  ['https://*.hq.vibase.ai:8443', 'https://a.hq.vibase.ai', false],
  ['http://*.localhost:5173', 'http://app.localhost:5173', true],
  ['http://*.localhost:5173', 'http://app.localhost:5174', false],
  ['https://*.workers.dev', 'https://x.y.workers.dev', true],
  ['https://exact.example.com', 'https://exact.example.com', true],
  ['https://exact.example.com', 'https://a.exact.example.com', false],
]

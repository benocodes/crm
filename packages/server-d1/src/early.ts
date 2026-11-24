// Early answers (#522): what the Worker can say from its variables alone, before it loads the composition (the registry, the operations, Gmail, Better Auth) or reads a database.
// Claude web's connector check allows about 5 s; a cold isolate that first loaded everything and read the migration and marker rows from a far colo overran it. The built-in provider only (`AUTH_PROVIDER=better-auth`):
// the answers are the ones the composition gives, and anything this module is unsure of (another provider, a bad variable, a credential on the request) returns `undefined` and goes the full way.
// Imports stay light on purpose: `@vibase/api/discovery`, `@vibase/auth/static-metadata`, the declared-scope list. Nothing here may import the composition, `@vibase/api`'s index or Better Auth.
import {
  discoveryResponse,
  mcpChallenge,
  MCP_PROTECTED_RESOURCE_PATH,
  PROTECTED_RESOURCE_PATH,
} from '@vibase/api/discovery'
import { AUTH_SERVER_METADATA_PATH, staticMetadataResponse } from '@vibase/auth/static-metadata'
import { DECLARED_SCOPES } from './declared-scopes.js'

/** The variables read; a subset of `D1WorkerEnv`, so this module imports none of the composition at runtime. */
export interface EarlyEnv {
  AUTH_PROVIDER?: unknown
  PUBLIC_BASE_URL?: unknown
  CORS_ALLOWED_ORIGINS?: unknown
}

const MCP_PATH = '/mcp'

/** `PUBLIC_BASE_URL` as `parseBuiltInAuthConfig` accepts it (an origin; `https`, or `http://localhost`), normalised to its origin; `undefined` for anything else (the full path then reports the configuration error). */
function baseUrlOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const u = new URL(value.trim())
    const bare = u.pathname === '/' && u.search === '' && u.hash === '' && u.username === '' && u.password === ''
    const ok = u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === 'localhost')
    return bare && ok ? u.origin : undefined
  } catch {
    return undefined
  }
}

/** The CORS origin list as `parseOriginList` reads it, for the allowed-origin test only; `undefined` when an entry is not an origin (the full path reports it). */
function originsOf(value: unknown): string[] | undefined {
  const out: string[] = []
  for (const raw of (typeof value === 'string' ? value : '').split(',')) {
    let entry = raw.trim()
    if (entry === '') continue
    if (entry.endsWith('/')) entry = entry.slice(0, -1)
    if (!/^(https?:\/\/[^/?#\s]+|chrome-extension:\/\/[a-p]{32})$/.test(entry)) return undefined
    out.push(entry)
  }
  return out
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** A custom object's key, as the declaration validator requires it (`custom/declaration.ts`: a lowercase name, at most 40 characters before the suffix). */
const OBJECT_KEY = /^[a-z][a-z0-9]*(_[a-z0-9]+)*__c$/
const CUSTOM_ACTIONS = ['read', 'request_approval', 'write'] as const

/**
 * The declared scopes with the attached module's custom scopes ([[CORE543]] P5), sorted as the registry sorts them. The module is read with `JSON.parse` and a name check of the `objects` keys, nothing more: this file imports no
 * validator, so a module that passes here and fails the validator is answered early with scopes the full path would refuse (`503 extensions_invalid`), a gap the authorization still closes. `undefined`: the module cannot be read this way
 * (the request goes the full way, which answers `503 extensions_invalid` for a bad file). No module, or none with objects, is the static list.
 */
export function declaredScopesWith(text: string | undefined): readonly string[] | undefined {
  if (text === undefined) return DECLARED_SCOPES
  let objects: unknown
  try {
    objects = (JSON.parse(text) as { objects?: unknown } | null)?.objects
  } catch {
    return undefined
  }
  if (typeof objects !== 'object' || objects === null || Array.isArray(objects)) return undefined
  const keys = Object.keys(objects)
  if (keys.some((k) => !OBJECT_KEY.test(k))) return undefined
  if (keys.length === 0) return DECLARED_SCOPES
  return [...DECLARED_SCOPES, ...keys.flatMap((k) => CUSTOM_ACTIONS.map((a) => `${k}:${a}`))].sort()
}

/** `extensionsText`: the attached `vibase-extensions.json` module's text; its custom scopes join the declared list ([[CORE543]] P5). */
export function earlyAnswer(req: Request, env: EarlyEnv, extensionsText?: string): Response | undefined {
  if (typeof env.AUTH_PROVIDER !== 'string' || env.AUTH_PROVIDER.trim() !== 'better-auth') return undefined
  const declared = declaredScopesWith(extensionsText)
  if (declared === undefined) return undefined
  const baseUrl = baseUrlOf(env.PUBLIC_BASE_URL)
  if (baseUrl === undefined) return undefined
  const url = new URL(req.url)

  // The unauthenticated `/mcp` POST: the Origin rule first ([[API106]] D20: any Origin must be on the CORS list), then the 401 and its challenge ([[API106]] D14). A request with a credential, or any other method, goes the full way.
  if (url.pathname === MCP_PATH && req.method === 'POST' && !req.headers.has('authorization')) {
    const allowed = originsOf(env.CORS_ALLOWED_ORIGINS)
    if (allowed === undefined) return undefined
    const origin = req.headers.get('origin')
    if (origin !== null && !allowed.includes(origin))
      return json({ error: { code: 'origin_forbidden', message: 'this origin may not call the MCP endpoint' } }, 403)
    return json({ error: { code: 'unauthenticated', message: 'missing bearer credentials' } }, 401, {
      'www-authenticate': mcpChallenge(url.origin, declared),
      // What the composition's CORS middleware (on only with a non-empty list) adds: the browser must be able to read the challenge.
      ...(allowed.length > 0
        ? {
            'access-control-expose-headers': 'WWW-Authenticate',
            vary: 'Origin',
            ...(origin !== null ? { 'access-control-allow-origin': origin } : {}),
          }
        : {}),
    })
  }

  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') return undefined

  // RFC 8414 path insertion ([[CORE283]] D12): the authorization-server document is config alone.
  if (url.pathname === AUTH_SERVER_METADATA_PATH && req.method !== 'OPTIONS')
    return staticMetadataResponse(baseUrl, declared)

  // The two protected-resource documents (and their preflight). `/.well-known/vibase` needs the sign-in methods and the email configuration, so it stays with the composition.
  if (url.pathname === PROTECTED_RESOURCE_PATH || url.pathname === MCP_PROTECTED_RESOURCE_PATH)
    return discoveryResponse(req, {
      provider: { name: 'better-auth', issuer: `${baseUrl}/auth`, baseUrl },
      declaredScopes: declared,
    })
  return undefined
}

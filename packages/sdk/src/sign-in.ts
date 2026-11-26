import { VibaseError } from './errors.js'

// Browser sign-in (DX624): OAuth authorization code with PKCE against a Better Auth deployment, for an app on its own origin.
// Only WHATWG and Web Crypto globals; no browser global is read until a verb runs (inert at import, DX603 D1).

/** What `sessionStorage` and `localStorage` offer, and all this module needs of a store. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface BrowserSignInOptions {
  /** The deployment's URL; only its origin is used. */
  url: string
  /** The first-party client's id (`oauth_clients.create`). */
  clientId: string
  /** A redirect URI registered on the client, on this page's origin. */
  redirectUri: string
  /** Omitted: no `scope` is sent and the instance grants its default set. Given: `openid offline_access` followed by these. */
  scopes?: string[]
  /** Where the token record lives (default `'session'`); the pending record is always in `sessionStorage`. */
  storage?: 'session' | 'local' | 'memory' | StorageLike
  fetch?: typeof fetch
  /** Tests: the page's address (default `globalThis.location`). */
  location?: { href: string; origin: string }
  /** Default `location.assign`. */
  navigate?: (url: string) => void
  /** Default `history.replaceState`. */
  replaceUrl?: (url: string) => void
  /** Tests: the `sessionStorage` to use (default `globalThis.sessionStorage`). */
  sessionStorage?: StorageLike
}

export interface BrowserSignIn {
  /** Sends the browser to the deployment's authorize endpoint with a fresh PKCE pair; the promise never resolves (the page is leaving). */
  signIn(options?: { returnTo?: string }): Promise<never>
  /** Call on page load: finishes a sign-in when the current URL is the callback, else resolves `null`. */
  handleRedirect(): Promise<{ returnTo: string } | null>
  /**
   * The access token: the stored one while more than 60 s remain, else a refreshed one (single-flight). `null` when signed out, when
   * the grant is gone (a refused refresh clears the record) or when there is nothing to refresh with; rejects when the refresh could
   * not be asked or answered (network, 5xx, a malformed answer), keeping the record. Exactly the `auth` function `createClient` takes.
   */
  token(): Promise<string | null>
  /** True when a token record exists. */
  isSignedIn(): boolean
  /** Forgets this client's records locally; nothing is sent. */
  signOut(): void
}

const MARGIN_MS = 60_000
const CALLBACK_PARAMS = ['code', 'state', 'iss', 'error', 'error_description']

const text = (v: unknown): v is string => typeof v === 'string' && v !== ''
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const randomBase64url = (length: number): string => base64url(globalThis.crypto.getRandomValues(new Uint8Array(length)))

/** The `S256` code challenge of a verifier (RFC 7636 section 4.2). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

/** A store that falls back to memory, for the life of the page, once the real storage throws or is absent. */
function guarded(get: () => StorageLike | undefined): StorageLike {
  const memory = new Map<string, string>()
  let broken = false
  const backing = (): StorageLike | undefined => {
    if (broken) return undefined
    try {
      const store = get()
      if (store) return store
    } catch {
      /* private mode, blocked site data */
    }
    broken = true
    return undefined
  }
  return {
    getItem(key) {
      const store = backing()
      if (store)
        try {
          return store.getItem(key)
        } catch {
          broken = true
        }
      return memory.get(key) ?? null
    },
    setItem(key, value) {
      const store = backing()
      if (store)
        try {
          store.setItem(key, value)
          return
        } catch {
          broken = true
        }
      memory.set(key, value)
    },
    removeItem(key) {
      const store = backing()
      if (store)
        try {
          store.removeItem(key)
        } catch {
          broken = true
        }
      memory.delete(key)
    },
  }
}

interface Discovery {
  issuer: string
  resource: string
  authorizationEndpoint: string
  tokenEndpoint: string
}
interface PendingRecord {
  state: string
  verifier: string
  redirect_uri: string
  return_to: string
  created_at: number
}
interface TokenRecord {
  access_token: string
  expires_at: number
  refresh_token?: string
}

/**
 * Browser sign-in for one app (one client id, one deployment), Better Auth deployments only (DX624). The returned `token` is the
 * credential function `createClient` accepts: `createClient({ url, auth: signIn.token })`.
 */
export function browserSignIn(options: BrowserSignInOptions): BrowserSignIn {
  const origin = new URL(options.url).origin
  const keyBase = `vibase.sign-in:${origin}:${options.clientId}`
  const tokenKey = `${keyBase}:token`
  const pendingKey = `${keyBase}:pending`
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const sessionStore = (): StorageLike | undefined => options.sessionStorage ?? globalThis.sessionStorage
  const pending = guarded(sessionStore)
  const tokens = ((): StorageLike => {
    const form = options.storage ?? 'session'
    if (form === 'session') return guarded(sessionStore)
    if (form === 'local') return guarded(() => globalThis.localStorage)
    if (form === 'memory') return guarded(() => undefined)
    return guarded(() => form)
  })()
  const page = (): { href: string; origin: string } | undefined => options.location ?? globalThis.location

  const network = (e: unknown) => new VibaseError(0, 'network_error', e instanceof Error ? e.message : String(e))

  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(url, { ...init, credentials: 'omit', redirect: 'error' })
    } catch (e) {
      throw network(e)
    }
  }
  async function getJson(url: string): Promise<{ status: number; body: unknown }> {
    const res = await send(url, { method: 'GET', headers: { accept: 'application/json' } })
    return { status: res.status, body: await res.json().catch(() => undefined) }
  }

  async function discoverOnce(): Promise<Discovery> {
    const doc = await getJson(`${origin}/.well-known/vibase`)
    if (doc.status !== 200 || !isObject(doc.body))
      throw new VibaseError(0, 'discovery_failed', `${origin}/.well-known/vibase answered ${doc.status}`)
    const auth = doc.body.auth
    if (!isObject(auth) || auth.provider !== 'better-auth')
      throw new VibaseError(0, 'unsupported_provider', 'browser sign-in needs a Better Auth deployment')
    if (!text(auth.issuer) || !text(auth.resource))
      throw new VibaseError(0, 'discovery_failed', 'the discovery document names no issuer or resource')
    let issuerUrl: URL
    try {
      issuerUrl = new URL(auth.issuer)
    } catch {
      throw new VibaseError(0, 'discovery_failed', 'the issuer is not a URL')
    }
    const loopback = issuerUrl.hostname === 'localhost' || issuerUrl.hostname === '127.0.0.1'
    if (issuerUrl.protocol !== 'https:' && !(issuerUrl.protocol === 'http:' && loopback))
      throw new VibaseError(0, 'insecure_issuer', `the issuer ${auth.issuer} is not https`)
    const path = issuerUrl.pathname === '/' ? '' : issuerUrl.pathname
    const meta = await getJson(`${issuerUrl.origin}/.well-known/oauth-authorization-server${path}`)
    if (meta.status !== 200 || !isObject(meta.body))
      throw new VibaseError(0, 'discovery_failed', `the authorization server metadata answered ${meta.status}`)
    const metadata = meta.body
    if (metadata.issuer !== auth.issuer)
      throw new VibaseError(0, 'issuer_mismatch', 'the metadata names another issuer')
    const endpoint = (name: string): string => {
      const value = metadata[name]
      if (!text(value)) throw new VibaseError(0, 'discovery_failed', `the metadata has no ${name}`)
      let url: URL
      try {
        url = new URL(value)
      } catch {
        throw new VibaseError(0, 'endpoint_origin', `${name} is not a URL`)
      }
      if (url.origin !== issuerUrl.origin)
        throw new VibaseError(0, 'endpoint_origin', `${name} is not on the issuer's origin`)
      return url.toString()
    }
    const authorizationEndpoint = endpoint('authorization_endpoint')
    const tokenEndpoint = endpoint('token_endpoint')
    const methods = metadata.code_challenge_methods_supported
    if (!Array.isArray(methods) || !methods.includes('S256'))
      throw new VibaseError(0, 'discovery_failed', 'the authorization server does not offer S256')
    return { issuer: auth.issuer, resource: auth.resource, authorizationEndpoint, tokenEndpoint }
  }
  let discovery: Promise<Discovery> | undefined
  /** Lazy, cached per sign-in object; a failure is not cached. */
  function discover(): Promise<Discovery> {
    if (discovery) return discovery
    const attempt = discoverOnce()
    discovery = attempt
    attempt.catch(() => {
      if (discovery === attempt) discovery = undefined
    })
    return attempt
  }

  function readToken(): TokenRecord | null {
    const raw = tokens.getItem(tokenKey)
    if (raw === null) return null
    try {
      const value: unknown = JSON.parse(raw)
      if (isObject(value) && text(value.access_token) && typeof value.expires_at === 'number')
        return {
          access_token: value.access_token,
          expires_at: value.expires_at,
          ...(text(value.refresh_token) ? { refresh_token: value.refresh_token } : {}),
        }
    } catch {
      /* unparseable: signed out */
    }
    tokens.removeItem(tokenKey)
    return null
  }
  function readPending(): PendingRecord | null {
    const raw = pending.getItem(pendingKey)
    if (raw === null) return null
    try {
      const value: unknown = JSON.parse(raw)
      if (
        isObject(value) &&
        text(value.state) &&
        text(value.verifier) &&
        text(value.redirect_uri) &&
        typeof value.return_to === 'string'
      )
        return value as unknown as PendingRecord
    } catch {
      /* unparseable: no pending record */
    }
    return null
  }

  /** `returnTo` as a same-origin path + query + hash, or `invalid_return_to`. */
  function resolveReturnTo(requested: string | undefined): string {
    const here = page()
    const base = here?.href ?? options.redirectUri
    const hereOrigin = here?.origin ?? new URL(options.redirectUri).origin
    let url: URL
    try {
      url = new URL(requested ?? (here ? here.href : '/'), base)
    } catch {
      throw new VibaseError(0, 'invalid_return_to', 'returnTo is not a URL')
    }
    if (url.origin !== hereOrigin)
      throw new VibaseError(0, 'invalid_return_to', "returnTo must be on this page's origin")
    return url.pathname + url.search + url.hash
  }

  async function signIn(o: { returnTo?: string } = {}): Promise<never> {
    const returnTo = resolveReturnTo(o.returnTo)
    const d = await discover()
    const verifier = randomBase64url(32)
    const state = randomBase64url(16)
    const challenge = await pkceChallenge(verifier)
    const record: PendingRecord = {
      state,
      verifier,
      redirect_uri: options.redirectUri,
      return_to: returnTo,
      created_at: Date.now(),
    }
    pending.setItem(pendingKey, JSON.stringify(record))
    const url = new URL(d.authorizationEndpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', options.clientId)
    url.searchParams.set('redirect_uri', options.redirectUri)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', state)
    url.searchParams.set('resource', d.resource)
    if (options.scopes)
      url.searchParams.set('scope', [...new Set(['openid', 'offline_access', ...options.scopes])].join(' '))
    const go = options.navigate ?? ((u: string) => globalThis.location.assign(u))
    go(url.toString())
    return new Promise<never>(() => {})
  }

  async function exchange(d: Discovery, code: string, record: PendingRecord): Promise<void> {
    const res = await send(d.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: record.verifier,
        redirect_uri: record.redirect_uri,
        client_id: options.clientId,
        resource: d.resource,
      }).toString(),
    })
    const body: unknown = await res.json().catch(() => undefined)
    if (
      res.status === 200 &&
      isObject(body) &&
      text(body.access_token) &&
      typeof body.expires_in === 'number' &&
      Number.isFinite(body.expires_in)
    ) {
      const stored: TokenRecord = {
        access_token: body.access_token,
        expires_at: Date.now() + body.expires_in * 1000,
        ...(text(body.refresh_token) ? { refresh_token: body.refresh_token } : {}),
      }
      tokens.setItem(tokenKey, JSON.stringify(stored))
      return
    }
    const error = isObject(body) && text(body.error) ? body.error : 'invalid_response'
    const description = isObject(body) && text(body.error_description) ? `: ${body.error_description}` : ''
    throw new VibaseError(res.status, error, `the token endpoint refused (${error})${description}`)
  }

  /** Refreshes the sign-in whose stored record was `raw`; whatever it learns is applied only while that record is still the stored one (P3). */
  async function refresh(record: TokenRecord & { refresh_token: string }, raw: string): Promise<string | null> {
    const d = await discover()
    const res = await send(d.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: record.refresh_token,
        client_id: options.clientId,
        resource: d.resource,
      }).toString(),
    })
    const body: unknown = await res.json().catch(() => undefined)
    const unchanged = tokens.getItem(tokenKey) === raw
    if (
      res.status === 200 &&
      isObject(body) &&
      text(body.access_token) &&
      typeof body.expires_in === 'number' &&
      Number.isFinite(body.expires_in)
    ) {
      if (!unchanged) return null
      const stored: TokenRecord = {
        access_token: body.access_token,
        expires_at: Date.now() + body.expires_in * 1000,
        refresh_token: text(body.refresh_token) ? body.refresh_token : record.refresh_token,
      }
      tokens.setItem(tokenKey, JSON.stringify(stored))
      return stored.access_token
    }
    if (res.status === 400 || res.status === 401) {
      if (unchanged) tokens.removeItem(tokenKey)
      return null
    }
    if (res.status === 200)
      throw new VibaseError(200, 'invalid_response', 'the token endpoint answered without an access token')
    const error = isObject(body) && text(body.error) ? body.error : `http_${res.status}`
    const description = isObject(body) && text(body.error_description) ? `: ${body.error_description}` : ''
    throw new VibaseError(res.status, error, `the token endpoint could not refresh (${error})${description}`)
  }
  let refreshing: Promise<string | null> | undefined

  async function token(): Promise<string | null> {
    const record = readToken()
    if (!record) return null
    if (record.expires_at - Date.now() > MARGIN_MS) return record.access_token
    if (!record.refresh_token) {
      tokens.removeItem(tokenKey) // P2: expired and nothing to refresh with: signed out, so isSignedIn() agrees
      return null
    }
    if (refreshing) return refreshing
    const raw = tokens.getItem(tokenKey) as string
    const attempt = refresh({ ...record, refresh_token: record.refresh_token }, raw).finally(() => {
      if (refreshing === attempt) refreshing = undefined
    })
    refreshing = attempt
    return attempt
  }

  async function handleRedirect(): Promise<{ returnTo: string } | null> {
    const here = page()
    if (!here) return null
    const url = new URL(here.href)
    const redirect = new URL(options.redirectUri)
    if (url.origin !== redirect.origin || url.pathname !== redirect.pathname) return null
    const params = url.searchParams
    if (!params.has('code') && !params.has('error')) return null
    try {
      const record = readPending()
      pending.removeItem(pendingKey) // one-shot: before anything is sent, so a failure leaves no reusable verifier
      if (!record || record.state !== params.get('state'))
        throw new VibaseError(0, 'state_mismatch', 'the sign-in callback does not match a sign-in this page started')
      if (params.has('iss') && params.get('iss') !== (await discover()).issuer)
        throw new VibaseError(0, 'issuer_mismatch', 'the callback names another issuer')
      if (params.has('error')) {
        const description = params.get('error_description')
        throw new VibaseError(
          0,
          'authorization_failed',
          `${params.get('error')}${description ? `: ${description}` : ''}`,
        )
      }
      await exchange(await discover(), params.get('code') ?? '', record)
      return { returnTo: record.return_to }
    } finally {
      for (const name of CALLBACK_PARAMS) params.delete(name)
      const search = params.toString()
      const clean = url.pathname + (search ? `?${search}` : '') + url.hash
      const replace = options.replaceUrl ?? ((u: string) => globalThis.history.replaceState(null, '', u))
      replace(clean)
    }
  }

  return {
    signIn,
    handleRedirect,
    token,
    isSignedIn: () => readToken() !== null,
    signOut() {
      tokens.removeItem(tokenKey)
      pending.removeItem(pendingKey)
    },
  }
}

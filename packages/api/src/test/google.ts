// Test-only ([[CHN5]] D47 spirit, CHN140). A fake Google for the connect flow: the consent screen, the token endpoint, Google's JWKS
// and the two Gmail account endpoints, behind one injectable `fetch`. It mints ID tokens with a local key pair, so the vault's real
// verifier runs. Web APIs and `jose` only: the workerd smoke bundles this file. Not in the production barrel.
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose'

export const FAKE_GOOGLE_ORIGIN = 'https://fake-google.test'
export const FAKE_ENDPOINTS = {
  authorizeUrl: `${FAKE_GOOGLE_ORIGIN}/o/oauth2/v2/auth`,
  tokenUrl: `${FAKE_GOOGLE_ORIGIN}/token`,
  jwksUrl: `${FAKE_GOOGLE_ORIGIN}/oauth2/v3/certs`,
}
export const FAKE_GMAIL_BASE = `${FAKE_GOOGLE_ORIGIN}/gmail/v1/users/me`

const enc = new TextEncoder()
const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const sha256Url = async (s: string): Promise<string> => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))))

export interface FakeAccount {
  sub: string
  email: string
  emailVerified?: boolean
  /** The profile's history id (default '1000'). */
  historyId?: string
  /** `sendAs.list` entries. Default: only the primary. */
  sendAs?: Array<{ sendAsEmail: string; isPrimary?: boolean; verificationStatus?: string }>
}
export interface ConsentOptions {
  /** The scopes the person left ticked (default: all requested). */
  granted?: string[]
  /** Skip the refresh token (Google omits it without `prompt=consent`). */
  noRefreshToken?: boolean
  /** The ID token's claims, overridden. */
  idToken?: { aud?: string; iss?: string; emailVerified?: boolean; expired?: boolean }
  /** The person pressed Cancel: Google redirects with `error=access_denied`. */
  deny?: boolean
}
interface Grant {
  account: FakeAccount
  challenge: string
  redirectUri: string
  clientId: string
  scopes: string[]
  refreshToken: string | null
  idToken: NonNullable<ConsentOptions['idToken']>
  used: boolean
}

export class FakeGoogle {
  readonly calls: Array<{ method: string; url: string }> = []
  /** The refresh tokens handed out, so a test can assert none reached a row or a log in clear text. */
  readonly refreshTokens: string[] = []
  readonly accessTokens: string[] = []
  private readonly grants = new Map<string, Grant>()
  private account: FakeAccount | null = null
  private tokenFailure: number | null = null
  /** The clock ID tokens are stamped with (epoch ms); a test that injects the app's clock sets this to follow it. */
  clock: () => number = () => Date.now()
  private n = 0

  private constructor(
    readonly clientId: string,
    readonly clientSecret: string,
    private readonly privateKey: CryptoKey,
    private readonly jwk: JWK,
  ) {}

  static async create(opts: { clientId?: string; clientSecret?: string } = {}): Promise<FakeGoogle> {
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
    const jwk = { ...(await exportJWK(publicKey)), kid: 'fake-google-1', alg: 'RS256', use: 'sig' }
    return new FakeGoogle(opts.clientId ?? 'fake-client-id.apps.test', opts.clientSecret ?? 'fake-client-secret', privateKey, jwk)
  }

  /** The token endpoint answers this status (and no tokens) from now on. */
  failToken(status: number | null): void {
    this.tokenFailure = status
  }
  /** The account whose Gmail endpoints answer (set by `consent`). */
  signedInAs(account: FakeAccount): void {
    this.account = account
  }

  /**
   * The person opens the vault's authorize URL, picks an account and consents (or cancels). Returns the callback URL Google would
   * redirect the browser to. Checks what Google would check of the request: the client, the redirect URI and PKCE S256.
   */
  async consent(authorizeUrl: string, account: FakeAccount, opts: ConsentOptions = {}): Promise<string> {
    const url = new URL(authorizeUrl)
    if (`${url.origin}${url.pathname}` !== FAKE_ENDPOINTS.authorizeUrl) throw new Error(`not the fake Google authorize endpoint: ${url.origin}${url.pathname}`)
    const q = url.searchParams
    const need = (name: string): string => q.get(name) ?? (() => { throw new Error(`authorize URL lacks ${name}`) })()
    if (need('client_id') !== this.clientId) throw new Error('authorize URL names another client')
    if (need('response_type') !== 'code') throw new Error('response_type must be code')
    if (need('code_challenge_method') !== 'S256') throw new Error('PKCE S256 is required')
    const redirectUri = need('redirect_uri')
    const state = need('state')
    const callback = new URL(redirectUri)
    callback.searchParams.set('state', state)
    if (opts.deny) {
      callback.searchParams.set('error', 'access_denied')
      return callback.toString()
    }
    const requested = need('scope').split(' ')
    const code = `code-${++this.n}-${crypto.randomUUID()}`
    const refreshToken = opts.noRefreshToken ? null : `rt-${crypto.randomUUID()}`
    if (refreshToken) this.refreshTokens.push(refreshToken)
    this.grants.set(code, {
      account,
      challenge: need('code_challenge'),
      redirectUri,
      clientId: this.clientId,
      scopes: opts.granted ?? requested,
      refreshToken,
      idToken: opts.idToken ?? {},
      used: false,
    })
    this.account = account
    callback.searchParams.set('code', code)
    return callback.toString()
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }

  /** The injectable `fetch`: only the fake origin answers; anything else throws, so a real Google call cannot happen. */
  readonly fetch: typeof fetch = async (input, init) => {
    const req = new Request(input as RequestInfo, init)
    const url = new URL(req.url)
    this.calls.push({ method: req.method, url: `${url.origin}${url.pathname}` })
    if (url.origin !== FAKE_GOOGLE_ORIGIN) throw new Error(`FakeGoogle: no network (${url.origin})`)
    if (url.pathname === '/oauth2/v3/certs') return this.json({ keys: [this.jwk] })
    if (url.pathname === '/token' && req.method === 'POST') return this.token(req)
    if (url.pathname === '/gmail/v1/users/me/profile') {
      if (!this.bearerOk(req)) return this.json({ error: { code: 401, status: 'UNAUTHENTICATED' } }, 401)
      return this.json({ emailAddress: this.account!.email, messagesTotal: 10, threadsTotal: 5, historyId: this.account!.historyId ?? '1000' })
    }
    if (url.pathname === '/gmail/v1/users/me/settings/sendAs') {
      if (!this.bearerOk(req)) return this.json({ error: { code: 401, status: 'UNAUTHENTICATED' } }, 401)
      const a = this.account!
      const sendAs = a.sendAs ?? [{ sendAsEmail: a.email, isPrimary: true }]
      return this.json({ sendAs })
    }
    return this.json({ error: { code: 404, status: 'NOT_FOUND' } }, 404)
  }

  private bearerOk(req: Request): boolean {
    const auth = req.headers.get('authorization') ?? ''
    return auth.startsWith('Bearer ') && this.accessTokens.includes(auth.slice(7))
  }

  private async token(req: Request): Promise<Response> {
    if (this.tokenFailure !== null) return this.json({ error: 'invalid_request', error_description: 'secret provider text' }, this.tokenFailure)
    const form = new URLSearchParams(await req.text())
    const grant = this.grants.get(form.get('code') ?? '')
    const bad = (error: string) => this.json({ error, error_description: 'secret provider text' }, 400)
    if (form.get('grant_type') !== 'authorization_code') return bad('unsupported_grant_type')
    if (!grant || grant.used) return bad('invalid_grant')
    if (form.get('client_id') !== this.clientId || form.get('client_secret') !== this.clientSecret) return bad('invalid_client')
    if (form.get('redirect_uri') !== grant.redirectUri) return bad('redirect_uri_mismatch')
    if ((await sha256Url(form.get('code_verifier') ?? '')) !== grant.challenge) return bad('invalid_grant')
    grant.used = true
    const access = `at-${crypto.randomUUID()}`
    this.accessTokens.push(access)
    const now = Math.floor(this.clock() / 1000)
    const o = grant.idToken
    const idToken = await new SignJWT({ email: grant.account.email, email_verified: o.emailVerified ?? grant.account.emailVerified ?? true })
      .setProtectedHeader({ alg: 'RS256', kid: 'fake-google-1' })
      .setIssuer(o.iss ?? 'https://accounts.google.com')
      .setAudience(o.aud ?? grant.clientId)
      .setSubject(grant.account.sub)
      .setIssuedAt(now - 5)
      .setExpirationTime(o.expired ? now - 60 : now + 3600)
      .sign(this.privateKey)
    return this.json({
      access_token: access,
      expires_in: 3599,
      scope: grant.scopes.join(' '),
      token_type: 'Bearer',
      id_token: idToken,
      ...(grant.refreshToken ? { refresh_token: grant.refreshToken } : {}),
    })
  }
}

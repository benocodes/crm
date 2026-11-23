import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAuthHandler } from '@vibase/auth'
import { createVibaseRegistry, defaultGrantScopes, grantableScopes } from '@vibase/api'
import { AUTH_BASE, AUTH_SECRET, authKitOver } from './test/auth-kit.js'
import { openWorkerPair, type WorkerPair } from './test/kit.js'

// [[CORE330]] group 3: the fill is the composition's registration default list, one source. An auth configuration whose defaults differ from production's is asked for what IT lists.
let w: WorkerPair
const declared = createVibaseRegistry().declaredScopes()
const grantable = grantableScopes(declared)
const REDIRECT = 'http://127.0.0.1:33418/cb'
beforeAll(async () => {
  w = await openWorkerPair()
}, 60_000)
afterAll(() => w.dispose())

async function askedFor(defaults: string[] | undefined, email: string): Promise<string[]> {
  await w.reset()
  let n = 0
  const handler = createAuthHandler(
    w.control,
    {
      secret: AUTH_SECRET,
      baseURL: AUTH_BASE,
      vaultScopes: declared,
      grantableScopes: grantable,
      defaultScopes: defaults,
    },
    { unsafeOpenAdmissionForTests: true },
  )
  const call = (path: string, init: { body?: unknown; form?: boolean; cookie?: string; method?: string } = {}) =>
    handler(
      new Request(AUTH_BASE + path, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        redirect: 'manual',
        headers: {
          origin: AUTH_BASE,
          'cf-connecting-ip': `203.0.113.${(n++ % 200) + 1}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.cookie ? { cookie: init.cookie } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    )
  const { cookie } = await authKitOver(call, AUTH_BASE, declared).signUp(email)
  const reg = await call('/auth/oauth2/register', {
    body: {
      client_name: 'C',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      redirect_uris: [REDIRECT],
    },
  })
  const id = ((await reg.json()) as { client_id: string }).client_id
  const res = await call(
    `/auth/oauth2/authorize?${new URLSearchParams({ response_type: 'code', client_id: id, redirect_uri: REDIRECT, code_challenge: 'c'.repeat(43), code_challenge_method: 'S256' })}`,
    { cookie },
  )
  const raw = res.status === 302 ? res.headers.get('location') : ((await res.json()) as { url?: string }).url
  expect(raw, `authorize answered ${res.status}`).toBeTruthy()
  const loc = new URL(raw!, AUTH_BASE)
  expect(loc.pathname).toBe('/app/consent')
  return (loc.searchParams.get('scope') ?? '').split(' ').filter(Boolean).sort()
}

describe('group 3: the fill comes from the composition default list', () => {
  it('a narrowed default list is what a scope-less authorize asks for', async () => {
    const narrow = ['contacts:read', 'notes:read']
    expect(await askedFor(narrow, 'g3-narrow@x.test')).toEqual(
      ['openid', 'profile', 'email', 'offline_access', ...narrow].sort(),
    )
  })

  it('a default list that adds audit:read (not in the production defaults) is asked for', async () => {
    const wider = [...defaultGrantScopes(declared), 'audit:read']
    expect(await askedFor(wider, 'g3-wider@x.test')).toEqual(
      ['openid', 'profile', 'email', 'offline_access', ...wider].sort(),
    )
  })
})

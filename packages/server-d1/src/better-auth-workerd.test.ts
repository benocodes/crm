import { fileURLToPath } from 'node:url'
import { BASE, PAIRED_ORG, bundleWorker, startWorkerd, type Bundle, type Workerd } from '@vibase/auth/test'
import { uuidv7 } from '@vibase/storage'
import { seedMembership, seedPrincipal } from '@vibase/storage-d1/test/seed'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authKitOver, renameClient } from './test/auth-kit.js'
import { createVibaseRegistry } from '@vibase/api'

// [[CORE244]] D8, D19, composition in workerd: the REAL Worker module (src/worker.ts through test/entry-mint.ts), both D1s as Miniflare bindings with distinct ids. A token minted by the
// test composition on the same CONTROL_DB resolves through compose.ts's Worker.
const ENTRY = fileURLToPath(new URL('./test/entry-mint.ts', import.meta.url))
const BETTER = { AUTH_PROVIDER: 'better-auth', PUBLIC_BASE_URL: BASE, OPEN_ADMISSION: '1' }
const declared = createVibaseRegistry().declaredScopes()
const decode = (t: string) => JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString()) as Record<string, any>

let bundle: Bundle
let w: Workerd
beforeAll(async () => {
  bundle = await bundleWorker(ENTRY)
  w = await startWorkerd({ bundle, bindings: BETTER, paired: true })
}, 120_000)
afterAll(async () => {
  await w?.dispose()
  bundle?.dispose()
})

const me = async (tok: string | null, extra: Record<string, string> = {}) => {
  const res = await w.call('/meta/v1/me', { headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...extra } })
  return { status: res.status, json: (await res.json()) as any }
}

describe('minted in workerd, resolved by the real Worker', () => {
  it('a session JWT (15 min), a vibase-cli access token (1 h) and another client\'s access token resolve to a user, a user with the token scopes and a delegated agent; a cookie alone is 401', async () => {
    const kit = authKitOver(w.call as never, BASE, declared)
    const { userId, cookie } = await kit.signUp('owner@x.test')
    const human = uuidv7()
    await seedPrincipal(w.d1, { id: human, kind: 'user', email: 'owner@x.test', authProvider: 'better-auth', authSubject: userId })
    await seedMembership(w.d1, { organizationId: PAIRED_ORG, userId: human, role: 'owner' })

    const session = await kit.sessionJwt(cookie)
    expect(decode(session).exp - decode(session).iat).toBe(15 * 60)
    const asSession = await me(session)
    expect(asSession.status, JSON.stringify(asSession.json)).toBe(200)
    expect(asSession.json.principal).toEqual({ id: human, kind: 'user' })
    expect(asSession.json.active_organization.role).toBe('owner')

    // the seeded first-party client is CORE283's; a row of the default id (P3) stands in for it here
    const other = await kit.registerClient('Claude Desktop')
    const cli = await kit.registerClient('Vibase CLI')
    await renameClient(w.control, cli, 'vibase-cli')
    const cliTokens = await kit.deviceTokens(cookie, 'vibase-cli', 'openid contacts:read')
    expect(decode(cliTokens.access_token).exp - decode(cliTokens.access_token).iat).toBe(60 * 60)
    const asCli = await me(cliTokens.access_token)
    expect(asCli.status, JSON.stringify(asCli.json)).toBe(200)
    expect(asCli.json.principal.kind).toBe('user')
    expect(asCli.json.client_id).toBe('vibase-cli')
    expect(asCli.json.active_organization.scopes).toEqual(['contacts:read'])

    const asOther = await me((await kit.deviceTokens(cookie, other, 'openid contacts:read')).access_token)
    expect(asOther.status, JSON.stringify(asOther.json)).toBe(200)
    expect(asOther.json.principal.kind).toBe('agent')
    expect(asOther.json.agent.delegated_by).toBe(human)
    expect(await w.rows("select type from events where type = 'agent.created'")).toEqual([{ type: 'agent.created' }])

    // a Better Auth cookie authenticates nothing on the API
    const cookieOnly = await w.call('/meta/v1/me', { cookie })
    expect(cookieOnly.status).toBe(401)
    // and a tampered token does not either
    expect((await me(session.slice(0, -4) + 'AAAA')).status).toBe(401)
  })
})

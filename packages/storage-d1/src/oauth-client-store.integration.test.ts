import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createOAuthClient,
  deleteOAuthClient,
  getOAuthClient,
  listOAuthClients,
  updateOAuthClient,
  openControlDb,
  type ControlDb,
  type OAuthClientRecord,
} from './control-store.js'
import type { D1Like } from './binding.js'
import { openLocalD1, type LocalD1 } from './test/index.js'

// [[CORE623]] cycle 1, charter groups 3 (method x client kind), 4 (audit in the same batch) and 6 (update keeps the shape), plus the stored D4 shape. The foreign rows are written in the format
// Better Auth writes (read from a real DCR registration and the seeded `vibase-cli` row: JSON arrays as text, booleans as 0/1, ISO-8601 text), so "byte for byte unchanged" compares real shapes.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const OTHER_ORG = '0190b2c4-0000-7000-8000-00000000a002'
const ACTOR = '0190b2c4-0000-7000-8000-0000000000a1'
const RESOURCES = ['https://api.test', 'https://api.test/mcp'] as const
const T0 = '2026-11-20T10:00:00.000Z'
const T1 = '2026-11-20T10:00:05.000Z'
let local: LocalD1
let d1: D1Like
let c: ControlDb
let seq = 0
const newId = () => `0190b2c4-0000-7000-8000-${(0x1000 + seq++).toString(16).padStart(12, '0')}`
beforeAll(async () => {
  local = await openLocalD1(['C'], { control: ['C'] })
  d1 = local.bindings.C!
  c = openControlDb(d1)
})
afterAll(() => local.dispose())
// A control database without append-only triggers is not needed: each test uses its own client ids and counts audit rows by target.
beforeEach(async () => {
  await d1.batch([d1.prepare('delete from auth_oauth_clients'), d1.prepare('delete from auth_oauth_resources')])
})

const rows = async (text: string, ...binds: unknown[]) =>
  ((
    await d1
      .prepare(text)
      .bind(...binds)
      .all()
  ).results ?? []) as Array<Record<string, any>>
const auditRows = (targetId?: string) =>
  targetId === undefined
    ? rows("select * from control_audit where target_type = 'oauth_client' order by id")
    : rows("select * from control_audit where target_type = 'oauth_client' and target_id = ? order by id", targetId)
const allAudit = () => rows('select count(*) as n from control_audit').then((r) => r[0]!.n as number)
const clientRow = async (clientId: string) =>
  (await rows('select * from auth_oauth_clients where client_id = ?', clientId))[0]

const mk = (clientId: string, over: Partial<Parameters<typeof createOAuthClient>[1]> = {}) =>
  createOAuthClient(c, {
    organizationId: ORG,
    clientId,
    name: `App ${clientId}`,
    redirectUris: ['https://app.test/cb'],
    scopes: ['openid', 'offline_access', 'contacts:read'],
    skipConsent: true,
    resources: RESOURCES,
    actorId: ACTOR,
    now: T0,
    newId,
    ...over,
  }) as Promise<OAuthClientRecord>

/** A foreign client row in the encodings Better Auth wrote (a DCR registration: both owner columns null; the seeded CLI client). */
const foreign = (clientId: string, o: { userId?: null; referenceId?: string | null; name: string; grants: string[] }) =>
  d1
    .prepare(
      `insert into auth_oauth_clients (id, client_id, disabled, scopes, client_credentials_scopes, user_id, created_at, updated_at, name, redirect_uris, token_endpoint_auth_method, application_type, grant_types, response_types, dpop_bound_access_tokens, reference_id)
       values (?, ?, 0, ?, '[]', null, '2026-11-19T10:00:00.000Z', '2026-11-19T10:00:00.000Z', ?, '["http://127.0.0.1:1/cb"]', 'none', 'native', ?, '["code"]', 0, ?)`,
    )
    .bind(newId(), clientId, '["openid"]', o.name, JSON.stringify(o.grants), o.referenceId ?? null)
    .run()

describe('the stored D4 shape (create)', () => {
  it('writes a public PKCE client in the encodings Better Auth writes, linked to both resources, owned by the organisation and by no user', async () => {
    const rec = await mk('Client_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', { skipConsent: false })
    expect(rec).toEqual({
      clientId: 'Client_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
      name: 'App Client_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
      redirectUris: ['https://app.test/cb'],
      scopes: ['openid', 'offline_access', 'contacts:read'],
      skipConsent: false,
      createdAt: T0,
      updatedAt: T0,
    })
    const r = await clientRow('Client_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1')
    expect(r).toMatchObject({
      client_secret: null,
      disabled: 0,
      skip_consent: 0,
      user_id: null,
      reference_id: ORG,
      token_endpoint_auth_method: 'none',
      application_type: 'web',
      grant_types: '["authorization_code","refresh_token"]',
      response_types: '["code"]',
      require_pkce: 1,
      dpop_bound_access_tokens: 0,
      redirect_uris: '["https://app.test/cb"]',
      scopes: '["openid","offline_access","contacts:read"]',
      created_at: T0,
      updated_at: T0,
    })
    expect(
      (
        await rows(
          'select resource_id from auth_oauth_client_resources where client_id = ? order by resource_id',
          r!.client_id,
        )
      ).map((x) => x.resource_id),
    ).toEqual([...RESOURCES])
    expect(
      (await rows('select identifier from auth_oauth_resources order by identifier')).map((x) => x.identifier),
    ).toEqual([...RESOURCES])
  })

  it('a second create reuses the resource rows; a taken client id writes nothing and answers exists', async () => {
    await mk('Client_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1')
    await mk('Client_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2')
    expect((await rows('select count(*) as n from auth_oauth_resources'))[0]!.n).toBe(2)
    const before = await allAudit()
    expect(await mk('Client_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', { name: 'Other' })).toBe('exists')
    expect(await allAudit()).toBe(before)
    expect((await clientRow('Client_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1'))!.name).toBe(
      'App Client_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
    )
    expect((await rows('select count(*) as n from auth_oauth_client_resources'))[0]!.n).toBe(4)
  })

  it('created_at and updated_at are written to the whole second', async () => {
    const rec = await mk('Client_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', { now: '2026-11-20T10:00:00.789Z' })
    expect(rec.createdAt).toBe(T0)
    expect((await clientRow(rec.clientId))!.created_at).toBe(T0)
  })
})

describe('method x client kind (D5, P3)', () => {
  const OWN = 'Client_own0000000000000000000000000001'
  const DCR = 'dcr-registered-client'
  const CLI = 'vibase-cli'
  const THEIRS = 'Client_other-org000000000000000000001'
  const UNKNOWN = 'Client_unknown0000000000000000000001'
  beforeEach(async () => {
    await mk(OWN)
    await mk(THEIRS, { organizationId: OTHER_ORG })
    await foreign(DCR, { name: 'Claude Desktop', grants: ['authorization_code', 'refresh_token'] })
    await foreign(CLI, {
      name: 'Vibase CLI',
      grants: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
    })
  })
  const snapshot = async (id: string) => JSON.stringify(await clientRow(id))
  const methods: Array<[string, (id: string) => Promise<unknown>]> = [
    ['get', (id) => getOAuthClient(c, { organizationId: ORG, clientId: id })],
    [
      'update',
      (id) =>
        updateOAuthClient(c, {
          organizationId: ORG,
          clientId: id,
          actorId: ACTOR,
          now: T1,
          newId,
          name: 'Changed',
          redirectUris: ['https://evil.test/cb'],
          scopes: ['openid'],
          skipConsent: false,
        }),
    ],
    ['delete', (id) => deleteOAuthClient(c, { organizationId: ORG, clientId: id, actorId: ACTOR, now: T1, newId })],
  ]
  const kinds: Array<[string, string, boolean]> = [
    ['a DCR client', DCR, true],
    ['the seeded vibase-cli client', CLI, true],
    ["another organisation's first-party client", THEIRS, true],
    ['an unknown id', UNKNOWN, false],
  ]
  for (const [method, run] of methods)
    for (const [kind, id, exists] of kinds)
      it(`${method} of ${kind}: not found, the row byte for byte unchanged, no audit row`, async () => {
        const before = await snapshot(id)
        const audits = await allAudit()
        const answer = await run(id)
        expect(answer === null || answer === false, JSON.stringify(answer)).toBe(true)
        expect(await snapshot(id)).toBe(before)
        expect(before === undefined || before === 'undefined').toBe(!exists)
        expect(await allAudit()).toBe(audits)
        if (exists)
          expect((await rows('select count(*) as n from auth_oauth_clients where client_id = ?', id))[0]!.n).toBe(1)
      })

  it("the organisation's own first-party client is returned, changed and deleted", async () => {
    expect(await getOAuthClient(c, { organizationId: ORG, clientId: OWN })).toMatchObject({ clientId: OWN })
    expect(
      await updateOAuthClient(c, {
        organizationId: ORG,
        clientId: OWN,
        actorId: ACTOR,
        now: T1,
        newId,
        name: 'Renamed',
      }),
    ).toMatchObject({ clientId: OWN, name: 'Renamed' })
    expect(await deleteOAuthClient(c, { organizationId: ORG, clientId: OWN, actorId: ACTOR, now: T1, newId })).toBe(
      true,
    )
    expect(await clientRow(OWN)).toBeUndefined()
  })

  it('list answers only the first-party clients of the organisation; an empty control database lists nothing', async () => {
    expect((await listOAuthClients(c, { organizationId: ORG })).map((r) => r.clientId)).toEqual([OWN])
    expect((await listOAuthClients(c, { organizationId: OTHER_ORG })).map((r) => r.clientId)).toEqual([THEIRS])
    await d1.prepare('delete from auth_oauth_clients').run()
    expect(await listOAuthClients(c, { organizationId: ORG })).toEqual([])
  })
})

describe('audit in the same batch (D6)', () => {
  const ID = 'Client_audit000000000000000000000001'
  it('create, update and delete each write exactly one audit row: action, target, actor and detail (after for create and update, before for delete)', async () => {
    await mk(ID, {
      name: 'Acme',
      redirectUris: ['https://a.test/cb', 'https://b.test/cb'],
      scopes: ['openid', 'contacts:read'],
      skipConsent: true,
    })
    await updateOAuthClient(c, {
      organizationId: ORG,
      clientId: ID,
      actorId: ACTOR,
      now: T1,
      newId,
      name: 'Acme 2',
      skipConsent: false,
    })
    await deleteOAuthClient(c, {
      organizationId: ORG,
      clientId: ID,
      actorId: ACTOR,
      now: '2026-11-20T10:00:09.000Z',
      newId,
    })
    const audit = await auditRows(ID)
    expect(audit.map((a) => a.action)).toEqual(['oauth_client.created', 'oauth_client.updated', 'oauth_client.deleted'])
    expect(audit.map((a) => [a.target_type, a.target_id, a.actor_id])).toEqual(
      Array(3).fill(['oauth_client', ID, ACTOR]),
    )
    expect(audit.map((a) => a.at)).toEqual([T0, T1, '2026-11-20T10:00:09.000Z'])
    const detail = audit.map((a) => JSON.parse(a.detail))
    expect(detail[0]).toEqual({
      name: 'Acme',
      redirect_uris: ['https://a.test/cb', 'https://b.test/cb'],
      scopes: ['openid', 'contacts:read'],
      skip_consent: true,
    })
    expect(detail[1]).toEqual({
      name: 'Acme 2',
      redirect_uris: ['https://a.test/cb', 'https://b.test/cb'],
      scopes: ['openid', 'contacts:read'],
      skip_consent: false,
    })
    // the delete row is the state BEFORE the delete
    expect(detail[2]).toEqual(detail[1])
  })

  it('a failing audit insert commits nothing, for create, update and delete (an actor id the audit table refuses)', async () => {
    const ID = 'Client_audit000000000000000000000002'
    const BAD = 'not-a-uuid'
    await expect(mk(ID, { actorId: BAD })).rejects.toThrow()
    expect(await clientRow(ID)).toBeUndefined()
    expect((await rows('select count(*) as n from auth_oauth_client_resources'))[0]!.n).toBe(0)

    await mk(ID)
    const before = JSON.stringify(await clientRow(ID))
    await expect(
      updateOAuthClient(c, { organizationId: ORG, clientId: ID, actorId: BAD, now: T1, newId, name: 'X' }),
    ).rejects.toThrow()
    expect(JSON.stringify(await clientRow(ID))).toBe(before)
    await expect(
      deleteOAuthClient(c, { organizationId: ORG, clientId: ID, actorId: BAD, now: T1, newId }),
    ).rejects.toThrow()
    expect(JSON.stringify(await clientRow(ID))).toBe(before)
    expect((await auditRows(ID)).map((a) => a.action)).toEqual(['oauth_client.created'])
  })
})

describe('update keeps the shape (P4)', () => {
  const ID = 'Client_update0000000000000000000001'
  const D4 = [
    'client_secret',
    'disabled',
    'user_id',
    'reference_id',
    'token_endpoint_auth_method',
    'application_type',
    'grant_types',
    'response_types',
    'require_pkce',
    'dpop_bound_access_tokens',
    'client_id',
    'created_at',
    'id',
    'client_credentials_scopes',
  ]
  const fields: Array<[string, Partial<Parameters<typeof updateOAuthClient>[1]>, string, unknown]> = [
    ['name', { name: 'New name' }, 'name', 'New name'],
    [
      'redirect_uris',
      { redirectUris: ['https://x.test/1', 'https://y.test/2'] },
      'redirect_uris',
      '["https://x.test/1","https://y.test/2"]',
    ],
    ['scopes', { scopes: ['openid'] }, 'scopes', '["openid"]'],
    ['skip_consent', { skipConsent: false }, 'skip_consent', 0],
  ]
  it.each(fields)('%s edited alone changes only that column (and updated_at)', async (_n, change, col, value) => {
    await mk(ID)
    const before = (await clientRow(ID))!
    const rec = await updateOAuthClient(c, {
      organizationId: ORG,
      clientId: ID,
      actorId: ACTOR,
      now: '2026-11-20T10:00:05.900Z',
      newId,
      ...change,
    })
    const after = (await clientRow(ID))!
    expect(after[col]).toEqual(value)
    expect(after.updated_at).toBe(T1)
    expect(rec!.updatedAt).toBe(T1)
    const changed = Object.keys(after).filter((k) => after[k] !== before[k])
    expect(changed.sort()).toEqual([col, 'updated_at'].sort())
    for (const k of D4) expect(after[k]).toEqual(before[k])
  })

  it('a redirect_uris change recomputes application_type in the same statement (native when any URI is http, else web); other edits leave it alone ([[CORE628]] D4, 623.41)', async () => {
    const upd = (change: Partial<Parameters<typeof updateOAuthClient>[1]>) =>
      updateOAuthClient(c, { organizationId: ORG, clientId: ID, actorId: ACTOR, now: T1, newId, ...change })
    const type = async () => (await clientRow(ID))!.application_type
    await mk(ID)
    expect(await type()).toBe('web')
    await upd({ redirectUris: ['https://a.test/cb', 'http://localhost:5199/cb'] })
    expect(await type()).toBe('native')
    await upd({ name: 'Renamed', scopes: ['openid'] })
    expect(await type()).toBe('native')
    await upd({ redirectUris: ['https://a.test/cb'] })
    expect(await type()).toBe('web')
    await upd({ redirectUris: ['HTTP://127.0.0.1:1/cb'] })
    expect(await type()).toBe('native')
    expect(await upd({ name: 'x' })).not.toBeNull()
    // not found: nothing written, no audit row for the missed id
    const audits = await allAudit()
    expect(await upd({ clientId: 'nope', redirectUris: ['http://localhost/cb'] })).toBeNull()
    expect(await allAudit()).toBe(audits)
  })

  it('an empty change writes nothing, no audit row, and answers the current record', async () => {
    await mk(ID)
    const before = JSON.stringify(await clientRow(ID))
    const audits = await allAudit()
    expect(
      await updateOAuthClient(c, { organizationId: ORG, clientId: ID, actorId: ACTOR, now: T1, newId }),
    ).toMatchObject({ clientId: ID, updatedAt: T0 })
    expect(JSON.stringify(await clientRow(ID))).toBe(before)
    expect(await allAudit()).toBe(audits)
  })

  it('list orders by created_at, then client_id (two clients on the same second)', async () => {
    await mk('Client_b0000000000000000000000000000001')
    await mk('Client_a0000000000000000000000000000001')
    await mk('Client_c0000000000000000000000000000001', { now: '2026-11-20T09:59:59.000Z' })
    expect((await listOAuthClients(c, { organizationId: ORG })).map((r) => r.clientId)).toEqual([
      'Client_c0000000000000000000000000000001',
      'Client_a0000000000000000000000000000001',
      'Client_b0000000000000000000000000000001',
    ])
  })
})

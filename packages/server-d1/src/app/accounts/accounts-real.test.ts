import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execute, uuidv7 } from '@vibase/storage'
import { ScopeSet, sealToken } from '@vibase/api'
import { connectOperation } from '../../../../api/src/connections/connect.js'
import { clerkUser, mintClerkToken } from '@vibase/api/test/clerk'
import { d1Binding } from '@vibase/storage-d1'
import { bootstrapD1, clerkKit, composeD1Worker, openWorkerD1, type ClerkKit, type WorkerD1 } from '../../test/kit.js'
import { createApi } from '../session/api.js'
import { buildAccountsView } from './view-model.js'

// [[UI467]] group 6 (D2, D10, D12): the page's API client and view model over the REAL composed Worker on D1, as the owner and as a member, with two owners' mailboxes seeded through the connect operation.
const KEY = new Uint8Array(32).fill(5)
const NOW = new Date('2026-11-18T12:00:00.000Z')
let w: WorkerD1
let ck: ClerkKit
let org: string
let worker: ReturnType<typeof composeD1Worker>
const tokens: Record<string, string> = {}

beforeAll(async () => {
  w = await openWorkerD1()
  ck = await clerkKit()
})
afterAll(() => w.dispose())

const callerApi = (who: 'owner' | 'member') =>
  createApi({
    origin: 'https://vibase.test',
    getToken: async () => tokens[who]!,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      worker.fetch(new Request(input as string, init), { waitUntil: () => {} } as never)) as typeof fetch,
  })

const connect = async (actor: string, mailbox: string) => {
  const binding = d1Binding(w.d1, { organizationId: org, authProvider: 'clerk', authOrgId: ck.issuer.issuer })
  const env = {
    actor: { id: actor, kind: 'user' as const },
    organizationId: org,
    scopes: ScopeSet.parse([]),
    now: NOW,
    newId: uuidv7,
    randomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
  }
  const out = await execute(
    binding,
    { kind: 'tenant', actorId: actor, organizationId: org },
    connectOperation(env, {
      google_sub: `sub-${mailbox}`,
      mailbox,
      own_addresses: [mailbox],
      granted_scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'],
      ciphertext: await sealToken(KEY, 'refresh', crypto.getRandomValues(new Uint8Array(12))),
      key_version: 1,
      history_id: '1',
    }),
  )
  return out.value.connection_id as string
}

let ownerId: string
let memberId: string
let ownerConn: string
let memberConn: string
beforeEach(async () => {
  await w.reset()
  await w.d1.prepare('drop table if exists d1_migrations').run()
  worker = composeD1Worker({ ...ck.env, DB: w.d1 } as never, { fetch: ck.fetch })
  const boot = await bootstrapD1(w.d1, { organizationName: 'Acme', agentName: 'bot', authOrgId: ck.issuer.issuer })
  org = boot.organizationId
  for (const [who, sub, role] of [
    ['owner', 'user_acc_owner', 'owner'],
    ['member', 'user_acc_member', 'member'],
  ] as const) {
    tokens[who] = await mintClerkToken(ck.issuer, { sub, extra: { vibase_role: role } })
    ck.profiles.set(sub, clerkUser({ id: sub, email: `${who}@vibase.test`, role }))
  }
  ownerId = (await callerApi('owner').me()).body!.user!.id
  memberId = (await callerApi('member').me()).body!.user!.id
  ownerConn = await connect(ownerId, 'own-mailbox@vibase.test')
  memberConn = await connect(memberId, 'a-member-mailbox@vibase.test')
  await w.d1.prepare("update channel_connections set status = 'reauth_required' where id = ?").bind(memberConn).run()
  await w.d1.prepare("update mail_sync_state set last_error_code = 'invalid_grant' where connection_id = ?").bind(memberConn).run()
})

async function viewAs(who: 'owner' | 'member') {
  const api = callerApi(who)
  const me = (await api.me()).body!
  const list = await api.connections()
  expect(list.status).toBe(200)
  const addresses: Record<string, string | null> = {}
  for (const c of list.body!) addresses[c.id] = (await api.identityAddress(c.identity_id)).body
  return {
    me,
    list: list.body!,
    view: buildAccountsView({
      scopes: me.active_organization!.scopes,
      userId: me.user!.id,
      connections: list.body!,
      addresses,
      now: NOW,
    }),
  }
}

describe('the view model over real responses', () => {
  it('as the owner: own mailbox in Your mailboxes, the member\'s reauth_required one in Other mailboxes with no action', async () => {
    const { view, list } = await viewAs('owner')
    expect(list.map((c) => c.id).sort()).toEqual([ownerConn, memberConn].sort())
    expect(view.access).toBe(true)
    expect(view.canConnect).toBe(true)
    expect(view.yours).toEqual([
      expect.objectContaining({
        id: ownerConn,
        title: 'own-mailbox@vibase.test',
        status: { text: 'Connected', tone: 'neutral' },
        actions: [],
      }),
    ])
    expect(view.others).toEqual([
      expect.objectContaining({
        id: memberConn,
        title: 'a-member-mailbox@vibase.test',
        status: { text: 'Needs reconnect', tone: 'warning' },
        actions: [],
        meta: [
          "Another member's mailbox",
          'Not synced yet',
          'Google no longer accepts this connection. Reconnect to resume syncing. (invalid_grant)',
        ],
      }),
    ])
  })

  it('as a member: the same two rows with the sides swapped, and Reconnect on their own reauth_required row', async () => {
    const { view } = await viewAs('member')
    expect(view.yours).toEqual([
      expect.objectContaining({ id: memberConn, title: 'a-member-mailbox@vibase.test', actions: ['reconnect'] }),
    ])
    expect(view.others).toEqual([
      expect.objectContaining({ id: ownerConn, title: 'own-mailbox@vibase.test', actions: [] }),
    ])
  })

  it('me.get gives the user id the split is made on, and it is the real owner_id', async () => {
    const { me, list } = await viewAs('owner')
    expect(me.user!.id).toBe(ownerId)
    expect(list.find((c) => c.id === ownerConn)!.owner_id).toBe(ownerId)
    expect(list.find((c) => c.id === memberConn)!.owner_id).toBe(memberId)
  })
})

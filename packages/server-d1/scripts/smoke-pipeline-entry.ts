// Smoke-only Worker entry ([[CORE69]] D15). NOT imported by `src/worker.ts` and never deployed: `smoke:worker` bundles it with
// esbuild, loads it in workerd through Miniflare and drives `captureMessages` with `FakeChannel`, the REAL `workerdStreams()`
// (`crypto.DigestStream`, `FixedLengthStream`) and Miniflare's D1 and R2. No route captures yet, so the real Worker entry cannot
// reach the pipeline; when [[CHN5]]'s route lands this entry goes. `/run` drives `FakeChannel`; `/gmail` ([[CHN5]] cycle 1) drives the
// real `GmailChannel` over `FakeGmail`, which serves Gmail's wire form, so the streaming base64url decoder and the HTML-to-markdown
// libraries run in workerd.
import { uuidv7 } from '@vault/storage'
import { d1Binding, type D1Like } from '@vault/storage-d1'
import { captureMessages, r2ObjectStore, ScopeSet, workerdStreams, type GmailSyncDeps, type PipelineContext, type R2BucketLike } from '@vault/api'
import { execute } from '@vault/storage'
import { ensureConnection } from '@vault/api/test/capture'
import { bytesOf, FakeChannel } from '@vault/api/test/channels'
import { FakeGmail, type MessageSpec } from '@vault/api/test/gmail'
import { gmailFixture, MAILBOX } from '@vault/api/test/gmail-fixtures'
import { runGmailSync, seedGmailConnection } from '@vault/api/test/gmail-sync'
import { GmailChannel } from '@vault/api'
import { ATTACHMENT_BYTES, GMAIL_ATTACHMENT_SEED, ORIGINAL_BYTES } from './smoke-pipeline-sizes.js'

interface Env {
  DB: D1Like
  BODIES: R2BucketLike
  AUTH_ORG_ID: string
}

/** A fixture under another Gmail id and Message-ID (the external id), so the messages do not dedupe into one. */
const withId = (m: MessageSpec, id: string): MessageSpec => ({ ...m, id, headers: m.headers.map(([k, v]) => [k, k === 'Message-ID' ? `<${id}@acme.test>` : v]) })

// The scripted page: a normal attachment, a length mismatch, and an original of unknown size over 5 MiB (multipart).

/**
 * `/gmail-pages` ([[CHN149]]): the capture pages in workerd. A connection is seeded through the real connect unit (Web Crypto seals the refresh
 * token), `runGmailSync` backfills and then reads a history page over `FakeGmail`, and the access token comes from a fake token endpoint reached
 * through the injected `fetch`. The fetch refuses every host but Google's token host, and reports the hosts it saw.
 */
async function gmailPages(env: Env): Promise<Response> {
  const now = new Date('2026-11-05T10:00:00.000Z')
  const org = String(((await env.DB.prepare('select organization_id as o from deployment').first()) as { o: string }).o)
  const actor = ((await env.DB.prepare("select id from principals where kind = 'user' order by rowid limit 1").first()) as { id: string }).id
  const binding = d1Binding(env.DB, { organizationId: org, authProvider: 'clerk', authOrgId: env.AUTH_ORG_ID })
  const key = new Uint8Array(32).fill(5)
  const refreshToken = `rt-${crypto.randomUUID()}`
  const accessTokens: string[] = []
  const hosts = new Set<string>()
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input as RequestInfo, init).url)
    hosts.add(url.origin)
    if (url.origin !== 'https://oauth2.googleapis.com' || url.pathname !== '/token') throw new Error('smoke: only the faked token endpoint may be reached')
    const form = new URLSearchParams(String(init?.body))
    if (form.get('grant_type') !== 'refresh_token' || form.get('refresh_token') !== refreshToken) return Response.json({ error: 'invalid_grant' }, { status: 400 })
    const access = `at-${crypto.randomUUID()}`
    accessTokens.push(access)
    return Response.json({ access_token: access, expires_in: 3599, token_type: 'Bearer' })
  }) as typeof fetch
  const env0 = { actor: { id: actor, kind: 'user' as const }, organizationId: org, scopes: ScopeSet.parse([]), now, newId: () => uuidv7(now), randomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)) }
  const connectionId = await seedGmailConnection(
    { env: () => env0, run: (op) => execute(binding, { kind: 'tenant', actorId: actor, organizationId: org }, op), d1: env.DB },
    { key, refreshToken, mailbox: 'pages@smoke.test', sub: 'sub-pages', historyId: '1000' },
  )
  const recent = now.getTime() - 3600_000
  const gmail = new FakeGmail(
    [
      gmailFixture('plain', (m) => ({ ...withId(m, 'p-in'), internalDate: recent })),
      gmailFixture('plain', (m) => ({ ...withId(m, 'p-sent'), labels: ['SENT'], internalDate: recent - 1000 })),
      gmailFixture('plain', (m) => ({ ...withId(m, 'p-new'), internalDate: now.getTime() })),
    ],
    { chunk: (i) => 300 + ((i * 313) % 5000) },
  )
  gmail.history.push({ id: '1001', added: [{ id: 'p-new', labels: ['INBOX'] }] })
  gmail.profile.historyId = '1002'
  const deps: GmailSyncDeps = {
    binding,
    organizationId: org,
    objects: r2ObjectStore(env.BODIES),
    streams: workerdStreams(),
    clock: () => now,
    newId: () => uuidv7(now),
    randomBytes: env0.randomBytes,
    config: { clientId: 'smoke-client.apps.test', clientSecret: 'smoke-client-secret', credentialsKey: key, keyVersion: 1, backfillDays: 30, attachmentMaxBytes: 50 * 1024 * 1024 },
    fetch: fakeFetch,
    clientFor: (accessToken) => gmail.withToken(accessToken, (t) => accessTokens.includes(t)),
  }
  const run = await runGmailSync(deps, connectionId)
  return Response.json({ run, connectionId, hosts: [...hosts], secrets: [refreshToken, ...accessTokens, 'smoke-client-secret'] })
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (new URL(req.url).pathname === '/gmail-pages') {
      try {
        return await gmailPages(env)
      } catch (err) {
        return Response.json({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }, { status: 500 })
      }
    }
    const gmail = new URL(req.url).pathname === '/gmail'
    const channel = gmail
      ? new GmailChannel(
          new FakeGmail(
            [
              // an attachment, an HTML table (hast in workerd), a declared size that is wrong, and an original over 5 MiB of unknown size
              gmailFixture('attachment', (m) => ({ ...withId(m, 'g-att'), payload: { ...m.payload, parts: m.payload.parts!.map((p) => (p.bytes ? { ...p, bytes: bytesOf(ATTACHMENT_BYTES, GMAIL_ATTACHMENT_SEED), attachmentId: 'att-g' } : p)) } })),
              gmailFixture('alternativeTable', (m) => withId(m, 'g-table')),
              gmailFixture('attachment', (m) => ({ ...withId(m, 'g-mismatch'), payload: { ...m.payload, parts: m.payload.parts!.map((p) => (p.bytes ? { ...p, declaredSize: 400 } : p)) } })),
              gmailFixture('plain', (m) => ({ ...withId(m, 'g-big'), rawOverride: bytesOf(ORIGINAL_BYTES) })),
            ],
            { chunk: (i) => 700 + ((i * 977) % 30000) },
          ),
        )
      : new FakeChannel([
      { providerMessageId: 'smoke-att', attachments: [{ name: 'a.bin', mimeType: 'application/octet-stream', bytes: bytesOf(ATTACHMENT_BYTES) }] },
      { providerMessageId: 'smoke-mismatch', attachments: [{ name: 'liar.bin', bytes: bytesOf(100), reportedSize: 120 }] },
      { providerMessageId: 'smoke-big', raw: { size: 'unknown', bytes: bytesOf(ORIGINAL_BYTES) } },
    ])
    const now = new Date('2026-10-30T09:00:00.000Z')
    const org = String(((await env.DB.prepare('select organization_id as o from deployment').first()) as { o: string }).o)
    // CHN140 D27, D31: the sources name a connection, and a connection's owner is a user. This Worker has only the bootstrap agent, so it makes a user once.
    let actor = ((await env.DB.prepare("select id from principals where kind = 'user' order by rowid limit 1").first()) as { id: string } | null)?.id
    if (!actor) {
      actor = uuidv7(now)
      await env.DB.batch([
        env.DB.prepare('insert into principals (id, kind, created_at) values (?, ?, ?)').bind(actor, 'user', now.toISOString()),
        env.DB.prepare('insert into users (id, created_at, updated_at, email, email_verified) values (?, ?, ?, ?, 0)').bind(actor, now.toISOString(), now.toISOString(), 'pipeline-owner@smoke.test'),
      ])
    }
    const ctx: PipelineContext = {
      binding: d1Binding(env.DB, { organizationId: org, authProvider: 'clerk', authOrgId: env.AUTH_ORG_ID }),
      organizationId: org,
      actorId: actor,
      objects: r2ObjectStore(env.BODIES),
      streams: workerdStreams(),
      clock: () => now,
      newId: () => uuidv7(now),
      randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    }
    const gmailConn = { id: uuidv7(now), mailbox: MAILBOX }
    const fakeConn = { id: uuidv7(now) }
    for (const c of [gmailConn, fakeConn]) await ensureConnection(ctx.binding, { organizationId: org, userId: actor }, c.id)
    const result =
      channel instanceof GmailChannel
        ? await captureMessages(ctx, channel, gmailConn, ['g-att', 'g-table', 'g-mismatch', 'g-big'])
        : await captureMessages(ctx, channel, fakeConn, ['smoke-att', 'smoke-mismatch', 'smoke-big'])
    return Response.json(result)
  },
}

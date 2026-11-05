// Smoke-only Worker entry ([[CORE69]] D15). NOT imported by `src/worker.ts` and never deployed: `smoke:worker` bundles it with
// esbuild, loads it in workerd through Miniflare and drives `captureMessages` with `FakeChannel`, the REAL `workerdStreams()`
// (`crypto.DigestStream`, `FixedLengthStream`) and Miniflare's D1 and R2. No route captures yet, so the real Worker entry cannot
// reach the pipeline; when [[CHN5]]'s route lands this entry goes. `/run` drives `FakeChannel`; `/gmail` ([[CHN5]] cycle 1) drives the
// real `GmailChannel` over `FakeGmail`, which serves Gmail's wire form, so the streaming base64url decoder and the HTML-to-markdown
// libraries run in workerd.
import { uuidv7 } from '@vault/storage'
import { d1Binding, type D1Like } from '@vault/storage-d1'
import { captureMessages, r2ObjectStore, workerdStreams, type PipelineContext, type R2BucketLike } from '@vault/api'
import { bytesOf, FakeChannel } from '@vault/api/test/channels'
import { FakeGmail, type MessageSpec } from '@vault/api/test/gmail'
import { gmailFixture, MAILBOX } from '@vault/api/test/gmail-fixtures'
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
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
    const actor = String(((await env.DB.prepare('select id from principals order by rowid limit 1').first()) as { id: string }).id)
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
    const result =
      channel instanceof GmailChannel
        ? await captureMessages(ctx, channel, gmailConn, ['g-att', 'g-table', 'g-mismatch', 'g-big'])
        : await captureMessages(ctx, channel, { id: uuidv7(now) }, ['smoke-att', 'smoke-mismatch', 'smoke-big'])
    return Response.json(result)
  },
}

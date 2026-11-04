// Smoke-only Worker entry ([[CORE69]] D15). NOT imported by `src/worker.ts` and never deployed: `smoke:worker` bundles it with
// esbuild, loads it in workerd through Miniflare and drives `captureMessages` with `FakeChannel`, the REAL `workerdStreams()`
// (`crypto.DigestStream`, `FixedLengthStream`) and Miniflare's D1 and R2. No route captures yet, so the real Worker entry cannot
// reach the pipeline; when [[CHN5]] lands one this entry goes.
import { uuidv7 } from '@vault/storage'
import { d1Binding, type D1Like } from '@vault/storage-d1'
import { captureMessages, r2ObjectStore, workerdStreams, type R2BucketLike } from '@vault/api'
import { bytesOf, FakeChannel } from '@vault/api/test/channels'

interface Env {
  DB: D1Like
  BODIES: R2BucketLike
  AUTH_ORG_ID: string
}

/** The scripted page: a normal attachment, a length mismatch, and an original of unknown size over 5 MiB (multipart). */
export const ATTACHMENT_BYTES = 300
export const ORIGINAL_BYTES = 5 * 1024 * 1024 + 123

export default {
  async fetch(_req: Request, env: Env): Promise<Response> {
    const channel = new FakeChannel([
      { providerMessageId: 'smoke-att', attachments: [{ name: 'a.bin', mimeType: 'application/octet-stream', bytes: bytesOf(ATTACHMENT_BYTES) }] },
      { providerMessageId: 'smoke-mismatch', attachments: [{ name: 'liar.bin', bytes: bytesOf(100), reportedSize: 120 }] },
      { providerMessageId: 'smoke-big', raw: { size: 'unknown', bytes: bytesOf(ORIGINAL_BYTES) } },
    ])
    const now = new Date('2026-10-30T09:00:00.000Z')
    const org = String(((await env.DB.prepare('select organization_id as o from deployment').first()) as { o: string }).o)
    const actor = String(((await env.DB.prepare('select id from principals order by rowid limit 1').first()) as { id: string }).id)
    const result = await captureMessages(
      {
        binding: d1Binding(env.DB, { organizationId: org, authProvider: 'clerk', authOrgId: env.AUTH_ORG_ID }),
        organizationId: org,
        actorId: actor,
        objects: r2ObjectStore(env.BODIES),
        streams: workerdStreams(),
        clock: () => now,
        newId: () => uuidv7(now),
        randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
      },
      channel,
      { id: uuidv7(now) },
      ['smoke-att', 'smoke-mismatch', 'smoke-big'],
    )
    return Response.json(result)
  },
}

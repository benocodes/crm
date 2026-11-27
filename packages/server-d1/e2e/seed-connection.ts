// [[UI468]] E2E helper: seeds one `active` Gmail connection into the local D1 the `auth-pages` run's Worker uses, the way the OAuth callback does: the REAL connect program run in-process
// (`connectOperation`, one batch: the connection, its credential, cursor, sync state, own identity and events) against the persisted local state (`getPlatformProxy`, as `bootstrap` opens it),
// acting as the workspace's first person. Capture labels become INBOX and Label_1 (the connect program seeds INBOX and SENT). Prints the connection id as the last line.
//   pnpm exec tsx e2e/seed-connection.ts <mailbox address>
import { getPlatformProxy } from 'wrangler'
import { ScopeSet, sealToken } from '@vibase/api'
import { execute, uuidv7 } from '@vibase/storage'
import { d1Binding, type D1Like } from '@vibase/storage-d1'
import { connectOperation } from '../../api/src/connections/connect.js'
import { readDeployment } from '../src/init-deployment.js'

const mailbox = process.argv[2]
if (!mailbox) throw new Error('usage: seed-connection.ts <mailbox address>')
const proxy = await getPlatformProxy<{ DB: D1Like }>({ persist: true, remoteBindings: false })
try {
  const d1 = proxy.env.DB
  const link = await readDeployment(d1)
  if (!link) throw new Error('the local deployment is not initialised')
  const user = (await d1.prepare('select id from users order by created_at limit 1').first()) as { id: string } | null
  if (!user) throw new Error('no person in the workspace yet: sign up first')
  const binding = d1Binding(d1, link)
  const out = await execute(
    binding,
    { kind: 'tenant', actorId: user.id, organizationId: link.organizationId },
    connectOperation(
      {
        actor: { id: user.id, kind: 'user' },
        organizationId: link.organizationId,
        scopes: ScopeSet.parse([]),
        now: new Date(),
        newId: uuidv7,
        randomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
      },
      {
        google_sub: `e2e-${mailbox}`,
        mailbox,
        own_addresses: [mailbox],
        granted_scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'],
        ciphertext: await sealToken(new Uint8Array(32).fill(5), 'refresh', crypto.getRandomValues(new Uint8Array(12))),
        key_version: 1,
        cursor: '1',
      },
    ),
  )
  const id = (out.value as { connection_id: string }).connection_id
  await d1
    .prepare("update connection_capture_labels set label_id = 'Label_1' where connection_id = ? and label_id = 'SENT'")
    .bind(id)
    .run()
  console.log(id)
} finally {
  await proxy.dispose()
}

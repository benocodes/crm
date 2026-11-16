// [[CORE356]] P5: the one way the e2e scripts mint an API key, through the control store (`insertApiKey`: the key and its `api_key.created` audit row in CONTROL_DB). No raw SQL into either `api_keys`.
import { hashApiKey } from '@vibase/api'
import { uuidv7 } from '@vibase/storage'
import { insertApiKey, openControlDb, type D1Like } from '@vibase/storage-d1'

export async function mintControlKey(
  control: D1Like,
  a: { organizationId: string; agentId: string; actorId: string; key: string; now?: Date },
): Promise<{ id: string }> {
  const now = a.now ?? new Date()
  const id = uuidv7(now)
  const out = await insertApiKey(openControlDb(control), {
    id,
    auditId: uuidv7(now),
    actorId: a.actorId,
    organizationId: a.organizationId,
    agentId: a.agentId,
    keyHash: await hashApiKey(a.key),
    prefix: a.key.slice(0, 11),
    expiresAt: null,
    now: now.toISOString(),
  })
  if (out !== 'created') throw new Error('e2e key: duplicate key')
  return { id }
}

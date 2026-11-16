import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { hashApiKey } from '@vibase/api'
import { openWorkerPair, type WorkerPair } from '../src/test/kit.js'
import { mintControlKey } from './e2e-keys.js'

// [[CORE356]] group 5: the two e2e scripts mint their keys through this one helper, which goes through the control store: the key and one `api_key.created` audit row in CONTROL_DB, no CRM `api_keys` row.
let pair: WorkerPair
beforeAll(async () => {
  pair = await openWorkerPair()
}, 60_000)
afterAll(() => pair.dispose())

describe('the e2e scripts key helper', () => {
  it('mints the key in control with its audit row and writes nothing to the CRM database', async () => {
    const key = 'vk_' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
    const ids = { organizationId: uuidv7(), agentId: uuidv7(), actorId: uuidv7() }
    const { id } = await mintControlKey(pair.control, { ...ids, key })
    const rows = async (db: WorkerPair['d1'], q: string) => ((await db.prepare(q).all()).results ?? []) as any[]
    expect(await rows(pair.control, 'select * from api_keys')).toMatchObject([
      {
        id,
        agent_id: ids.agentId,
        organization_id: ids.organizationId,
        created_by: ids.actorId,
        prefix: key.slice(0, 11),
        key_hash: await hashApiKey(key),
      },
    ])
    expect(await rows(pair.control, 'select * from control_audit')).toMatchObject([
      { action: 'api_key.created', actor_id: ids.actorId, target_id: id },
    ])
    expect(await rows(pair.d1, 'select * from api_keys')).toEqual([])
  })
})

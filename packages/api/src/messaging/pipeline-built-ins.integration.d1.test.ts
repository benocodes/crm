import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { memoryObjectStore } from '../objects/store.js'
import { FakeChannel } from '../test/channels.js'
import { ensureConnection } from '../test/capture-kit.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { nodeStreams } from '../test/streams.js'
import { applyExtend } from '../test/extension-kit.js'
import { createBuiltIns } from '../resources/built-ins.js'
import { captureMessages, type PipelineContext } from './pipeline.js'

// [[CORE559]] P2, P7: the capture pipeline renders the contact it creates from the built-ins on its context, so `contact.created` carries the extension fields (a required field's stored default).
const NOW = '2026-10-22T10:00:00.000Z'
const C1 = { id: '0190b2c4-0000-7000-8000-0000000000c1' }
const EXTEND = { contacts: { lvl__c: { kind: 'enum', values: ['a', 'b'], required: true, default: 'a' } } } as never
let e: Engine
beforeAll(async () => {
  e = await openD1Engine()
  await applyExtend(e.d1!, EXTEND)
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
  await ensureConnection(e.binding, e, C1.id)
})

const run = async (builtIns?: PipelineContext['builtIns']) => {
  const ctx: PipelineContext = {
    binding: e.binding,
    organizationId: e.organizationId,
    actorId: e.userId,
    objects: memoryObjectStore(),
    streams: nodeStreams(),
    clock: () => new Date(NOW),
    newId: () => uuidv7(new Date(NOW)),
    randomBytes: (k) => crypto.getRandomValues(new Uint8Array(k)),
    ...(builtIns ? { builtIns } : {}),
  }
  const channel = new FakeChannel([{ providerMessageId: 'm1', from: 'jane@acme.test', to: ['owner@acme.test'] }])
  await captureMessages(ctx, channel, C1, ['m1'], {})
  return (await e.rows('events')).filter((r) => r.type === 'contact.created')
}

describe('captureMessages with the composed built-ins', () => {
  it('contact.created carries the extension field and its stored default', async () => {
    const [created] = await run(createBuiltIns(EXTEND))
    expect(created!.after).toMatchObject({ lvl__c: 'a' })
  })
  it('with no built-ins on the context the event is the core record', async () => {
    const [created] = await run()
    expect(created!.after).not.toHaveProperty('lvl__c')
  })
})

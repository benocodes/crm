import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createVaultRegistry } from '../operations.js'
import type { TenantOperation } from '../registry.js'
import { ApiError } from '../errors.js'
import { openEngines, type Engine } from '../test/engines.js'

// schema.get on the Postgres engine only has to answer 501 (API63 D15); the D1 oracle's cases are in schema.storage.integration.d1.test.ts.
const registry = createVaultRegistry()
let engines: Engine[]
let pg: Engine
beforeAll(async () => {
  engines = await openEngines(['postgres'])
  pg = engines.find((e) => e.name === 'postgres')!
})
afterAll(async () => {
  for (const e of engines ?? []) await e.close()
})

const op = () => registry.get('schema.get') as TenantOperation
const run = async (e: Engine) => e.run(await op().prepare(e.env(), { params: {}, query: {}, body: undefined }))

describe('schema.get on Postgres (D15)', () => {
  it('answers 501 not_implemented', async () => {
    await pg.reset()
    await expect(run(pg)).rejects.toMatchObject({ status: 501, code: 'not_implemented' })
    await expect(run(pg)).rejects.toBeInstanceOf(ApiError)
  })
})

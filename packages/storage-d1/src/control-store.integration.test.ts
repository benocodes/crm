import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { controlAuthDatabase, openControlDb, readControlMarker, writeControlMarker } from './control-store.js'
import { openLocalD1, type LocalD1 } from './test/index.js'

const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const OTHER = '0190b2c4-0000-7000-8000-00000000a002'
let local: LocalD1
beforeAll(async () => {
  local = await openLocalD1(['C'], { control: ['C'] })
})
afterAll(() => local.dispose())

describe('the control store marker (CORE259 D7)', () => {
  it('a control database with no marker row reads as null, not a crash', async () => {
    const c = openControlDb(local.bindings.C!)
    expect(await readControlMarker(c)).toBeNull()
  })
  it('writes the marker once, idempotently, and refuses another organisation', async () => {
    const c = openControlDb(local.bindings.C!)
    expect(await writeControlMarker(c, ORG)).toBe('created')
    expect(await readControlMarker(c)).toEqual({ organizationId: ORG })
    expect(await writeControlMarker(c, ORG)).toBe('existing')
    await expect(writeControlMarker(c, OTHER)).rejects.toThrow(/already paired/)
    expect(await readControlMarker(c)).toEqual({ organizationId: ORG })
  })
  it('hands the auth provider a database that reaches the control tables', async () => {
    const auth = controlAuthDatabase(openControlDb(local.bindings.C!)) as { prepare(q: string): { first(): Promise<unknown> } }
    expect(await auth.prepare('select count(*) as n from auth_users').first()).toEqual({ n: 0 })
  })
})

// OPS340 D9 and D4: the switch between transports, and the identity of a binding's handle.
import { afterEach, describe, expect, it } from 'vitest'
import { clearD1, openLocalD1, type LocalD1 } from './index.js'
import { transportKindOf, transportStats } from './request-transport.js'

const VAR = 'VIBASE_TEST_D1_TRANSPORT'
const opened: LocalD1[] = []
const original = process.env[VAR]
afterEach(async () => {
  if (original === undefined) delete process.env[VAR]
  else process.env[VAR] = original
  await Promise.all(opened.splice(0).map((l) => l.dispose()))
})
const open = async (opts: Parameters<typeof openLocalD1>[1] = {}) => {
  const l = await openLocalD1(['S'], opts)
  opened.push(l)
  return l
}
const isRequest = (l: LocalD1) => transportKindOf(l) === 'request' && transportStats(l) !== undefined
const isBinding = (l: LocalD1) => transportKindOf(l) === 'binding' && transportStats(l) === undefined

describe('transport switch (OPS340 D9)', () => {
  it('unset selects the request transport', async () => {
    delete process.env[VAR]
    expect(isRequest(await open())).toBe(true)
  })
  it('"request" selects the request transport', async () => {
    process.env[VAR] = 'request'
    expect(isRequest(await open())).toBe(true)
  })
  it('"binding" selects the binding transport, which still works', async () => {
    process.env[VAR] = 'binding'
    const l = await open()
    expect(isBinding(l)).toBe(true)
    expect(await l.bindings.S!.prepare('SELECT 1 AS one').first()).toEqual({ one: 1 })
  })
  it('an unknown value throws when openLocalD1 is called', async () => {
    process.env[VAR] = 'bogus'
    await expect(open()).rejects.toThrow(/VIBASE_TEST_D1_TRANSPORT.*bogus/)
  })
  it('an explicit option wins over the variable, both ways', async () => {
    process.env[VAR] = 'binding'
    expect(isRequest(await open({ transport: 'request' }))).toBe(true)
    process.env[VAR] = 'request'
    expect(isBinding(await open({ transport: 'binding' }))).toBe(true)
  })
  it('an explicit option is used even when the variable is garbage', async () => {
    process.env[VAR] = 'bogus'
    expect(isRequest(await open({ transport: 'request' }))).toBe(true)
  })
})

describe('request handle (OPS340 D4)', () => {
  it('a binding is the same object for the life of the instance', async () => {
    const l = await open({ transport: 'request' })
    const first = l.bindings.S
    await first!.prepare('CREATE TABLE t (n INTEGER)').run()
    await clearD1(first!)
    expect(l.bindings.S).toBe(first)
    expect(l.bindings.S).toBe(l.bindings.S)
  })
  it('migrations and clearD1 run through the request handle', async () => {
    const l = await open({ transport: 'request' })
    const d1 = l.bindings.S!
    expect(transportStats(l)!.requests).toBeGreaterThan(0) // the migrations went through it
    await d1
      .prepare("INSERT INTO deployment (organization_id) VALUES ('o')")
      .run()
      .catch(() => undefined)
    const before = transportStats(l)!.requests
    await clearD1(d1)
    expect(transportStats(l)!.requests).toBeGreaterThan(before)
    const tables = await d1.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table'").first()
    expect((tables as { c: number }).c).toBeGreaterThan(10)
  })
})

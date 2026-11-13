import { afterEach, describe, expect, it } from 'vitest'
import { fakeInstance, rig } from './test/harness.js'

// OPS240 D12: the instance commands left the client for `@vibase/server-d1`'s `vibase-server`. `vibase instance …` only says where they went.
const rigs: ReturnType<typeof rig>[] = []
afterEach(() => { while (rigs.length) rigs.pop()!.dispose() })
const setup = () => {
  const inst = fakeInstance()
  const r = rig({ fetch: inst.fetch })
  rigs.push(r)
  return r
}
const REDIRECT = 'instance commands moved to the server package: npx @vibase/server-d1@0.0.0-test <command> …\n'

describe('D12 redirect', () => {
  it('prints the moved line with the client\'s own version on stderr and exits 2, for `instance`, `instance --help` and `instance status --env demo`', async () => {
    const r = setup()
    for (const argv of [['instance'], ['instance', '--help'], ['instance', 'status', '--env', 'demo']]) {
      const res = await r.run(argv)
      expect(res.code, argv.join(' ')).toBe(2)
      expect(res.stderr, argv.join(' ')).toBe(REDIRECT)
      expect(res.stdout, argv.join(' ')).toBe('')
    }
  })
  it('touches no network, whatever follows `instance`', async () => {
    const r = setup()
    for (const argv of [['instance', 'upgrade', '--env', 'demo', '--rollback'], ['instance', 'setup', '--env', 'x', '--api-host', 'h'], ['--server', 'https://x.invalid', 'instance', 'status']]) await r.run(argv)
    expect(r.seen).toEqual([])
  })
})

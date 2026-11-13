import { afterEach, describe, expect, it } from 'vitest'
import { fakeInstance, rig } from './test/harness.js'

// [[OPS231]] D12: `vibase instance …` is a sibling bundle of a release package. The client core only dispatches to it.
const rigs: ReturnType<typeof rig>[] = []
afterEach(() => { while (rigs.length) rigs.pop()!.dispose() })
const setup = () => {
  const inst = fakeInstance()
  const r = rig({ fetch: inst.fetch })
  rigs.push(r)
  return r
}

describe('D12 dispatch', () => {
  it('without a sibling instance.js it prints the release-only message, exits non-zero and touches no network', async () => {
    const r = setup()
    for (const argv of [['instance', 'status', '--env', 'demo'], ['instance'], ['instance', '--help']]) {
      const res = await r.run(argv, { loadInstance: async () => undefined })
      expect(res.code).not.toBe(0)
      expect(res.stderr).toMatch(/instance commands are only available from a release package/)
    }
    expect(r.seen).toEqual([])
  })
  it('with no loader at all (an unbuilt or checkout run) it prints the same message', async () => {
    const r = setup()
    const res = await r.run(['instance', 'status', '--env', 'demo'])
    expect(res.code).not.toBe(0)
    expect(res.stderr).toMatch(/only available from a release package/)
    expect(r.seen).toEqual([])
  })
  it('with a sibling it passes the words after `instance` and returns its exit code', async () => {
    const r = setup()
    const got: { argv: string[] }[] = []
    const res = await r.run(['instance', 'status', '--env', 'demo'], {
      loadInstance: async () => async (argv, io) => {
        got.push({ argv })
        io.stdout('from instance\n')
        io.stderr('and stderr\n')
        return 7
      },
    })
    expect(got).toEqual([{ argv: ['status', '--env', 'demo'] }])
    expect(res.code).toBe(7)
    expect(res.stdout).toBe('from instance\n')
    expect(res.stderr).toBe('and stderr\n')
    expect(r.seen).toEqual([])
  })
})

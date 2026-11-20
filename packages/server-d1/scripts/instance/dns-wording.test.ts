// OPS496 D6, P2: the gate's refusal and the post-deploy poll's failure say DNS when the name did not resolve, for `upgrade`, `redeploy` and `status`; any other failure keeps "cannot reach".
import { afterEach, describe, expect, it } from 'vitest'
import { isDnsFailure } from './reach.js'
import { runStatus } from './status.js'
import { runRedeploy, runUpgrade } from './upgrade.js'
import { cleanup, makeWorld } from './test-kit.js'

afterEach(() => cleanup())

const wrapped = (code: string) =>
  Object.assign(new TypeError('fetch failed'), { cause: { code, message: `getaddrinfo ${code} h` } })
const FAILS: [string, () => Error, boolean][] = [
  ['ENOTFOUND on the error', () => new Error('getaddrinfo ENOTFOUND api.demo.invalid'), true],
  ['ENOTFOUND on the cause', () => wrapped('ENOTFOUND'), true],
  ['EAI_AGAIN on the cause', () => wrapped('EAI_AGAIN'), true],
  ['EAI_AGAIN on the error code', () => Object.assign(new Error('lookup failed'), { code: 'EAI_AGAIN' }), true],
  ['a connection refusal', () => wrapped('ECONNREFUSED'), false],
  [
    'a timeout',
    () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
    false,
  ],
]
const COMMANDS = [
  ['upgrade', runUpgrade],
  ['redeploy', runRedeploy],
  ['status', runStatus],
] as const

describe('P2: the classifier', () => {
  it.each(FAILS)('%s', (_n, mk, dns) => expect(isDnsFailure(mk())).toBe(dns))
})

describe.each(COMMANDS)('D6 the gate read in %s', (name, run) => {
  it.each(FAILS)('%s', async (_n, mk, dns) => {
    const w = makeWorld({
      fetch: () => {
        throw mk()
      },
    })
    expect(await run(['--env', 'demo'], w.deps)).toBe(2)
    const err = w.err.join('\n')
    if (dns) {
      expect(err).toContain('cannot resolve api.demo.invalid from this machine (DNS)')
      expect(err).toContain("wait a few minutes or flush this machine's DNS cache")
      expect(err).not.toContain('cannot reach')
    } else {
      expect(err).toContain('cannot reach https://api.demo.invalid/health')
      expect(err).not.toContain('cannot resolve')
    }
    expect(err).toContain(`vibase-server ${name}:`)
  })
})

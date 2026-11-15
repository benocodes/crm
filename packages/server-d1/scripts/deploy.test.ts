import { describe, expect, it } from 'vitest'
import { runDeploy, type DeployDeps } from './deploy.js'
import { RemoteRefusal } from './remote.js'

// [[CORE326]] P4: the guarded deploy, with git, wrangler and the config faked; nothing here reaches a remote instance.
const UUID = '0f5a1c2e-3b4d-4e6f-8a9b-1c2d3e4f5a6b'
const CONTROL_UUID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const crmOnly = {
  name: 'vault-smoked1',
  d1_databases: [{ binding: 'DB', database_name: 'vault-smoked1', database_id: UUID, remote: true }],
}
const both = {
  ...crmOnly,
  d1_databases: [
    ...crmOnly.d1_databases,
    { binding: 'CONTROL_DB', database_name: 'vb-control-smoked1', database_id: CONTROL_UUID, remote: true },
  ],
}

function fake(config: object) {
  const calls: string[] = []
  const out: string[] = []
  const deps: DeployDeps = {
    git: (args) => (calls.push(`git ${args.join(' ')}`), { status: 0, stdout: args[0] === 'status' ? '' : 'abc123\n' }),
    loadEnv: () => void calls.push('loadEnv'),
    readConfig: () => config as never,
    run: (cmd) => (calls.push(`${cmd.command} ${cmd.args.join(' ')}`), 0),
    log: (l) => void out.push(l),
  }
  return { deps, calls, out }
}
const wrangler = (calls: string[]) => calls.filter((c) => c.includes('wrangler'))

describe('deploy:remote (CORE326 P4)', () => {
  it('an env with a control database deploys: build, typecheck, test, then wrangler deploy', () => {
    const f = fake(both)
    expect(runDeploy(['--env', 'smoked1'], { CONFIRM_REMOTE: '1' }, f.deps)).toBe(0)
    expect(wrangler(f.calls)).toEqual([expect.stringContaining('wrangler deploy --env smoked1')])
  })
  it('an env without a CONTROL_DB entry is refused before any build or wrangler call, naming setup:remote', () => {
    const f = fake(crmOnly)
    let err: unknown
    try {
      runDeploy(['--env', 'smoked1'], { CONFIRM_REMOTE: '1' }, f.deps)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(RemoteRefusal)
    expect((err as Error).message).toContain('setup:remote --env smoked1')
    expect(f.calls.filter((c) => c.startsWith('pnpm'))).toEqual([])
    expect(f.out).toEqual([])
  })
})

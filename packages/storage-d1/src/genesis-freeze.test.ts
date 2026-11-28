import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONTROL_MIGRATIONS } from './control-migrations-manifest.js'
import { MIGRATIONS } from './migrations-manifest.js'
import { CONTROL_MIGRATIONS_DIR, MIGRATIONS_DIR } from './test/index.js'

// Both genesis files are FROZEN at the first public release (0.3.0, [[OPS681]] D1, D3). These literals are
// deliberately separate from the manifests: editing a genesis file and its manifest hash together passes the
// manifest test, but not this one. Never edit a hash here to follow a change to a genesis file. A schema change
// appends a numbered migration (`0002_<name>.sql`) and its manifest entry.
const FROZEN_CRM_GENESIS_SHA256 = '90d886dba20ac1e817dd9756fd859aa71f5fde0d2cfddf41b5c067d033aff73b'
// AGT701 D14, ruling 701.27: the control genesis was reopened before v0.3.0 for `invitations.agent_id` (old pin fc56fdaf...); the freeze resumes at the tag.
const FROZEN_CONTROL_GENESIS_SHA256 = '874abb896b0ab1a2ec4534debff8e1183baf3bff4ff6237f06be4adc5eccba9a'

const NAME = '0001_genesis.sql'

/** Why a genesis file is not the frozen one; empty means it is. */
function frozenGenesisProblems(
  manifest: readonly { readonly name: string }[],
  dir: string,
  frozenSha256: string,
): string[] {
  const problems: string[] = []
  if (manifest[0]?.name !== NAME) problems.push(`${NAME} is not the first manifest entry (found ${manifest[0]?.name})`)
  const actual = createHash('sha256')
    .update(readFileSync(join(dir, NAME)))
    .digest('hex')
  if (actual !== frozenSha256)
    problems.push(
      `${NAME} in ${dir} changed: genesis is frozen at the first public release (0.3.0); append a new numbered migration (0002_<name>.sql) instead`,
    )
  return problems
}

describe('genesis is frozen at the first public release (OPS681)', () => {
  it('the CRM genesis is byte-for-byte the frozen file and the first manifest entry', () => {
    expect(frozenGenesisProblems(MIGRATIONS, MIGRATIONS_DIR, FROZEN_CRM_GENESIS_SHA256)).toEqual([])
  })
  it('the control genesis is byte-for-byte the frozen file and the first manifest entry', () => {
    expect(frozenGenesisProblems(CONTROL_MIGRATIONS, CONTROL_MIGRATIONS_DIR, FROZEN_CONTROL_GENESIS_SHA256)).toEqual([])
  })
})

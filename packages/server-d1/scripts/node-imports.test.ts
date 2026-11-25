import { describe, expect, it } from 'vitest'
import { ALLOWED_NODE_MODULES, nodeImportProblems, nodeImportsOf } from './node-imports.js'

// [[CORE243]] D2: `smoke:worker` keeps guarding the bundle with an explicit allow-list of `node:` modules so a new Node import is a visible change, not drift.
describe('the node: allow-list of the Worker bundle', () => {
  it('finds every distinct node: specifier, in each import form, and ignores the word in strings that are not imports', () => {
    const text = [
      'import { a } from "node:crypto";',
      "import b from 'node:buffer'",
      'const c = await import("node:async_hooks")',
      'var d = require("node:util")',
      'import "node:events"',
      'import { x } from "node:crypto"',
      'const s = "see node:fs for details"',
    ].join('\n')
    expect(nodeImportsOf(text)).toEqual(['node:async_hooks', 'node:buffer', 'node:crypto', 'node:events', 'node:util'])
  })

  it('the list is sorted, unique, every entry a node: specifier', () => {
    expect(ALLOWED_NODE_MODULES.length).toBeGreaterThan(0)
    expect([...ALLOWED_NODE_MODULES]).toEqual([...new Set(ALLOWED_NODE_MODULES)].sort())
    for (const m of ALLOWED_NODE_MODULES) expect(m).toMatch(/^node:[a-z_/]+$/)
  })

  it('an allowed bundle has no problem', () => {
    expect(nodeImportProblems(`import x from "${ALLOWED_NODE_MODULES[0]}"`)).toEqual([])
  })

  it('a node: import outside the list is a problem, named', () => {
    const problems = nodeImportProblems(
      `import x from "${ALLOWED_NODE_MODULES[0]}"; import y from "node:child_process"`,
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('node:child_process')
  })
})

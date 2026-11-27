// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are source text that contains template syntax
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { listTestFiles, sliceFiles, sliceSource } from './slice.ts'

// OPS670 D1 and D2: slicing a test file into cases, and the state sent for each. Every fixture here is a string
// the test owns; none counts the repo's real test files.
const lines = (...l: string[]) => l.join('\n')
const F = 'pkg/a.test.ts'
const idsAndLines = (text: string, file = F) =>
  sliceSource(file, text).cases.map((c) => [c.id.slice(file.length + 3), c.line] as const)

describe('slicing: the matrix of constructs (D1)', () => {
  const matrix: { name: string; text: string; file?: string; expected: (readonly [string, number])[] }[] = [
    {
      name: 'plain it and test',
      text: lines("it('plain it', () => {})", "test('plain test', () => {})"),
      expected: [
        ['plain it', 1],
        ['plain test', 2],
      ],
    },
    {
      name: 'nested describe',
      text: lines(
        "describe('outer', () => {",
        "  describe('inner', () => {",
        "    it('deep', () => {})",
        '  })',
        "  it('shallow', () => {})",
        '})',
      ),
      expected: [
        ['outer > inner > deep', 3],
        ['outer > shallow', 5],
      ],
    },
    {
      name: 'it.each is one case whatever its rows',
      text: lines("it.each([1, 2, 3, 4])('adds %i', (n) => {", '  expect(n).toBe(n)', '})'),
      expected: [['adds %i', 1]],
    },
    {
      name: 'it.each as a tagged template table',
      text: lines('it.each`', '  a | b', '  ${1} | ${2}', "`('sums $a', ({ a }) => {})"),
      expected: [['sums $a', 1]],
    },
    {
      name: 'describe.each is one describe with its own cases',
      text: lines("describe.each([1, 2])('engine %i', () => {", "  it('works', () => {})", '})'),
      expected: [['engine %i > works', 2]],
    },
    {
      name: 'skip, only and concurrent modifiers',
      text: lines(
        "it.skip('skipped', () => {})",
        "it.only('only', () => {})",
        "test.concurrent('concurrent', async () => {})",
        "it.concurrent.skip('both', () => {})",
        "it.skipIf(true)('skip if', () => {})",
        "describe.skip('skipped suite', () => {",
        "  it('inside', () => {})",
        '})',
      ),
      expected: [
        ['skipped', 1],
        ['only', 2],
        ['concurrent', 3],
        ['both', 4],
        ['skip if', 5],
        ['skipped suite > inside', 7],
      ],
    },
    {
      name: 'template literal and variable titles keep their source text',
      text: lines(
        'const name = "x"',
        'it(`works for ${name}`, () => {})',
        'it(title, () => {})',
        'it(`no substitution`, () => {})',
        "it('a ' + name, () => {})",
      ),
      expected: [
        ['`works for ${name}`', 2],
        ['title', 3],
        ['no substitution', 4],
        ["'a ' + name", 5],
      ],
    },
    {
      name: 'two cases with the same id get a position suffix, so ids are unique',
      text: lines("it('dup', () => {})", "it('solo', () => {})", "it('dup', () => {})"),
      expected: [
        ['dup#1', 1],
        ['solo', 2],
        ['dup#2', 3],
      ],
    },
    {
      name: 'a shared suite body (.suite.ts)',
      file: 'pkg/x.integration.suite.ts',
      text: lines(
        'export function engineSuite(name: string) {',
        '  describe(name, () => {',
        "    it('does the thing', async () => {})",
        '  })',
        '}',
      ),
      expected: [['name > does the thing', 3]],
    },
    {
      name: 'a .tsx file',
      file: 'pkg/page.ui.test.tsx',
      text: lines(
        "it('renders', () => {",
        '  const el = <div className="x">hi</div>',
        '  expect(el).toBeTruthy()',
        '})',
      ),
      expected: [['renders', 1]],
    },
    {
      name: 'it.todo and a hook are not cases',
      text: lines("it.todo('later')", 'beforeEach(() => {})', "it('real', () => {})"),
      expected: [['real', 3]],
    },
  ]
  for (const row of matrix) {
    it(row.name, () => {
      expect(idsAndLines(row.text, row.file)).toEqual(row.expected)
    })
  }

  it('ids carry the file path first and are unique inside a file', () => {
    const r = sliceSource(F, lines("it('a', () => {})", "it('a', () => {})", "it('b', () => {})"))
    expect(r.status).toBe('ok')
    expect(r.cases.every((c) => c.id.startsWith(`${F} > `) && c.file === F)).toBe(true)
    expect(new Set(r.cases.map((c) => c.id)).size).toBe(3)
  })

  it('a file with a syntax error is unparsed with a reason, not an exception', () => {
    const r = sliceSource(F, "it('broken', () => {")
    expect(r.status).toBe('unparsed')
    expect(r.cases).toEqual([])
    expect(r.reason).toMatch(/\S/)
  })

  it('a test file with no cases is empty', () => {
    expect(sliceSource(F, "import { it } from 'vitest'\nconst x = 1").status).toBe('empty')
  })
})

describe('sliceFiles: one bad file does not stop the others', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-slice-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  it('reports unparsed and empty files and still slices the rest', () => {
    writeFileSync(join(dir, 'good.test.ts'), "it('one', () => {})\nit('two', () => {})")
    writeFileSync(join(dir, 'bad.test.ts'), "it('x', () => {")
    writeFileSync(join(dir, 'none.test.ts'), 'export const x = 1')
    const r = sliceFiles(dir, ['good.test.ts', 'bad.test.ts', 'none.test.ts'])
    expect(r.files).toBe(3)
    expect(r.cases.map((c) => c.id)).toEqual(['good.test.ts > one', 'good.test.ts > two'])
    expect(r.unparsed.map((u) => u.file)).toEqual(['bad.test.ts'])
    expect(r.empty).toEqual(['none.test.ts'])
  })
})

describe('listTestFiles: tracked test files only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-list-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  it('lists tracked *.test.ts, *.test.tsx and *.suite.ts, not untracked or other files', () => {
    const put = (p: string) => {
      mkdirSync(dirname(join(dir, p)), { recursive: true })
      writeFileSync(join(dir, p), '')
    }
    for (const p of [
      'a/x.test.ts',
      'a/y.test.tsx',
      'b/z.integration.suite.ts',
      'a/helper.ts',
      'a/notes.md',
      'c/untracked.test.ts',
    ])
      put(p)
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' })
    git('init', '-q')
    git('add', 'a/x.test.ts', 'a/y.test.tsx', 'b/z.integration.suite.ts', 'a/helper.ts', 'a/notes.md')
    expect(listTestFiles(dir)).toEqual(['a/x.test.ts', 'a/y.test.tsx', 'b/z.integration.suite.ts'])
  })
})

describe('the state (D2)', () => {
  const src = lines(
    "import { expectColumns } from './helpers'",
    "import { it, describe, beforeEach } from 'vitest'",
    "const AGENT_COLUMNS = ['id', 'name']",
    'const UNUSED = 1',
    'const HELPER_CONST = 42',
    'function check(table: string, cols: string[]) {',
    '  return table.length + cols.length + HELPER_CONST',
    '}',
    "describe('schema', () => {",
    '  beforeEach(() => {',
    '    setup()',
    '  })',
    "  it('agents', () => {",
    "    check('agents', AGENT_COLUMNS)",
    '  })',
    "  it('imported', () => {",
    "    expectColumns('x')",
    '  })',
    "  it('other', () => {",
    '    expect(2).toBe(2)',
    '  })',
    '})',
  )
  const byTitle = (text: string, title: string, opts: { maxChars?: number } = {}) => {
    const c = sliceSource(F, text, opts).cases.find((x) => x.title === title)
    if (!c) throw new Error(`no case ${title}`)
    return c
  }

  it('holds exactly the spec parts', () => {
    const c = byTitle(src, 'agents')
    expect(Object.keys(c.state).sort()).toEqual(['case', 'declarations', 'describes', 'hooks', 'imports', 'path'])
    expect(c.state.path).toBe(F)
    expect(c.state.describes).toEqual(['schema'])
    expect(c.state.imports).toHaveLength(2)
    expect(c.state.hooks).toHaveLength(1)
    expect(c.state.hooks[0]).toContain('setup()')
    expect(c.state.case).toContain("check('agents', AGENT_COLUMNS)")
    expect(c.truncated).toBe(false)
  })

  it("carries a referenced constant, the helper it passes it to, and the helper's own constant", () => {
    const decls = byTitle(src, 'agents').state.declarations
    // Each is a whole declaration of its own: the helper's body mentions HELPER_CONST, so its text alone proves nothing.
    expect(decls).toHaveLength(3)
    for (const start of ['const AGENT_COLUMNS', 'const HELPER_CONST', 'function check'])
      expect(
        decls.some((d) => d.startsWith(start)),
        start,
      ).toBe(true)
    expect(decls.join('\n')).not.toContain('UNUSED')
  })

  it('a case that reaches nothing carries no declaration, and an import is not followed', () => {
    expect(byTitle(src, 'other').state.declarations).toEqual([])
    expect(byTitle(src, 'imported').state.declarations).toEqual([])
  })

  it('slicing twice gives equal ids and hashes', () => {
    const a = sliceSource(F, src).cases.map((c) => [c.id, c.stateHash])
    const b = sliceSource(F, src).cases.map((c) => [c.id, c.stateHash])
    expect(a).toEqual(b)
    expect(new Set(a.map((x) => x[1])).size).toBe(3)
  })

  it("editing a case changes its hash and not an unrelated case's", () => {
    const edited = src.replace('expect(2).toBe(2)', 'expect(3).toBe(3)')
    expect(byTitle(edited, 'other').stateHash).not.toBe(byTitle(src, 'other').stateHash)
    expect(byTitle(edited, 'agents').stateHash).toBe(byTitle(src, 'agents').stateHash)
    expect(byTitle(edited, 'imported').stateHash).toBe(byTitle(src, 'imported').stateHash)
  })

  it('editing a referenced declaration changes the hashes of the cases that reach it, and no other', () => {
    for (const name of ['AGENT_COLUMNS', 'HELPER_CONST']) {
      const edited = src.replace(`const ${name} = `, `const ${name} = 0 + `)
      expect(byTitle(edited, 'agents').stateHash).not.toBe(byTitle(src, 'agents').stateHash)
      expect(byTitle(edited, 'other').stateHash).toBe(byTitle(src, 'other').stateHash)
      expect(byTitle(edited, 'imported').stateHash).toBe(byTitle(src, 'imported').stateHash)
    }
  })

  it('an over-cap case is cut hooks first, then imports, then declarations, then the case tail, and is flagged', () => {
    const big = `// ${'x'.repeat(400)}\n`
    const text = lines(
      "import { it } from 'vitest'",
      `const A = ${JSON.stringify('a'.repeat(300))}`,
      "describe('d', () => {",
      `  beforeEach(() => { setup('${'h'.repeat(300)}') })`,
      "  it('big', () => {",
      '    use(A)',
      `    ${big}`,
      '  })',
      '})',
    )
    const full = byTitle(text, 'big', { maxChars: 100_000 })
    expect(full.truncated).toBe(false)
    const size = (c: typeof full) => JSON.stringify(c.state).length
    const total = size(full)
    // Just under the full size: hooks go first, everything else survives.
    const noHooks = byTitle(text, 'big', { maxChars: total - 10 })
    expect(noHooks.truncated).toBe(true)
    expect(noHooks.state.hooks).toEqual([])
    expect(noHooks.state.imports).toHaveLength(1)
    expect(noHooks.state.declarations).toHaveLength(1)
    // Smaller: imports go next.
    const noImports = byTitle(text, 'big', { maxChars: size(noHooks) - 10 })
    expect(noImports.state.imports).toEqual([])
    expect(noImports.state.declarations).toHaveLength(1)
    // Smaller: declarations go next.
    const noDecls = byTitle(text, 'big', { maxChars: size(noImports) - 10 })
    expect(noDecls.state.declarations).toEqual([])
    expect(noDecls.state.case).toContain('use(A)')
    // Smaller still: the tail of the case is cut.
    const cutCase = byTitle(text, 'big', { maxChars: 200 })
    expect(cutCase.state.case.length).toBeLessThan(full.state.case.length)
    expect(full.state.case.startsWith(cutCase.state.case)).toBe(true)
    for (const c of [noHooks, noImports, noDecls, cutCase]) expect(c.truncated).toBe(true)
    expect(size(cutCase)).toBeLessThanOrEqual(200)
    expect(size(noHooks)).toBeLessThanOrEqual(total - 10)
    expect(size(noImports)).toBeLessThanOrEqual(size(noHooks) - 10)
    expect(size(noDecls)).toBeLessThanOrEqual(size(noImports) - 10)
  })
})

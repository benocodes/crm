import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// The decisions log (#359, #383), run as the agents run it, against a throwaway knowledge folder.
const SCRIPT = new URL('./decisions.mjs', import.meta.url).pathname
let knowledge: string

const run = (...args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, VIBASE_KNOWLEDGE_DIR: knowledge },
    encoding: 'utf8',
  })

const spec = (folder: string, id: string, body: string) => {
  mkdirSync(join(knowledge, 'specs', folder), { recursive: true })
  writeFileSync(join(knowledge, 'specs', folder, `${id}.md`), body)
}
const rowsOf = (file: string) =>
  readFileSync(join(knowledge, 'decisions', file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
const fill = (file: string, count: number) =>
  writeFileSync(
    join(knowledge, 'decisions', file),
    Array.from({ length: count }, (_, i) => `${JSON.stringify({ ref: `1.${i + 1}`, issue: 1, decision: 'x' })}\n`).join(
      '',
    ),
  )
const addArgs = (issue: string, text: string, ...more: string[]) => [
  'add',
  '--issue',
  issue,
  '--by',
  'planner',
  '--stage',
  'plan',
  ...more,
  text,
]

beforeEach(() => {
  knowledge = mkdtempSync(join(tmpdir(), 'decisions-'))
  spec('015-CORE259-control-plane', 'CORE259', '---\nid: CORE259\ntype: spec\n---\n# Control plane\n')
  spec(
    '015-CORE351-api-key-operations',
    'CORE351',
    '---\nid: CORE351\nimplements: "[[CORE259]]"\n---\n# Keys\n\n**Assumes merged:** [[CORE328]], follow-up #357 and #351.\n\n## Scope\nBackground: [[CHN5]] and #12.\n',
  )
  spec('015-CORE350-api-key-auth', 'CORE350', '---\nid: CORE350\nimplements: "[[CORE259]]"\n---\n# Auth\n')
  spec('015-CORE328-api-keys-store', 'CORE328', '---\nid: CORE328\nimplements: "[[CORE259]]"\n---\n# Store\n')
  spec('001-CHN5-gmail', 'CHN5', '---\nid: CHN5\n---\n# Gmail\n')
})
afterEach(() => rmSync(knowledge, { recursive: true, force: true }))

describe('decisions add', () => {
  it('appends a row with its spec and parent filled in from the vault', () => {
    const out = run(...addArgs('351', 'list reads control only', '--id', 'P3', '--revisit-if', 'owners need old keys'))
    expect(out.status).toBe(0)
    expect(out.stdout).toBe('recorded 351.1\n')
    expect(rowsOf('board.jsonl')).toEqual([
      {
        ref: '351.1',
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        issue: 351,
        spec: 'CORE351',
        parent: 'CORE259',
        by: 'planner',
        stage: 'plan',
        id: 'P3',
        decision: 'list reads control only',
        revisit_if: 'owners need old keys',
      },
    ])
  })

  it('numbers refs per issue and records an issue that has no spec folder', () => {
    run(...addArgs('351', 'one'))
    run(...addArgs('999', 'no spec yet'))
    expect(run(...addArgs('351', 'two')).stdout).toBe('recorded 351.2\n')
    expect(rowsOf('board.jsonl')[1]).toMatchObject({ ref: '999.1', spec: null, parent: null })
  })

  it('never tells the recording agent how full the milestone is', () => {
    mkdirSync(join(knowledge, 'decisions'))
    fill('board.jsonl', 400)
    const out = run(...addArgs('351', 'one more'))
    expect(out.status).toBe(0)
    expect(out.stdout + out.stderr).toBe('recorded 351.1\n')
    expect(rowsOf('board.jsonl')).toHaveLength(401)
  })

  it.each([
    ['a missing issue', ['add', '--by', 'coder', '--stage', 'code', 'x']],
    ['an unknown author', ['add', '--issue', '1', '--by', 'someone', '--stage', 'code', 'x']],
    ['an unknown stage', ['add', '--issue', '1', '--by', 'coder', '--stage', 'later', 'x']],
    ['no decision text', ['add', '--issue', '1', '--by', 'coder', '--stage', 'code']],
    ['a decision over the length limit', addArgs('1', 'x'.repeat(301))],
    ['a multi-line decision', addArgs('1', 'one\ntwo')],
    ['a supersedes that names no row', addArgs('1', 'x', '--supersedes', '1.7')],
    ['an unknown flag', addArgs('1', 'x', '--nope')],
  ])('refuses %s and writes nothing', (_name, args) => {
    const out = run(...args)
    expect(out.status).toBe(2)
    expect(out.stderr).toMatch(/^decisions: /)
    expect(existsSync(join(knowledge, 'decisions', 'board.jsonl'))).toBe(false)
  })
})

describe('decisions find', () => {
  beforeEach(() => {
    run(...addArgs('351', 'list reads control only', '--id', 'P3'))
    run(...addArgs('351', 'list also reads the CRM tail', '--supersedes', '351.1'))
    run(...addArgs('350', 'control decides first'))
    run(...addArgs('259', 'one control database'))
    run(...addArgs('357', 'events leave the feed'))
    run(...addArgs('5', 'unrelated'))
  })

  it('prints the decisions of an issue, by number or by spec ID, with superseded rows marked', () => {
    const byNumber = run('find', '351')
    expect(byNumber.stdout).toContain('#351 CORE351 (implements CORE259): 2 decisions')
    expect(byNumber.stdout).toContain('351.1')
    expect(byNumber.stdout).toContain('[superseded by 351.2]')
    expect(byNumber.stdout).not.toContain('control decides first')
    expect(run('find', 'CORE351').stdout).toBe(byNumber.stdout)
  })

  it('finds the parent, sibling cycles and header links, and leaves body links to --wide', () => {
    const found = JSON.parse(run('find', '351', '--json').stdout)
    expect(found.related).toEqual([
      { key: 'CORE259', why: 'parent spec', decisions: 1 },
      { key: 'CORE328', why: 'sibling cycle of CORE259', decisions: 0 },
      { key: 'CORE350', why: 'sibling cycle of CORE259', decisions: 1 },
      { key: '#357', why: 'named in the header', decisions: 1 },
    ])
    const wide = JSON.parse(run('find', '351', '--json', '--wide').stdout)
    expect(wide.related.map((r: { key: string }) => r.key)).toEqual([
      'CORE259',
      'CORE328',
      'CORE350',
      '#357',
      'CHN5',
      '#12',
    ])
  })

  it('finds the cycles of a parent spec', () => {
    const found = JSON.parse(run('find', 'CORE259', '--json').stdout)
    expect(found.related.map((r: { key: string; why: string }) => [r.key, r.why])).toEqual([
      ['CORE328', 'cycle of this spec'],
      ['CORE350', 'cycle of this spec'],
      ['CORE351', 'cycle of this spec'],
    ])
  })

  it('prints related decisions in full with --related, across the files of the log', () => {
    writeFileSync(
      join(knowledge, 'decisions', 'sprint-001.jsonl'),
      `${JSON.stringify({ ref: '328.1', issue: 328, spec: 'CORE328', parent: 'CORE259', decision: 'from before the milestone files' })}\n`,
    )
    run(...addArgs('350', 'a later decision'))
    const out = run('find', '351', '--related').stdout
    expect(out).toContain('control decides first')
    expect(out).toContain('from before the milestone files')
    expect(out).toContain('a later decision')
    expect(rowsOf('sprint-001.jsonl')).toHaveLength(1)
    expect(rowsOf('board.jsonl').at(-1)).toMatchObject({ ref: '350.2' })
  })
})

const milestone = (folder: string, letter: string, lines: string[]) => {
  mkdirSync(join(knowledge, 'milestones', folder), { recursive: true })
  writeFileSync(join(knowledge, 'milestones', folder, `milestone-${letter}.md`), lines.join('\n'))
}
const note = (letter: string, status: string, needed: string[], left: string[] = []) => [
  '---',
  `id: ${letter}`,
  `status: ${status}`,
  `title: milestone ${letter.toLowerCase()}`,
  '---',
  '## Needed',
  ...needed,
  '## Left',
  ...left,
]

describe('decisions add, filing by milestone', () => {
  beforeEach(() => {
    // G is built and still lists a row that was cut into H; H is active; D is finished.
    milestone('010-G-auth', 'G', note('G', 'built', ['| Store | [[CORE328]] |', '| Cut to H | #700 |']))
    milestone(
      '020-H-hq',
      'H',
      note('H', 'active', ['| Control plane | [[CORE259]] |', '| Cut | #700 |'], ['Not here: #800']),
    )
    milestone('done/D-webhooks', 'D', note('D', 'done', ['| Gmail | [[CHN5]] |']))
  })

  it('files a row under the milestone whose Needed table names its issue, its spec or a spec it implements', () => {
    run(...addArgs('259', 'the spec itself'))
    run(...addArgs('351', 'a cycle of the control plane'))
    run(...addArgs('5', 'a finished milestone, written while H is active'))
    expect(rowsOf('milestone-H.jsonl').map((row) => row.ref)).toEqual(['259.1', '351.1'])
    expect(rowsOf('milestone-D.jsonl').map((row) => row.ref)).toEqual(['5.1'])
  })

  it('prefers the active milestone when an earlier one still lists the row', () => {
    run(...addArgs('700', 'cut from G into H'))
    expect(rowsOf('milestone-H.jsonl')).toHaveLength(1)
    expect(existsSync(join(knowledge, 'decisions', 'milestone-G.jsonl'))).toBe(false)
  })

  it('files a row no table names under the active milestone, and under the board when none is active', () => {
    run(...addArgs('800', 'named only outside a Needed table'))
    expect(rowsOf('milestone-H.jsonl').map((row) => row.ref)).toEqual(['800.1'])
    milestone('020-H-hq', 'H', note('H', 'built', ['| Control plane | [[CORE259]] |']))
    run(...addArgs('801', 'between milestones'))
    run(...addArgs('259', 'still H, though H is built'))
    expect(rowsOf('board.jsonl').map((row) => row.ref)).toEqual(['801.1'])
    expect(rowsOf('milestone-H.jsonl').map((row) => row.ref)).toEqual(['800.1', '259.1'])
  })

  it('never writes to a numbered sprint file from before the milestone files', () => {
    mkdirSync(join(knowledge, 'decisions'))
    fill('sprint-003.jsonl', 3)
    run(...addArgs('259', 'after the change'))
    expect(rowsOf('sprint-003.jsonl')).toHaveLength(3)
    expect(rowsOf('milestone-H.jsonl')).toHaveLength(1)
  })
})

describe('decisions size', () => {
  it('groups the active milestone by the spec its rows belong to, largest first', () => {
    milestone('020-H-hq', 'H', note('H', 'active', ['| Control plane | [[CORE259]] |', '| Follow-up | #999 |']))
    milestone('done/D-webhooks', 'D', note('D', 'done', ['| Gmail | [[CHN5]] |']))
    run(...addArgs('351', 'a cycle of the control plane'))
    run(...addArgs('350', 'another cycle'))
    run(...addArgs('259', 'the spec itself'))
    run(...addArgs('999', 'an issue with no spec'))
    run(...addArgs('5', 'another milestone, not counted'))
    expect(run('size').stdout).toBe(
      ['Milestone H — milestone h: 4 decisions', '     3   75%  CORE259', '     1   25%  #999', ''].join('\n'),
    )
  })

  it('refuses when no milestone is active', () => {
    expect(run('size').status).toBe(2)
  })
})

describe('decisions status', () => {
  beforeEach(() => mkdirSync(join(knowledge, 'decisions')))

  it.each([
    [249, 'not due'],
    [250, 'DUE'],
    [299, 'DUE'],
    [300, 'OVERDUE'],
  ])('reports an active milestone of %i decisions as budget %s, without printing a count', (count, word) => {
    milestone('020-H-hq', 'H', note('H', 'active', []))
    fill('milestone-H.jsonl', count)
    fill('milestone-G.jsonl', 400)
    expect(run('status').stdout).toBe(`decisions: milestone-H.jsonl, budget ${word}\n`)
  })

  it('measures a paused milestone, and says so when none is active', () => {
    milestone('020-H-hq', 'H', note('H', 'paused', []))
    expect(run('status').stdout).toBe('decisions: milestone-H.jsonl, budget not due\n')
    milestone('020-H-hq', 'H', note('H', 'built', []))
    expect(run('status').stdout).toBe('decisions: no milestone is active\n')
  })

  it('reports SPRINT.md against its line budget', () => {
    writeFileSync(join(knowledge, 'SPRINT.md'), 'line\n'.repeat(149))
    expect(run('status').stdout).toContain('SPRINT.md: 150 lines, budget 150, ok')
    writeFileSync(join(knowledge, 'SPRINT.md'), 'line\n'.repeat(400))
    expect(run('status').stdout).toContain('SPRINT.md: 401 lines, budget 150, OVER')
  })

  it('has no rotate command any more', () => {
    expect(run('rotate').status).toBe(2)
  })
})

#!/usr/bin/env node
// The sprint decisions log (#359): `knowledge/decisions/sprint-NNN.jsonl`, append-only, one decision per row, each row
// naming its issue and spec. `add` is what the planner and the coder run as they work; `find` answers "what was decided
// for this issue, and around it"; `status`, `rotate` and `size` are the orchestrator's. `add` and `find` never print how full the
// sprint is: the agents recording decisions must have no reason to record fewer of them. No dependencies.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

// A sprint is one milestone (#372). At this many decisions the milestone is at its budget: it takes on no new scope
// (`sprint-planning`, "admit") and is finished as it stands.
const SPRINT_DECISION_CAP = 250
// Past this the milestone is too big for one sprint: the orchestrator stops and asks the user how to cut it.
const SPRINT_DECISION_HARD_LIMIT = 300
const SPRINT_FILE_LINE_BUDGET = 150
const DECISION_MAX_CHARS = 300
const BY = ['planner', 'coder', 'orchestrator', 'user']
const STAGES = ['spec', 'plan', 'code', 'review', 'retro', 'ruling', 'finding']
const SPEC_FOLDER = /^\d+-([A-Z]+\d+)-/
const SPEC_ID = /^[A-Z]+\d+$/

const USAGE = `usage:
  decisions add --issue <n> --by <${BY.join('|')}> --stage <${STAGES.join('|')}>
                [--id <D3>] [--revisit-if <text>] [--supersedes <ref>] "<the decision, one sentence>"
  decisions find <issue number | spec ID> [--related] [--wide] [--json]
  decisions status
  decisions rotate [--force]
  decisions size
`

class UsageError extends Error {}
const fail = (message) => {
  throw new UsageError(message)
}

/** The knowledge repo is a nested checkout of the main checkout only, so a worktree resolves it through git. */
function knowledgeDir() {
  if (process.env.VIBASE_KNOWLEDGE_DIR) return process.env.VIBASE_KNOWLEDGE_DIR
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: scriptDir,
    encoding: 'utf8',
  }).trim()
  return join(dirname(commonDir), 'knowledge')
}

const sprintFileName = (n) => `sprint-${String(n).padStart(3, '0')}.jsonl`

function sprintFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => /^sprint-\d{3}\.jsonl$/.test(name))
    .sort()
}

function readRows(dir) {
  return sprintFiles(dir).flatMap((file) =>
    readFileSync(join(dir, file), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line, index) => {
        try {
          return { ...JSON.parse(line), file }
        } catch {
          return fail(`${file}:${index + 1} is not valid JSON`)
        }
      }),
  )
}

/** Spec ID -> { id, issue, folder, implements, headerLinks, allLinks }, read from `knowledge/specs/<seq>-<ID>-<slug>/`. */
function readSpecs(knowledge) {
  const specsDir = join(knowledge, 'specs')
  const specs = new Map()
  if (!existsSync(specsDir)) return specs
  for (const folder of readdirSync(specsDir)) {
    const id = SPEC_FOLDER.exec(folder)?.[1]
    if (!id) continue
    specs.set(id, { id, issue: Number(/\d+$/.exec(id)[0]), folder: join(specsDir, folder) })
  }
  return specs
}

const links = (text) => ({
  specs: [...text.matchAll(/\[\[([A-Z]+\d+)(?:[|#][^\]]*)?\]\]/g)].map((m) => m[1]),
  issues: [...text.matchAll(/(?<![\w/])#(\d{1,5})\b/g)].map((m) => Number(m[1])),
})

function readSpecFile(spec) {
  const file = join(spec.folder, `${spec.id}.md`)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

function parentOf(spec) {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(readSpecFile(spec))?.[1] ?? ''
  const line = /^implements:(.*)$/m.exec(frontmatter)?.[1] ?? ''
  return /\[\[([A-Z]+\d+)/.exec(line)?.[1] ?? null
}

function specForIssue(specs, issue) {
  return [...specs.values()].find((spec) => spec.issue === issue) ?? null
}

function add(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      issue: { type: 'string' },
      by: { type: 'string' },
      stage: { type: 'string' },
      id: { type: 'string' },
      'revisit-if': { type: 'string' },
      supersedes: { type: 'string' },
      // For importing decisions recorded before this log existed.
      date: { type: 'string' },
    },
  })
  const issue = Number(values.issue)
  if (!Number.isInteger(issue) || issue <= 0) fail('--issue must be the issue number in benocodes/crm')
  if (!BY.includes(values.by)) fail(`--by must be one of ${BY.join(', ')}`)
  if (!STAGES.includes(values.stage)) fail(`--stage must be one of ${STAGES.join(', ')}`)
  if (positionals.length !== 1) fail('give the decision as one quoted argument')
  const decision = positionals[0].trim()
  if (decision === '' || decision.includes('\n')) fail('the decision is one line of text')
  if (decision.length > DECISION_MAX_CHARS) {
    fail(
      `the decision is ${decision.length} characters; keep it under ${DECISION_MAX_CHARS} and record one decision per row (the reasoning lives in the spec or RESULT.md)`,
    )
  }
  const date = values.date ?? new Date().toLocaleDateString('en-CA')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('--date is YYYY-MM-DD')

  const knowledge = knowledgeDir()
  if (!existsSync(knowledge)) fail(`no knowledge repo at ${knowledge}`)
  const dir = join(knowledge, 'decisions')
  const rows = readRows(dir)
  if (values.supersedes && !rows.some((row) => row.ref === values.supersedes)) {
    fail(`--supersedes ${values.supersedes}: no such decision`)
  }
  const spec = specForIssue(readSpecs(knowledge), issue)
  const row = {
    ref: `${issue}.${rows.filter((r) => r.issue === issue).length + 1}`,
    date,
    issue,
    spec: spec?.id ?? null,
    parent: spec ? parentOf(spec) : null,
    by: values.by,
    stage: values.stage,
    ...(values.id ? { id: values.id } : {}),
    decision,
    ...(values['revisit-if'] ? { revisit_if: values['revisit-if'].trim() } : {}),
    ...(values.supersedes ? { supersedes: values.supersedes } : {}),
  }
  mkdirSync(dir, { recursive: true })
  const file = sprintFiles(dir).at(-1) ?? sprintFileName(1)
  appendFileSync(join(dir, file), `${JSON.stringify(row)}\n`)
  process.stdout.write(`recorded ${row.ref}\n`)
}

/** The specs and issues around one spec: its parent, the cycles sharing that parent, its own cycles, and what its header names. */
function relatedTo(specs, spec, issue, wide) {
  const related = new Map()
  const note = (key, why) => {
    if (!related.has(key)) related.set(key, why)
  }
  if (!spec) return related
  const parent = parentOf(spec)
  if (parent) note(parent, 'parent spec')
  for (const other of specs.values()) {
    if (other.id === spec.id) continue
    const otherParent = parentOf(other)
    if (otherParent === spec.id) note(other.id, 'cycle of this spec')
    else if (parent && otherParent === parent) note(other.id, `sibling cycle of ${parent}`)
  }
  const text = readSpecFile(spec)
  const header = links(text.split(/\n## /)[0])
  for (const id of header.specs) note(id, 'named in the header')
  for (const n of header.issues) note(`#${n}`, 'named in the header')
  if (wide) {
    const all = readdirSync(spec.folder)
      .filter((name) => name.endsWith('.md'))
      .map((name) => links(readFileSync(join(spec.folder, name), 'utf8')))
    for (const id of all.flatMap((l) => l.specs)) note(id, 'linked')
    for (const n of all.flatMap((l) => l.issues)) note(`#${n}`, 'mentioned')
  }
  related.delete(spec.id)
  related.delete(`#${issue}`)
  // A spec and its own issue number are one thing: keep the spec.
  for (const key of [...related.keys()]) {
    if (key.startsWith('#') && related.has(specForIssue(specs, Number(key.slice(1)))?.id)) related.delete(key)
  }
  return related
}

function find(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { related: { type: 'boolean' }, wide: { type: 'boolean' }, json: { type: 'boolean' } },
  })
  if (positionals.length !== 1) fail('give one issue number or spec ID')
  const target = positionals[0].replace(/^#/, '')
  const knowledge = knowledgeDir()
  const specs = readSpecs(knowledge)
  const spec = SPEC_ID.test(target) ? (specs.get(target) ?? null) : specForIssue(specs, Number(target))
  const issue = spec?.issue ?? Number(/\d+$/.exec(target)?.[0])
  if (!Number.isInteger(issue)) fail(`${positionals[0]} is neither an issue number nor a spec ID`)

  const rows = readRows(join(knowledge, 'decisions'))
  const supersededBy = new Map(rows.filter((row) => row.supersedes).map((row) => [row.supersedes, row.ref]))
  const rowsFor = (key) =>
    rows.filter((row) => (key.startsWith('#') ? row.issue === Number(key.slice(1)) : row.spec === key))
  const own = rows.filter((row) => row.issue === issue)
  const related = [...relatedTo(specs, spec, issue, values.wide)].map(([key, why]) => ({
    key,
    why,
    decisions: rowsFor(key),
  }))

  if (values.json) {
    const strip = ({ file, ...row }) => ({ ...row, superseded_by: supersededBy.get(row.ref) ?? null })
    process.stdout.write(
      `${JSON.stringify(
        {
          issue,
          spec: spec?.id ?? null,
          decisions: own.map(strip),
          related: related.map((r) => ({
            ...r,
            decisions: values.related ? r.decisions.map(strip) : r.decisions.length,
          })),
        },
        null,
        2,
      )}\n`,
    )
    return
  }
  const print = (row) => {
    const tag = [row.spec, row.id].filter(Boolean).join(' ')
    const superseded = supersededBy.has(row.ref) ? ` [superseded by ${supersededBy.get(row.ref)}]` : ''
    process.stdout.write(
      `  ${row.ref}  ${row.date}  ${row.by}/${row.stage}  ${tag}${superseded}\n      ${row.decision}\n`,
    )
    if (row.revisit_if) process.stdout.write(`      revisit if: ${row.revisit_if}\n`)
    if (row.supersedes) process.stdout.write(`      supersedes: ${row.supersedes}\n`)
  }
  const parent = spec ? parentOf(spec) : null
  const title = [`#${issue}`, spec?.id, parent ? `(implements ${parent})` : null].filter(Boolean).join(' ')
  process.stdout.write(`${title}: ${own.length} decision${own.length === 1 ? '' : 's'}\n`)
  own.forEach(print)
  if (related.length === 0) return
  process.stdout.write(`\nRelated${values.related ? '' : ' (--related prints their decisions)'}:\n`)
  for (const r of related) {
    process.stdout.write(`  ${r.key}  ${r.why}: ${r.decisions.length}\n`)
    if (values.related) r.decisions.forEach(print)
  }
}

function currentSprint(dir) {
  const file = sprintFiles(dir).at(-1)
  if (!file) return { file: null, count: 0 }
  const count = readFileSync(join(dir, file), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '').length
  return { file, count }
}

function status() {
  const knowledge = knowledgeDir()
  const { file, count } = currentSprint(join(knowledge, 'decisions'))
  const rollover = count >= SPRINT_DECISION_HARD_LIMIT ? 'OVERDUE' : count >= SPRINT_DECISION_CAP ? 'DUE' : 'not due'
  process.stdout.write(`decisions: ${file ?? 'none recorded yet'}, rollover ${rollover}\n`)
  const sprintFile = join(knowledge, 'SPRINT.md')
  if (existsSync(sprintFile)) {
    const lines = readFileSync(sprintFile, 'utf8').split('\n').length
    const over = lines > SPRINT_FILE_LINE_BUDGET
    process.stdout.write(
      `SPRINT.md: ${lines} lines, budget ${SPRINT_FILE_LINE_BUDGET}, ${over ? 'OVER: archive until it fits' : 'ok'}\n`,
    )
  }
}

const MILESTONE_FOLDER = /^(?:\d{3}-)?([A-Z]+)-/

/**
 * The milestones of `knowledge/milestones/`: ranked folders `<seq>-<letter>-<slug>/` in rank order, then the finished
 * ones under `done/<letter>-<slug>/`. Each is read from its `milestone-<letter>.md`, with the specs and issues it names.
 */
function readMilestones(knowledge) {
  const root = join(knowledge, 'milestones')
  const foldersOf = (dir) =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && MILESTONE_FOLDER.test(entry.name))
          .map((entry) => join(dir, entry.name))
          .sort()
      : []
  return [...foldersOf(root), ...foldersOf(join(root, 'done'))].flatMap((folder) => {
    const letter = MILESTONE_FOLDER.exec(folder.split('/').at(-1))[1]
    const file = join(folder, `milestone-${letter}.md`)
    if (!existsSync(file)) return []
    const text = readFileSync(file, 'utf8')
    const title = /^title:\s*(.+)$/m.exec(/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '')?.[1]
    const name = `Milestone ${letter}${title ? ` — ${title.trim().replace(/^["']|["']$/g, '')}` : ''}`
    return [{ name, specs: new Set(links(text).specs), issues: new Set(links(text).issues) }]
  })
}

/** The current sprint's decisions grouped by the milestone whose file names their issue, spec or a spec it implements. */
function size() {
  const knowledge = knowledgeDir()
  const dir = join(knowledge, 'decisions')
  const { file } = currentSprint(dir)
  if (!file) fail('no decisions recorded yet')
  const specs = readSpecs(knowledge)
  const milestones = readMilestones(knowledge)
  const lineage = (row) => {
    const ids = [row.spec, row.parent].filter(Boolean)
    for (let spec = specs.get(ids.at(-1)); spec && ids.length < 6; spec = specs.get(ids.at(-1))) {
      const parent = parentOf(spec)
      if (!parent || ids.includes(parent)) break
      ids.push(parent)
    }
    return ids
  }
  const NONE = 'no milestone'
  const counts = new Map([...milestones.map((m) => [m.name, 0]), [NONE, 0]])
  const rows = readRows(dir).filter((row) => row.file === file)
  for (const row of rows) {
    const ids = lineage(row)
    const owner = milestones.find((m) => m.issues.has(row.issue) || ids.some((id) => m.specs.has(id)))
    counts.set(owner?.name ?? NONE, counts.get(owner?.name ?? NONE) + 1)
  }
  process.stdout.write(`${file}: ${rows.length} decisions\n`)
  for (const [name, count] of counts) {
    if (name === NONE && count === 0) continue
    const share = rows.length === 0 ? 0 : Math.round((count / rows.length) * 100)
    process.stdout.write(`  ${String(count).padStart(4)}  ${String(share).padStart(3)}%  ${name}\n`)
  }
}

function rotate(argv) {
  const { values } = parseArgs({ args: argv, options: { force: { type: 'boolean' } } })
  const dir = join(knowledgeDir(), 'decisions')
  const { file, count } = currentSprint(dir)
  if (!file) fail('nothing to rotate: no decisions recorded yet')
  if (count === 0) fail(`${file} is empty: it is already the new sprint's file`)
  if (count < SPRINT_DECISION_CAP && !values.force) {
    fail('rollover is not due (`decisions status`); pass --force to close the sprint early')
  }
  const next = sprintFileName(Number(/\d{3}/.exec(file)[0]) + 1)
  writeFileSync(join(dir, next), '', { flag: 'wx' })
  process.stdout.write(`closed decisions/${file}\nopened decisions/${next}\n`)
}

const [command, ...rest] = process.argv.slice(2)
try {
  if (command === 'add') add(rest)
  else if (command === 'find') find(rest)
  else if (command === 'status') status()
  else if (command === 'size') size()
  else if (command === 'rotate') rotate(rest)
  else {
    process.stderr.write(USAGE)
    process.exit(command === undefined || command === '--help' ? 0 : 2)
  }
} catch (err) {
  // parseArgs' own errors (an unknown flag) are usage errors too.
  if (err instanceof UsageError || err?.code?.startsWith?.('ERR_PARSE_ARGS')) {
    process.stderr.write(`decisions: ${err.message}\n`)
    process.exit(2)
  }
  throw err
}

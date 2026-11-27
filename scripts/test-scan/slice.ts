// Slice test files into cases and build the state sent for each (OPS670 D1, D2).
// A case is one `it` or `test` call found by parsing with the TypeScript compiler API, never by regular expression.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

export type CaseState = {
  path: string
  describes: string[]
  imports: string[]
  hooks: string[]
  declarations: string[]
  case: string
}
export type Case = {
  id: string
  file: string
  line: number
  title: string
  describes: string[]
  state: CaseState
  stateHash: string
  truncated: boolean
}
export type SliceResult = { status: 'ok' | 'empty' | 'unparsed'; cases: Case[]; reason?: string }
export type SliceFilesResult = {
  cases: Case[]
  unparsed: { file: string; reason: string }[]
  empty: string[]
  files: number
}
export const DEFAULT_MAX_STATE_CHARS = 24_000

const CASE_ROOTS = new Set(['it', 'test'])
const DESCRIBE_ROOTS = new Set(['describe', 'suite'])
const HOOK_ROOTS = new Set(['beforeAll', 'beforeEach', 'afterEach', 'afterAll'])

// The identifier a call hangs off: `it.each(rows)('t', fn)` -> `it`, `describe.skip(...)` -> `describe`, `it.each\`t\`(...)` -> `it`.
function rootName(node: ts.Expression): string | undefined {
  let e: ts.Expression = node
  for (;;) {
    if (ts.isIdentifier(e)) return e.text
    if (ts.isPropertyAccessExpression(e)) e = e.expression
    else if (ts.isCallExpression(e)) e = e.expression
    else if (ts.isTaggedTemplateExpression(e)) e = e.tag
    else if (ts.isParenthesizedExpression(e)) e = e.expression
    else return undefined
  }
}

const isFunctionLike = (n: ts.Node) => ts.isArrowFunction(n) || ts.isFunctionExpression(n)

function titleOf(call: ts.CallExpression, sf: ts.SourceFile): string {
  const arg = call.arguments[0]
  if (!arg) return ''
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text
  return arg.getText(sf)
}

// Every name a node mentions, leaving out property names (`a.b` mentions `a`, not `b`).
function mentions(node: ts.Node, into: Set<string>) {
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n)) into.add(n.text)
    if (ts.isPropertyAccessExpression(n)) {
      visit(n.expression)
      return
    }
    if (ts.isPropertyAssignment(n) && !ts.isComputedPropertyName(n.name)) {
      visit(n.initializer)
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
}

function declaredNames(stmt: ts.Statement): string[] {
  if (ts.isVariableStatement(stmt)) {
    const names: string[] = []
    const bind = (b: ts.BindingName) => {
      if (ts.isIdentifier(b)) names.push(b.text)
      else for (const el of b.elements) if (ts.isBindingElement(el)) bind(el.name)
    }
    for (const d of stmt.declarationList.declarations) bind(d.name)
    return names
  }
  if (
    (ts.isFunctionDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt)) &&
    stmt.name
  )
    return [stmt.name.text]
  return []
}

const hash = (state: CaseState) => createHash('sha256').update(JSON.stringify(state)).digest('hex')
const size = (state: CaseState) => JSON.stringify(state).length

// Cut to the cap in the spec's order: hooks, then imports, then referenced declarations, then the tail of the case.
function cut(state: CaseState, cap: number): { state: CaseState; truncated: boolean } {
  if (size(state) <= cap) return { state, truncated: false }
  const s: CaseState = {
    ...state,
    hooks: [...state.hooks],
    imports: [...state.imports],
    declarations: [...state.declarations],
  }
  for (const part of ['hooks', 'imports', 'declarations'] as const) {
    while (s[part].length > 0 && size(s) > cap) s[part].pop()
    if (size(s) <= cap) return { state: s, truncated: true }
  }
  let lo = 0
  let hi = s.case.length
  const full = s.case
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (size({ ...s, case: full.slice(0, mid) }) <= cap) lo = mid
    else hi = mid - 1
  }
  s.case = full.slice(0, lo)
  return { state: s, truncated: true }
}

export function sliceSource(file: string, text: string, opts: { maxChars?: number } = {}): SliceResult {
  const cap = opts.maxChars ?? DEFAULT_MAX_STATE_CHARS
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const syntaxErrors = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? []
  if (syntaxErrors.length > 0) {
    const d = syntaxErrors[0] as ts.Diagnostic
    const { line } = sf.getLineAndCharacterOfPosition(d.start ?? 0)
    return {
      status: 'unparsed',
      cases: [],
      reason: `line ${line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`,
    }
  }

  const imports = sf.statements.filter(ts.isImportDeclaration).map((s) => s.getText(sf))
  // Top-level declarations by name, for the same-file references (never other files).
  const declByName = new Map<string, ts.Statement>()
  for (const stmt of sf.statements) for (const name of declaredNames(stmt)) declByName.set(name, stmt)

  type Raw = { call: ts.CallExpression; describes: string[]; hooks: ts.CallExpression[]; title: string }
  const raws: Raw[] = []
  const walk = (node: ts.Node, describes: string[], hooks: ts.CallExpression[]) => {
    if (ts.isCallExpression(node)) {
      const root = rootName(node.expression)
      const fnArg = node.arguments.find(isFunctionLike)
      if (root && CASE_ROOTS.has(root) && fnArg) {
        raws.push({ call: node, describes, hooks, title: titleOf(node, sf) })
        return
      }
      if (root && DESCRIBE_ROOTS.has(root) && fnArg && (ts.isFunctionExpression(fnArg) || ts.isArrowFunction(fnArg))) {
        const inner = ts.isBlock(fnArg.body) ? fnArg.body.statements : []
        const own: ts.CallExpression[] = []
        for (const st of inner)
          if (ts.isExpressionStatement(st) && ts.isCallExpression(st.expression)) {
            const r = rootName(st.expression.expression)
            if (r && HOOK_ROOTS.has(r)) own.push(st.expression)
          }
        const next = [...describes, titleOf(node, sf)]
        walk(fnArg.body, next, [...hooks, ...own])
        return
      }
    }
    ts.forEachChild(node, (c) => walk(c, describes, hooks))
  }
  // Hooks at the top of the file apply to every case in it.
  const topHooks: ts.CallExpression[] = []
  for (const st of sf.statements)
    if (ts.isExpressionStatement(st) && ts.isCallExpression(st.expression)) {
      const r = rootName(st.expression.expression)
      if (r && HOOK_ROOTS.has(r)) topHooks.push(st.expression)
    }
  walk(sf, [], topHooks)

  if (raws.length === 0) return { status: 'empty', cases: [] }

  const baseIds = raws.map((r) => [file, ...r.describes, r.title].join(' > '))
  const totals = new Map<string, number>()
  for (const id of baseIds) totals.set(id, (totals.get(id) ?? 0) + 1)
  const seen = new Map<string, number>()

  const cases = raws.map((r, i): Case => {
    const base = baseIds[i] as string
    let id = base
    if ((totals.get(base) ?? 0) > 1) {
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      id = `${base}#${n}`
    }
    const caseSource = r.call.getText(sf)
    const hookSources = r.hooks.map((h) => h.getText(sf))

    // The declarations the case and its hooks use, followed through the file: a helper brings the constant it uses.
    const included = new Set<string>()
    const queue: ts.Node[] = [r.call, ...r.hooks]
    while (queue.length > 0) {
      const names = new Set<string>()
      mentions(queue.pop() as ts.Node, names)
      for (const name of names) {
        const stmt = declByName.get(name)
        if (stmt && !included.has(name)) {
          for (const n of declaredNames(stmt)) included.add(n)
          queue.push(stmt)
        }
      }
    }
    const stmts = [...new Set([...included].map((n) => declByName.get(n) as ts.Statement))].sort(
      (a, b) => a.pos - b.pos,
    )
    const state: CaseState = {
      path: file,
      describes: r.describes,
      imports,
      hooks: hookSources,
      declarations: stmts.map((s) => s.getText(sf)),
      case: caseSource,
    }
    const { state: sent, truncated } = cut(state, cap)
    return {
      id,
      file,
      line: sf.getLineAndCharacterOfPosition(r.call.getStart(sf)).line + 1,
      title: r.title,
      describes: r.describes,
      state: sent,
      stateHash: hash(sent),
      truncated,
    }
  })
  return { status: 'ok', cases }
}

// Tracked test files only (`git ls-files`), so build output and untracked scratch files are never scanned.
export function listTestFiles(root: string): string[] {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', '*.test.ts', '*.test.tsx', '*.suite.ts'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out.split('\0').filter(Boolean).sort()
}

export function sliceFiles(root: string, files: string[], opts: { maxChars?: number } = {}): SliceFilesResult {
  const result: SliceFilesResult = { cases: [], unparsed: [], empty: [], files: files.length }
  for (const file of files) {
    let r: SliceResult
    try {
      r = sliceSource(file, readFileSync(join(root, file), 'utf8'), opts)
    } catch (e) {
      r = { status: 'unparsed', cases: [], reason: e instanceof Error ? e.message : String(e) }
    }
    if (r.status === 'unparsed') result.unparsed.push({ file, reason: r.reason ?? 'unparsed' })
    else if (r.status === 'empty') result.empty.push(file)
    else result.cases.push(...r.cases)
  }
  return result
}

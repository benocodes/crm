// The SDK steps of `release:check` ([[OPS709]] D7): the `@vibase/sdk` tarball is extracted, scanned and laid out, installed alone into its own empty directory outside the repo,
// its two `exports` entries resolved, imported and called through a stub `fetch`, and a consumer typechecked against it under two resolution modes with the SDK's own TypeScript.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sh } from './check-lib.js'
import { ReleaseRefusal } from './errors.js'
import { assertNoForbidden } from './forbidden.js'
import { assertSdkLayout } from './layout.js'

const SDK_PKG = fileURLToPath(new URL('../../sdk/', import.meta.url))

/** Everything in `node_modules` beyond `@vibase/sdk` (dot entries, npm's own, are ignored); empty means the SDK was installed alone. */
export function installedAloneProblems(modulesDir: string): string[] {
  const out: string[] = []
  const top = existsSync(modulesDir) ? readdirSync(modulesDir).filter((n) => !n.startsWith('.')) : []
  for (const n of top) {
    if (n !== '@vibase') out.push(`the install holds the package ${n}, expected only @vibase/sdk`)
    else
      for (const s of readdirSync(join(modulesDir, n)))
        if (s !== 'sdk') out.push(`the install holds the package @vibase/${s}, expected only @vibase/sdk`)
  }
  if (!existsSync(join(modulesDir, '@vibase', 'sdk'))) out.push('the install does not hold @vibase/sdk')
  return out
}

/** The two `exports` entries the installed manifest must carry. */
export function sdkExportsProblems(installedDir: string): string[] {
  const out: string[] = []
  const manifest = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8')) as {
    exports?: Record<string, unknown>
  }
  for (const entry of ['.', './package.json'])
    if (!manifest.exports || !(entry in manifest.exports))
      out.push(`the installed manifest has no exports entry ${entry}`)
  return out
}

const RUNTIME_CONSUMER = `import { createClient, isVibaseError, VibaseError } from '@vibase/sdk'
import { createRequire } from 'node:module'
const calls = []
const fetch = async (url, init) => {
  calls.push({ url: String(url), method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization') })
  return new Response(JSON.stringify({ id: 'c 1' }), { status: 200, headers: { 'content-type': 'application/json' } })
}
const out = { exports: { isVibaseError: typeof isVibaseError, VibaseError: typeof VibaseError } }
const vibase = createClient({ url: 'https://vibase.check.invalid', auth: 'check-token', fetch })
await vibase.contacts.get({ id: 'c 1' })
out.calls = calls
const req = createRequire(import.meta.url)
out.resolved = [req.resolve('@vibase/sdk'), req.resolve('@vibase/sdk/package.json')]
console.log(JSON.stringify(out))
`

const TYPES_CONSUMER = `import { createClient, isVibaseError, VibaseError } from '@vibase/sdk'

const vibase = createClient({
  url: 'https://vibase.check.invalid',
  auth: 'check-token',
  fetch: async () => new Response('{}'),
})
export const contact = vibase.contacts.get({ id: 'c1' })
export const listed = vibase.contacts.list({ limit: 5 })
export const guard: boolean = isVibaseError(new VibaseError(400, 'validation_error', 'x'))
// @ts-expect-error an unknown method is not a method of the client
vibase.contacts.noSuchMethod({})
// @ts-expect-error the id of a contact is a string
vibase.contacts.get({ id: 5 })
`

interface SdkTypeScript {
  version: string
  ScriptTarget: { ES2022: number }
  ModuleKind: Record<string, number>
  ModuleResolutionKind: Record<string, number>
  createProgram(o: { rootNames: string[]; options: Record<string, unknown> }): {
    getSourceFiles(): readonly { fileName: string }[]
  }
  getPreEmitDiagnostics(program: unknown): readonly unknown[]
  flattenDiagnosticMessageText(m: unknown, nl: string): string
}

const MODES = [
  { name: 'NodeNext/NodeNext', module: 'NodeNext', resolution: 'NodeNext' },
  { name: 'ESNext/Bundler', module: 'ESNext', resolution: 'Bundler' },
] as const

/** Typecheck `consumer.mts` in `dir` under both modes with the SDK's own TypeScript; per mode the problems and the file TypeScript read for the installed `dist/index.d.ts`. */
function typecheckConsumer(dir: string) {
  const ts = createRequire(join(SDK_PKG, 'package.json'))('typescript') as SdkTypeScript
  const expected = realpathSync(join(dir, 'node_modules', '@vibase', 'sdk', 'dist', 'index.d.ts'))
  const modes = MODES.map((m) => {
    const program = ts.createProgram({
      rootNames: [join(dir, 'consumer.mts')],
      options: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind[m.module],
        moduleResolution: ts.ModuleResolutionKind[m.resolution],
        lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
        types: [],
        strict: true,
        skipLibCheck: false,
        noEmit: true,
      },
    })
    const problems = ts.getPreEmitDiagnostics(program).map((d) => {
      const x = d as { code: number; messageText: unknown; file?: { fileName: string } }
      return `TS${x.code}: ${ts.flattenDiagnosticMessageText(x.messageText, ' ')}${x.file ? ` (${x.file.fileName.replace(dir, '<consumer>')})` : ''}`
    })
    const read = program.getSourceFiles().find((f) => {
      try {
        return realpathSync(f.fileName) === expected
      } catch {
        return false
      }
    })
    return { name: m.name, problems, read: read?.fileName }
  })
  return { version: ts.version, modes }
}

export function checkSdkTarball(o: {
  tarball: string
  root: string
  version: string
  databaseIds: string[]
  log: (line: string) => void
}): void {
  const { root, version, log } = o
  const mkdir = (name: string) => {
    const d = join(root, name)
    mkdirSync(d)
    return d
  }
  // 1. extract, refuse forbidden content, the exact file list and fields.
  const extract = mkdir('extract-sdk')
  sh('tar', ['-xzf', o.tarball, '-C', extract], root)
  const pkgDir = join(extract, 'package')
  assertNoForbidden(pkgDir, { databaseIds: o.databaseIds })
  assertSdkLayout(pkgDir, version)
  log(
    `sdk tarball ok: @vibase/sdk ${version}, ${readdirSync(pkgDir).length} top-level entries, no dependencies, no node: or @vibase/ imports`,
  )

  // 2. installed alone in its own empty directory outside the repo.
  const dir = mkdir('install-sdk')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'vibase-check-sdk', private: true }))
  sh('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund', '--no-progress', o.tarball], dir)
  const modules = join(dir, 'node_modules')
  const alone = installedAloneProblems(modules)
  if (alone.length > 0) throw new ReleaseRefusal(`the SDK install is not alone: ${alone.join('; ')}`)
  const installed = join(modules, '@vibase', 'sdk')
  assertNoForbidden(installed, { databaseIds: o.databaseIds })
  assertSdkLayout(installed, version)
  log('sdk installed alone (node_modules: @vibase/sdk only)')

  // 3. both exports entries, in the manifest and resolved by Node from the consumer directory (4).
  const exportProblems = sdkExportsProblems(installed)
  if (exportProblems.length > 0) throw new ReleaseRefusal(exportProblems.join('; '))

  // 4. runtime: import with Node, one call through a stub fetch.
  writeFileSync(join(dir, 'consumer.mjs'), RUNTIME_CONSUMER)
  let ran: {
    exports: Record<string, string>
    calls: { url: string; method: string; authorization: string | null }[]
    resolved: string[]
  }
  try {
    ran = JSON.parse(sh('node', ['consumer.mjs'], dir).trim().split('\n').at(-1)!)
  } catch (e) {
    throw new ReleaseRefusal(
      `the installed @vibase/sdk did not import and run from a consumer: ${e instanceof Error ? e.message.split('\n').slice(0, 3).join(' ') : String(e)}`,
    )
  }
  for (const n of ['isVibaseError', 'VibaseError'])
    if (ran.exports[n] !== 'function') throw new ReleaseRefusal(`the installed @vibase/sdk does not export ${n}`)
  const call = ran.calls[0]
  const wantUrl = 'https://vibase.check.invalid/api/v1/contacts/c%201'
  if (ran.calls.length !== 1 || call!.url !== wantUrl || call!.method !== 'GET')
    throw new ReleaseRefusal(
      `the stubbed call's URL or method was wrong: got ${JSON.stringify(ran.calls)}, expected one GET ${wantUrl}`,
    )
  if (call!.authorization !== 'Bearer check-token')
    throw new ReleaseRefusal(
      `the stubbed call's authorization header was ${JSON.stringify(call!.authorization)}, expected "Bearer check-token"`,
    )
  log(`sdk exports resolve: ., ./package.json (${ran.resolved.map((r) => r.replace(dir, '<consumer>')).join(', ')})`)
  log(
    'sdk runtime: contacts.get through a stub fetch sent GET /api/v1/contacts/c%201 with the authorization header; VibaseError and isVibaseError exported',
  )

  // 5. types: the SDK's own TypeScript, two modes, skipLibCheck false.
  writeFileSync(join(dir, 'consumer.mts'), TYPES_CONSUMER)
  const { version: tsVersion, modes } = typecheckConsumer(dir)
  const failed = modes.filter((m) => m.problems.length > 0)
  if (failed.length > 0)
    throw new ReleaseRefusal(
      `the SDK's declarations do not typecheck for a consumer (TypeScript ${tsVersion}): ${failed.map((m) => `${m.name}: ${m.problems.slice(0, 5).join(' | ')}`).join('; ')}`,
    )
  for (const m of modes)
    if (!m.read)
      throw new ReleaseRefusal(
        `under ${m.name} TypeScript did not read the installed node_modules/@vibase/sdk/dist/index.d.ts`,
      )
  log(
    `sdk types: TypeScript ${tsVersion}, ${modes.map((m) => `${m.name} ok (read ${m.read!.replace(dir, '<consumer>')})`).join(', ')}`,
  )
}

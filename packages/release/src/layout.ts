// The exact shape of the three published packages ([[OPS210]], [[OPS693]] D3, D8 items (2), (4), (5), (9)), as functions over a package directory. `release:build` and
// `release:check` call them on the staged, the extracted and the installed package; every guard returns what is wrong, and the assert form throws it named.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, sep } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import { ReleaseRefusal } from './errors.js'
import { listFiles, type ReleaseManifest } from './manifest.js'
import { SERVER_EXPORTS, sdkPackageJson } from './stage.js'

/** Strings only the instance program carries: the bootstrap program's own marker, wrangler's platform proxy, the base config the program reads. The client must hold none ([[OPS210]] D8 (5)). */
export const CLIENT_MARKERS: readonly string[] = ['ops.init_deployment', 'getPlatformProxy', 'wrangler.base.jsonc']
const CLIENT_FILES = ['LICENSE', 'README.md', 'cli/vibase.js', 'package.json']
const SERVER_FIXED = [
  'LICENSE',
  'README.md',
  'cli/server.js',
  'package.json',
  'release.json',
  'worker/worker.js',
  'worker/vibase.schema.schema.json',
  'wrangler.base.jsonc',
]
/** [[UI246]] D2, [[UI504]] D3: the auth pages the Worker serves from `assets/assets/ui/` (the binding directory is `assets/`, the files sit at their URL path `/assets/ui/…` inside it); a package without one would answer its pages with a 404, so each is required. */
export const SERVER_UI_ASSETS = ['assets/assets/ui/index.html', 'assets/assets/ui/app.js', 'assets/assets/ui/ui.css']

/** [[UI460]] D6, [[UI504]] D3: the workspace app the Worker serves from `assets/assets/app/`; a package without one would answer `/app/home` with a 404, so each is required. */
export const SERVER_APP_ASSETS = [
  'assets/assets/app/index.html',
  'assets/assets/app/app.js',
  'assets/assets/app/app.css',
]

const readJson = (file: string): Record<string, any> | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>
  } catch {
    return null
  }
}
const fileDiff = (found: string[], allowed: (f: string) => boolean, required: readonly string[]): string[] => [
  ...found.filter((f) => !allowed(f)).map((f) => `${f} is not in the package's list (extra)`),
  ...required.filter((f) => !found.includes(f)).map((f) => `${f} is missing`),
]

/** What is wrong with a `@vibase/cli` directory ([[OPS210]] D3, D8 (2), (4), (5)); empty means it is exactly the client. */
export function clientProblems(dir: string, version: string): string[] {
  const out = fileDiff(listFiles(dir), (f) => CLIENT_FILES.includes(f), CLIENT_FILES)
  const pkg = readJson(join(dir, 'package.json'))
  if (pkg) {
    if (pkg.name !== '@vibase/cli') out.push(`package.json name is ${JSON.stringify(pkg.name)}, expected @vibase/cli`)
    if (pkg.version !== version) out.push(`package.json version is ${JSON.stringify(pkg.version)}, expected ${version}`)
    if (JSON.stringify(pkg.bin) !== JSON.stringify({ vibase: 'cli/vibase.js' }))
      out.push(`package.json bin is ${JSON.stringify(pkg.bin)}, expected { vibase: cli/vibase.js }`)
    if (pkg.engines?.node !== '>=22') out.push('package.json engines.node must be >=22')
    if (pkg.publishConfig?.access !== 'public') out.push('package.json publishConfig.access must be public')
    for (const k of [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
      'bundledDependencies',
      'bundleDependencies',
    ]) {
      const v = pkg[k]
      if (v !== undefined && !(typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0))
        out.push(`package.json ${k} must be absent or empty: the client brings nothing along`)
    }
  } else out.push('package.json is missing or unreadable')
  const js = join(dir, 'cli', 'vibase.js')
  if (existsSync(js)) {
    const text = readFileSync(js, 'utf8')
    for (const m of CLIENT_MARKERS) if (text.includes(m)) out.push(`cli/vibase.js carries instance code (${m})`)
  }
  return out
}

/** What is wrong with a `@vibase/server-d1` directory ([[OPS210]] D3, D8 (2), (3), (4), (9)); empty means it is exactly the server. */
export function serverProblems(dir: string, version: string): string[] {
  const manifest = readJson(join(dir, 'release.json')) as ReleaseManifest | null
  const migrations = new Set([
    ...(manifest?.migrations ?? []).map((m) => `migrations/${m.name}`),
    ...(manifest?.control_migrations ?? []).map((m) => `control-migrations/${m.name}`),
  ])
  const out = fileDiff(
    listFiles(dir),
    (f) =>
      SERVER_FIXED.includes(f) ||
      f.startsWith('assets/assets/ui/') ||
      f.startsWith('assets/assets/app/') ||
      migrations.has(f),
    [...SERVER_FIXED, ...SERVER_UI_ASSETS, ...SERVER_APP_ASSETS],
  )
  // [[CORE543]] P7: a deploy stages the schema file as a Text module `vibase.schema.json` beside the Worker, so the built Worker must import exactly that name (a hashed name is wrangler's default for a bundled build).
  const worker = existsSync(join(dir, 'worker', 'worker.js'))
    ? readFileSync(join(dir, 'worker', 'worker.js'), 'utf8')
    : null
  if (worker !== null && !/(?:from|import)\s*["']\.\/vibase\.schema\.json["']/.test(worker))
    out.push(
      'worker/worker.js does not import "./vibase.schema.json" by that exact name (the deploy stages the schema file under it)',
    )
  const pkg = readJson(join(dir, 'package.json'))
  if (!manifest) out.push('release.json is missing or unreadable')
  else {
    if (manifest.name !== '@vibase/server-d1')
      out.push(`release.json name is ${JSON.stringify(manifest.name)}, expected @vibase/server-d1`)
    if (manifest.version !== version)
      out.push(`release.json version is ${JSON.stringify(manifest.version)}, expected ${version}`)
  }
  if (pkg) {
    if (pkg.name !== '@vibase/server-d1')
      out.push(`package.json name is ${JSON.stringify(pkg.name)}, expected @vibase/server-d1`)
    if (pkg.version !== version) out.push(`package.json version is ${JSON.stringify(pkg.version)}, expected ${version}`)
    if (JSON.stringify(pkg.bin) !== JSON.stringify({ 'vibase-server': 'cli/server.js' }))
      out.push(`package.json bin is ${JSON.stringify(pkg.bin)}, expected { vibase-server: cli/server.js }`)
    if (pkg.engines?.node !== '>=22') out.push('package.json engines.node must be >=22')
    if (pkg.publishConfig?.access !== 'public') out.push('package.json publishConfig.access must be public')
    const deps = pkg.dependencies as Record<string, string> | undefined
    const wrangler = manifest?.wrangler
    if (
      !deps ||
      Object.keys(deps).join() !== 'wrangler' ||
      !/^\d+\.\d+\.\d+$/.test(deps.wrangler ?? '') ||
      (wrangler !== undefined && deps.wrangler !== wrangler)
    ) {
      out.push(
        `package.json dependencies must be exactly one exact wrangler equal to release.json's (${wrangler ?? 'unknown'}), found ${JSON.stringify(deps)}`,
      )
    }
    const exp = pkg.exports as Record<string, string> | undefined
    for (const [k, v] of Object.entries(SERVER_EXPORTS))
      if (exp?.[k] !== v) out.push(`package.json exports ${k} must be ${v}, found ${JSON.stringify(exp?.[k])}`)
    for (const k of Object.keys(exp ?? {}))
      if (!(k in SERVER_EXPORTS)) out.push(`package.json exports has an unlisted entry ${k}`)
    // Each entry names something shipped: a file for a plain path, an existing directory's files for a pattern.
    const files = listFiles(dir)
    for (const [k, v] of Object.entries(exp ?? {})) {
      const target = v.replace(/^\.\//, '')
      const ok = target.endsWith('/*') ? files.some((f) => f.startsWith(target.slice(0, -1))) : files.includes(target)
      if (!ok) out.push(`package.json exports ${k} names ${v}, which the package does not ship`)
    }
  } else out.push('package.json is missing or unreadable')
  // [[CORE243]] D2: the Worker bundle imports `node:*`, so the base config every deploy is generated from must carry `nodejs_compat`. A deploy without it fails only remotely.
  try {
    const base = parseJsonc(readFileSync(join(dir, 'wrangler.base.jsonc'), 'utf8')) as
      | { compatibility_flags?: unknown }
      | undefined
    const flags = Array.isArray(base?.compatibility_flags) ? base.compatibility_flags : []
    if (!flags.includes('nodejs_compat'))
      out.push(
        'wrangler.base.jsonc compatibility_flags must include nodejs_compat (the Worker bundle imports node: modules)',
      )
  } catch {
    /* a missing base config is already reported by the file list */
  }
  return out
}

const refuse = (what: string, problems: string[]): void => {
  if (problems.length > 0) throw new ReleaseRefusal(`${what}: ${problems.join('; ')}`)
}
export const assertClientLayout = (dir: string, version: string): void =>
  refuse('the client package (@vibase/cli) is not as D3 lists it', clientProblems(dir, version))
export const assertServerLayout = (dir: string, version: string): void =>
  refuse('the server package (@vibase/server-d1) is not as D3 lists it', serverProblems(dir, version))

/** The commit a release names is a full sha, with `-dirty` only for an `--allow-dirty` build ([[OPS210]] D4). */
export function assertCommit(commit: string): void {
  if (!/^[0-9a-f]{40}(-dirty)?$/.test(commit))
    throw new ReleaseRefusal(`release.json commit ${JSON.stringify(commit)} is not a full sha`)
}

/** D23 (a): every `exports` entry of the installed `@vibase/server-d1` under `<consumerRoot>/node_modules`, resolved by Node from the consumer's own directory; a pattern through one real file. */
export function assertExportsResolve(consumerRoot: string): { entry: string; resolved: string }[] {
  const installed = join(consumerRoot, 'node_modules', '@vibase', 'server-d1')
  const realInstalled = existsSync(installed) ? realpathSync(installed) : installed
  const files = listFiles(installed)
  const pkg = readJson(join(installed, 'package.json')) as { exports: Record<string, string> } | null
  if (!pkg) throw new ReleaseRefusal(`no installed @vibase/server-d1 package.json under ${consumerRoot}`)
  const req = createRequire(join(consumerRoot, 'consumer.js'))
  const out: { entry: string; resolved: string }[] = []
  for (const [entry, target] of Object.entries(pkg.exports)) {
    let specifier = `@vibase/server-d1/${entry.slice(2)}`
    if (entry.endsWith('/*')) {
      // The shipped file the pattern's target directory holds: a sample the consumer would ask for.
      const prefix = target.replace(/^\.\//, '').slice(0, -1)
      const sample = files.find((f) => f.startsWith(prefix))
      if (!sample) throw new ReleaseRefusal(`exports ${entry} matches no shipped file (${target})`)
      specifier = `@vibase/server-d1/${entry.slice(2, -1)}${sample.slice(prefix.length)}`
    }
    let resolved: string
    try {
      resolved = req.resolve(specifier)
    } catch (e) {
      throw new ReleaseRefusal(
        `exports ${entry} does not resolve from a consumer (${specifier}): ${e instanceof Error ? e.message.split('\n')[0] : 'failed'}`,
      )
    }
    if (!existsSync(resolved) || !realpathSync(resolved).startsWith(realInstalled + sep))
      throw new ReleaseRefusal(`exports ${entry} resolved to ${resolved}, which is not a shipped file`)
    out.push({ entry, resolved })
  }
  return out
}

const SDK_ROOT_FILES = ['LICENSE', 'README.md', 'package.json']
const SDK_DEP_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundledDependencies',
  'bundleDependencies',
]
/** A `from '…'`, a dynamic `import('…')` or a bare `import '…'` that names a Node builtin or a workspace package: the SDK is fetch-only and brings nothing along ([[OPS693]] D3). */
const SDK_FORBIDDEN_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])(node:[^'"]*|@vibase\/[^'"]*)\1/g

/** What is wrong with a `@vibase/sdk` directory ([[OPS693]] D2, D3); empty means it is exactly the SDK. */
export function sdkProblems(dir: string, version: string): string[] {
  const found = listFiles(dir)
  const isDist = (f: string) => f.startsWith('dist/') && (f.endsWith('.js') || f.endsWith('.d.ts'))
  const out = fileDiff(found, (f) => SDK_ROOT_FILES.includes(f) || isDist(f), [
    ...SDK_ROOT_FILES,
    'dist/index.js',
    'dist/index.d.ts',
  ])
  const stem = (f: string) => f.replace(/\.d\.ts$|\.js$/, '')
  const dist = found.filter(isDist)
  for (const f of dist) {
    const partner = f.endsWith('.d.ts') ? `${stem(f)}.js` : `${stem(f)}.d.ts`
    if (!found.includes(partner)) out.push(`${f} is an orphan: ${partner} is missing`)
    if (/^dist\/generate\//.test(f)) out.push(`${f} is the generator (generate/), which is not shipped`)
    if (/(^|\/)testing\./.test(f)) out.push(`${f} is the test helper (testing), which is not shipped`)
    const text = readFileSync(join(dir, f), 'utf8')
    for (const m of text.matchAll(SDK_FORBIDDEN_SPECIFIER))
      out.push(
        `${f} imports ${m[2]}: the SDK may import neither ${m[2]!.startsWith('node:') ? 'node:' : '@vibase/'} specifiers`,
      )
  }
  if (found.includes('README.md') && readFileSync(join(dir, 'README.md'), 'utf8').includes('pnpm -C packages/'))
    out.push('README.md tells the reader to run pnpm -C packages/: a customer has no repository')
  const pkg = readJson(join(dir, 'package.json'))
  if (pkg) {
    const want = sdkPackageJson(version)
    for (const k of new Set([...Object.keys(want), ...Object.keys(pkg)])) {
      if (SDK_DEP_FIELDS.includes(k)) {
        const v = pkg[k]
        const empty = Array.isArray(v)
          ? v.length === 0
          : typeof v === 'object' && v !== null && Object.keys(v).length === 0
        if (v !== undefined && !empty)
          out.push(`package.json ${k} must be absent or empty: the SDK brings nothing along`)
      } else if (JSON.stringify(pkg[k]) !== JSON.stringify(want[k]))
        out.push(
          `package.json ${k} is ${JSON.stringify(pkg[k])}, expected ${want[k] === undefined ? 'it absent' : JSON.stringify(want[k])}`,
        )
    }
  }
  return out
}
export const assertSdkLayout = (dir: string, version: string): void =>
  refuse('the SDK package (@vibase/sdk) is not as D2 and D3 list it', sdkProblems(dir, version))

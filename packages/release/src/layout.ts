// The exact shape of the two published packages ([[OPS210]] D3, D8 items (2), (4), (5), (9)), as functions over a package directory. `release:build` and
// `release:check` call them on the staged, the extracted and the installed package; every guard returns what is wrong, and the assert form throws it named.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, sep } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import { ReleaseRefusal } from './errors.js'
import { listFiles, type ReleaseManifest } from './manifest.js'
import { SERVER_EXPORTS } from './stage.js'

/** Strings only the instance program carries: the bootstrap program's own marker, wrangler's platform proxy, the base config the program reads. The client must hold none ([[OPS210]] D8 (5)). */
export const CLIENT_MARKERS: readonly string[] = ['ops.init_deployment', 'getPlatformProxy', 'wrangler.base.jsonc']
const CLIENT_FILES = ['LICENSE', 'README.md', 'cli/vibase.js', 'package.json']
const SERVER_FIXED = ['LICENSE', 'README.md', 'cli/server.js', 'package.json', 'release.json', 'worker/worker.js', 'wrangler.base.jsonc']

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
    if (JSON.stringify(pkg.bin) !== JSON.stringify({ vibase: 'cli/vibase.js' })) out.push(`package.json bin is ${JSON.stringify(pkg.bin)}, expected { vibase: cli/vibase.js }`)
    if (pkg.engines?.node !== '>=22') out.push('package.json engines.node must be >=22')
    if (pkg.publishConfig?.access !== 'public') out.push('package.json publishConfig.access must be public')
    for (const k of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies']) {
      const v = pkg[k]
      if (v !== undefined && !(typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0)) out.push(`package.json ${k} must be absent or empty: the client brings nothing along`)
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
  const migrations = new Set([...(manifest?.migrations ?? []).map((m) => `migrations/${m.name}`), ...(manifest?.control_migrations ?? []).map((m) => `control-migrations/${m.name}`)])
  const out = fileDiff(
    listFiles(dir),
    (f) => SERVER_FIXED.includes(f) || f.startsWith('assets/connect/') || migrations.has(f),
    SERVER_FIXED,
  )
  const pkg = readJson(join(dir, 'package.json'))
  if (!manifest) out.push('release.json is missing or unreadable')
  else {
    if (manifest.name !== '@vibase/server-d1') out.push(`release.json name is ${JSON.stringify(manifest.name)}, expected @vibase/server-d1`)
    if (manifest.version !== version) out.push(`release.json version is ${JSON.stringify(manifest.version)}, expected ${version}`)
  }
  if (pkg) {
    if (pkg.name !== '@vibase/server-d1') out.push(`package.json name is ${JSON.stringify(pkg.name)}, expected @vibase/server-d1`)
    if (pkg.version !== version) out.push(`package.json version is ${JSON.stringify(pkg.version)}, expected ${version}`)
    if (JSON.stringify(pkg.bin) !== JSON.stringify({ 'vibase-server': 'cli/server.js' })) out.push(`package.json bin is ${JSON.stringify(pkg.bin)}, expected { vibase-server: cli/server.js }`)
    if (pkg.engines?.node !== '>=22') out.push('package.json engines.node must be >=22')
    if (pkg.publishConfig?.access !== 'public') out.push('package.json publishConfig.access must be public')
    const deps = pkg.dependencies as Record<string, string> | undefined
    const wrangler = manifest?.wrangler
    if (!deps || Object.keys(deps).join() !== 'wrangler' || !/^\d+\.\d+\.\d+$/.test(deps.wrangler ?? '') || (wrangler !== undefined && deps.wrangler !== wrangler)) {
      out.push(`package.json dependencies must be exactly one exact wrangler equal to release.json's (${wrangler ?? 'unknown'}), found ${JSON.stringify(deps)}`)
    }
    const exp = pkg.exports as Record<string, string> | undefined
    for (const [k, v] of Object.entries(SERVER_EXPORTS)) if (exp?.[k] !== v) out.push(`package.json exports ${k} must be ${v}, found ${JSON.stringify(exp?.[k])}`)
    for (const k of Object.keys(exp ?? {})) if (!(k in SERVER_EXPORTS)) out.push(`package.json exports has an unlisted entry ${k}`)
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
    const base = parseJsonc(readFileSync(join(dir, 'wrangler.base.jsonc'), 'utf8')) as { compatibility_flags?: unknown } | undefined
    const flags = Array.isArray(base?.compatibility_flags) ? base.compatibility_flags : []
    if (!flags.includes('nodejs_compat')) out.push('wrangler.base.jsonc compatibility_flags must include nodejs_compat (the Worker bundle imports node: modules)')
  } catch {
    /* a missing base config is already reported by the file list */
  }
  return out
}

const refuse = (what: string, problems: string[]): void => {
  if (problems.length > 0) throw new ReleaseRefusal(`${what}: ${problems.join('; ')}`)
}
export const assertClientLayout = (dir: string, version: string): void => refuse('the client package (@vibase/cli) is not as D3 lists it', clientProblems(dir, version))
export const assertServerLayout = (dir: string, version: string): void => refuse('the server package (@vibase/server-d1) is not as D3 lists it', serverProblems(dir, version))

/** The commit a release names is a full sha, with `-dirty` only for an `--allow-dirty` build ([[OPS210]] D4). */
export function assertCommit(commit: string): void {
  if (!/^[0-9a-f]{40}(-dirty)?$/.test(commit)) throw new ReleaseRefusal(`release.json commit ${JSON.stringify(commit)} is not a full sha`)
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
      throw new ReleaseRefusal(`exports ${entry} does not resolve from a consumer (${specifier}): ${e instanceof Error ? e.message.split('\n')[0] : 'failed'}`)
    }
    if (!existsSync(resolved) || !realpathSync(resolved).startsWith(realInstalled + sep)) throw new ReleaseRefusal(`exports ${entry} resolved to ${resolved}, which is not a shipped file`)
    out.push({ entry, resolved })
  }
  return out
}

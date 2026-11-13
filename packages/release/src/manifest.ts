// The release manifest `release.json` ([[OPS210]] D4): its build and the verification every consumer runs before trusting a package directory.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ReleaseRefusal } from './errors.js'

export interface ReleaseManifest {
  name: string
  version: string
  commit: string
  built_at: string
  wrangler: string
  compatibility_date: string
  node: string
  migrations: { name: string; sha256: string }[]
  files: Record<string, string>
}
export interface Problem {
  path: string
  kind: 'mismatch' | 'missing' | 'extra'
}
export interface ManifestInput {
  dir: string
  version: string
  commit: string
  builtAt: string
  wrangler: string
  compatibilityDate: string
  node: string
  migrations: readonly { name: string; sha256: string }[]
}

/** The two files `files` does not cover: the manifest cannot hash itself, and `package.json` is what npm rewrites ([[OPS210]] D4). */
const UNHASHED = new Set(['release.json', 'package.json'])

export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')

/** Every file under `dir`, as sorted posix paths relative to it. */
export function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) walk(r)
      else out.push(r)
    }
  }
  walk('')
  return out.sort()
}

export function buildReleaseManifest(i: ManifestInput): ReleaseManifest {
  const files: Record<string, string> = {}
  for (const f of listFiles(i.dir)) if (!UNHASHED.has(f)) files[f] = sha256(readFileSync(join(i.dir, f)))
  return {
    name: 'vibase',
    version: i.version,
    commit: i.commit,
    built_at: i.builtAt,
    wrangler: i.wrangler,
    compatibility_date: i.compatibilityDate,
    node: i.node,
    migrations: i.migrations.map((m) => ({ name: m.name, sha256: m.sha256 })),
    files,
  }
}

/** Every disagreement between `release.json` and the files in `dir`; empty means the directory is the release. */
export function verifyRelease(dir: string): Problem[] {
  const manifestPath = join(dir, 'release.json')
  if (!existsSync(manifestPath)) return [{ path: 'release.json', kind: 'missing' }]
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReleaseManifest
  const problems: Problem[] = []
  const present = new Set(listFiles(dir))
  for (const [path, hash] of Object.entries(manifest.files)) {
    if (!present.has(path)) problems.push({ path, kind: 'missing' })
    else if (sha256(readFileSync(join(dir, path))) !== hash) problems.push({ path, kind: 'mismatch' })
  }
  for (const path of present) if (!UNHASHED.has(path) && !(path in manifest.files)) problems.push({ path, kind: 'extra' })
  // The migration list the compatibility gate compares must agree with the files it names.
  for (const m of manifest.migrations) {
    const p = `migrations/${m.name}`
    if (p in manifest.files && manifest.files[p] !== m.sha256) problems.push({ path: p, kind: 'mismatch' })
    else if (!(p in manifest.files) && !problems.some((x) => x.path === p)) problems.push({ path: p, kind: 'missing' })
  }
  const listed = new Set(manifest.migrations.map((m) => `migrations/${m.name}`))
  for (const p of Object.keys(manifest.files)) if (p.startsWith('migrations/') && !listed.has(p)) problems.push({ path: p, kind: 'extra' })
  const seen = new Set<string>()
  return problems.filter((p) => !seen.has(`${p.kind}:${p.path}`) && seen.add(`${p.kind}:${p.path}`))
}

export function assertRelease(dir: string): void {
  const problems = verifyRelease(dir)
  if (problems.length === 0) return
  throw new ReleaseRefusal(`release.json does not match ${dir}: ${problems.map((p) => `${p.path} (${p.kind})`).join(', ')}`)
}

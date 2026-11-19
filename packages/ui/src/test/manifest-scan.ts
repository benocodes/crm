// [[UI447]] D5: the manifest guard's scan. No workspace `package.json` may declare Preact in any dependency field.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

export const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const
/** `preact`, any `@preact/*` package and `@testing-library/preact`. */
export const isPreactName = (name: string) =>
  name === 'preact' || name.startsWith('@preact/') || name === '@testing-library/preact'

export type ManifestProblem = { file: string; field: string; name: string }

/** Problems in one manifest object; `file` labels it. */
export function preactDeclarations(file: string, manifest: Record<string, unknown>): ManifestProblem[] {
  const out: ManifestProblem[] = []
  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest[field]
    if (deps && typeof deps === 'object')
      for (const name of Object.keys(deps)) if (isPreactName(name)) out.push({ file, field, name })
  }
  return out
}

/** Every workspace manifest of a repo root: its own `package.json` and each `packages/*`'s. */
export function workspaceManifests(root: string): string[] {
  const dirs = readdirSync(join(root, 'packages'), { withFileTypes: true }).filter((d) => d.isDirectory())
  return [join(root, 'package.json'), ...dirs.map((d) => join(root, 'packages', d.name, 'package.json'))].filter((f) => {
    try {
      readFileSync(f)
      return true
    } catch {
      return false
    }
  })
}

export function checkManifests(root: string): ManifestProblem[] {
  return workspaceManifests(root).flatMap((f) =>
    preactDeclarations(relative(root, f), JSON.parse(readFileSync(f, 'utf-8'))),
  )
}

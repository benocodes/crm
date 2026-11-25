import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// [[CORE569]] D10: the file that declares custom objects and extension fields is the schema file. The old name,
// "extensions", is banned (any case, inside identifiers too) from tracked files under packages/, .agents/, .changeset/
// and AGENTS.md, so the concept cannot creep back. Lockfiles, generated CHANGELOG.md files and knowledge/ are out of scope.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** The lines that mean something else, each with its reason. A line is allowed when it contains the entry's text. */
export const ALLOWED: readonly { file: string; includes: string; reason: string }[] = [
  {
    file: 'packages/storage/src/test-config.test.ts',
    includes: '`.ts` extensions',
    reason: 'TypeScript import specifiers with file extensions',
  },
  {
    file: 'packages/ui/tsconfig.json',
    includes: 'allowImportingTsExtensions',
    reason: 'a TypeScript compiler option',
  },
  {
    file: 'packages/db/migrations/20261017_001_baseline.ts',
    includes: 'Extensions and the `app` schema',
    reason: 'Postgres extensions in the parked baseline migration',
  },
  {
    file: '.agents/skills/db-schema-and-migrations/SKILL.md',
    includes: 'Extensions available: `pgcrypto`',
    reason: 'Postgres extensions in the parked Postgres notes',
  },
  {
    file: '.agents/skills/tdd-cycle-generator/SKILL.md',
    includes: '020-CORE543-redeploy-extensions/RETRO.md',
    reason: 'the stable folder path of CORE543 (spec folder slugs never change, CORE569 D12)',
  },
]

/** This file names the word it bans, so it is the one file the scan skips. */
const SELF = 'packages/storage/src/schema-file-name.test.ts'

const IN_SCOPE = (p: string) =>
  p !== SELF &&
  (p.startsWith('packages/') || p.startsWith('.agents/') || p.startsWith('.changeset/') || p === 'AGENTS.md') &&
  !p.endsWith('CHANGELOG.md') &&
  !/(^|\/)(pnpm-lock\.yaml|package-lock\.json)$/.test(p)

/** Offending `path:line: text` entries among `files` (path to text) after the allow-list. */
export function findOldName(files: Record<string, string>, allowed = ALLOWED): string[] {
  const out: string[] = []
  for (const [path, text] of Object.entries(files)) {
    if (!IN_SCOPE(path)) continue
    text.split('\n').forEach((line, i) => {
      if (!/extensions/i.test(line)) return
      if (allowed.some((a) => a.file === path && line.includes(a.includes))) return
      out.push(`${path}:${i + 1}: ${line.trim().slice(0, 120)}`)
    })
  }
  return out
}

const tracked = (): string[] =>
  execFileSync('git', ['ls-files', '-z', 'packages', '.agents', '.changeset', 'AGENTS.md'], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)

describe('the schema file keeps its name (CORE569 D10)', () => {
  it('no tracked file outside the allow-list says the old name', () => {
    const files: Record<string, string> = {}
    for (const p of tracked()) {
      if (!IN_SCOPE(p) || /\.(png|jpe?g|gif|ico|woff2?|zip|tgz|wasm)$/.test(p)) continue
      try {
        files[p] = readFileSync(`${ROOT}${p}`, 'utf8')
      } catch {
        // deleted in the working tree, not yet committed
      }
    }
    expect(findOldName(files)).toEqual([])
  })

  it.each([
    ['a usage string', 'packages/server-d1/scripts/instance/main.ts', 'redeploy [--extensions <path>]'],
    ['an identifier in a source file', 'packages/server-d1/src/x.ts', 'const EXTENSIONS_MODULE = 1'],
    ['a skill', '.agents/skills/api-routes/SKILL.md', 'attach the Extensions file'],
    ['a changeset', '.changeset/a.md', '`/health.extensions`'],
  ])('fails on %s', (_n, path, line) => {
    expect(findOldName({ [path]: `ok\n${line}\n` })).toHaveLength(1)
  })

  it('every allow-list entry still matches a line (no stale exceptions)', () => {
    for (const a of ALLOWED) {
      expect(readFileSync(`${ROOT}${a.file}`, 'utf8'), a.file).toContain(a.includes)
    }
  })

  it('out of scope: lockfiles, CHANGELOG.md, knowledge/', () => {
    expect(
      findOldName({
        'pnpm-lock.yaml': 'extensions',
        'packages/x/CHANGELOG.md': 'extensions',
        'knowledge/specs/a.md': 'extensions',
      }),
    ).toEqual([])
  })
})

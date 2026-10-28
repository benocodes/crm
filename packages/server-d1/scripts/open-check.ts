// The open-only check (spec CORE38 D14, CORE47 P9-P12): the open packages install, typecheck (production code) and test
// in a temporary workspace that holds no enterprise package, and the Worker bundle smoke runs there too.
//
//   pnpm -C packages/server-d1 open:check [--keep]
//
// Not covered: packages/api's own test suites. They run against Postgres (the oracle, spec D14) and import
// enterprise packages, so they cannot run in the copy.
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const OPEN_PACKAGES = ['storage', 'storage-d1', 'api', 'server-d1'] as const
export const ENTERPRISE_PACKAGES = ['db', 'storage-postgres', 'server-postgres'] as const
export const ENTERPRISE_SPECIFIERS = ['pg', '@vault/db', '@vault/storage-postgres', '@vault/server-postgres'] as const

export interface PackageJson {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  [key: string]: unknown
}

/** Every package directory is open or enterprise on purpose; a new one must be classified before the check runs. */
export function classifyPackages(dirs: readonly string[]): { open: string[]; enterprise: string[] } {
  const open: string[] = []
  const enterprise: string[] = []
  for (const dir of dirs) {
    if ((OPEN_PACKAGES as readonly string[]).includes(dir)) open.push(dir)
    else if ((ENTERPRISE_PACKAGES as readonly string[]).includes(dir)) enterprise.push(dir)
    else throw new Error(`unclassified package: ${dir}`)
  }
  return { open, enterprise }
}

const enterpriseSpecifier = (dependency: string): string | undefined =>
  ENTERPRISE_SPECIFIERS.find((spec) => dependency === spec || dependency.startsWith(`${spec}/`))

/**
 * The manifest for the copy: enterprise `devDependencies` are removed (an open package's own test suite may use them, and
 * that suite is not run in the copy). An enterprise package in any production dependency field is refused.
 */
export function openManifest(manifest: PackageJson): PackageJson {
  const name = manifest.name ?? '(unnamed)'
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    for (const dependency of Object.keys(manifest[field] ?? {})) {
      const spec = enterpriseSpecifier(dependency)
      if (spec) throw new Error(`${name} depends on enterprise package ${spec} in ${field}`)
    }
  }
  const out: PackageJson = structuredClone(manifest)
  if (out.devDependencies) {
    out.devDependencies = Object.fromEntries(Object.entries(out.devDependencies).filter(([dependency]) => !enterpriseSpecifier(dependency)))
  }
  return out
}

/** The tsconfig.open-check.json content for a package: production code only (P12). */
export function productionTsconfig(): { extends: './tsconfig.json'; exclude: string[] } {
  return { extends: './tsconfig.json', exclude: ['**/*.test.ts', '**/*.typecheck.ts', '**/test/**', 'vitest.config.ts'] }
}

// ---- the CLI ---------------------------------------------------------------------------------------------------------

const REPO = fileURLToPath(new URL('../../..', import.meta.url))
const SKIP = new Set(['node_modules', '.wrangler', '.dev.vars'])
const DB_ENV = ['DATABASE_URL', 'TEST_DATABASE_URL', 'TEST_APP_DATABASE_URL', 'MIGRATION_DATABASE_URL']

function run(command: string, args: string[], cwd: string): boolean {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of DB_ENV) delete env[name]
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env })
  return result.status === 0
}

function main(): void {
  const keep = process.argv.includes('--keep')
  let ok = 0
  let failed = 0
  const step = (name: string, passed: boolean, detail?: string) => {
    if (passed) ok++
    else failed++
    console.log(`${passed ? 'ok  ' : 'FAIL'} ${name}${passed || !detail ? '' : ` -> ${detail}`}`)
    return passed
  }
  console.log("not covered: packages/api's test suites (the Postgres-backed oracle, spec D14)")

  const dir = mkdtempSync(join(tmpdir(), 'vault-open-check-'))
  console.log(`workspace ${dir}`)
  try {
    // copy
    try {
      const { open } = classifyPackages(readdirSync(join(REPO, 'packages'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name))
      for (const pkg of open) {
        const to = join(dir, 'packages', pkg)
        cpSync(join(REPO, 'packages', pkg), to, {
          recursive: true,
          filter: (src) => {
            const base = src.split(sep).pop() ?? ''
            return !SKIP.has(base) && !base.startsWith('.env')
          },
        })
        const manifestPath = join(to, 'package.json')
        writeFileSync(manifestPath, JSON.stringify(openManifest(JSON.parse(readFileSync(manifestPath, 'utf-8'))), null, 2) + '\n')
      }
      const root = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8')) as Record<string, unknown>
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'open-check', private: true, type: root.type, packageManager: root.packageManager, engines: root.engines }, null, 2) + '\n',
      )
      for (const file of ['pnpm-workspace.yaml', 'pnpm-lock.yaml', '.nvmrc']) if (existsSync(join(REPO, file))) cpSync(join(REPO, file), join(dir, file))
      step('copy', true)
    } catch (err) {
      step('copy', false, err instanceof Error ? err.message : String(err))
      return
    }

    // install
    if (!step('install', run('pnpm', ['install', '--prefer-offline', '--no-frozen-lockfile'], dir))) return

    // no enterprise package in the copy
    const present: string[] = []
    const store = join(dir, 'node_modules', '.pnpm')
    if (existsSync(store)) present.push(...readdirSync(store).filter((e) => e.startsWith('pg@')))
    for (const base of [dir, ...readdirSync(join(dir, 'packages')).map((p) => join(dir, 'packages', p))]) {
      for (const name of ['db', 'storage-postgres', 'server-postgres']) {
        if (existsSync(join(base, 'node_modules', '@vault', name))) present.push(join(base, 'node_modules', '@vault', name).replace(dir, '.'))
      }
    }
    step('no-enterprise-in-node_modules', present.length === 0, present.join(', '))

    // production typecheck, one package at a time
    for (const pkg of OPEN_PACKAGES) {
      const cwd = join(dir, 'packages', pkg)
      writeFileSync(join(cwd, 'tsconfig.open-check.json'), JSON.stringify(productionTsconfig(), null, 2) + '\n')
      step(`typecheck ${pkg}`, run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.open-check.json', '--noEmit'], cwd))
    }

    // the open suites and the Worker smoke
    for (const pkg of ['storage', 'storage-d1', 'server-d1']) step(`test ${pkg}`, run('pnpm', ['test'], join(dir, 'packages', pkg)))
    step('smoke:worker', run('pnpm', ['smoke:worker'], join(dir, 'packages', 'server-d1')))
  } finally {
    if (keep) console.log(`kept ${dir}`)
    else rmSync(dir, { recursive: true, force: true })
    console.log(`open-only check: ${ok} ok, ${failed} failed`)
    process.exitCode = failed > 0 ? 1 : 0
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()

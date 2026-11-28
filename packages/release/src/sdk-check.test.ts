// [[OPS709]] D7: the SDK steps of `release:check`, each shown refusing its fault on a doctored copy of a real built SDK tarball (extract, edit, `npm pack`).
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ReleaseRefusal } from './errors.js'
import { checkSdkTarball, installedAloneProblems, sdkExportsProblems } from './sdk-check.js'
import { buildSdk } from './sdk-build.js'
import { stageSdk } from './stage.js'
import { readReleaseVersion } from './version.js'

const REPO = fileURLToPath(new URL('../../..', import.meta.url))
const version = readReleaseVersion(REPO)
let scratch: string
let real: string
const mk = (name: string) => {
  const d = join(scratch, name)
  mkdirSync(d)
  return d
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'ops709-sdk-'))
  const build = mk('build')
  await buildSdk({ outDir: build })
  const pkg = mk('pkg')
  stageSdk({
    outDir: pkg,
    version,
    license: readFileSync(join(REPO, 'LICENSE'), 'utf8'),
    sdkReadme: readFileSync(join(REPO, 'packages', 'sdk', 'README.md'), 'utf8'),
    sdkDistDir: join(build, 'dist'),
  })
  const out = mk('real')
  execFileSync('npm', ['pack', '--pack-destination', out, '--ignore-scripts', '--silent'], { cwd: pkg })
  real = join(out, `vibase-sdk-${version}.tgz`)
}, 120_000)
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** A copy of the real tarball with `edit` applied to its extracted package directory. */
function doctor(name: string, edit: (pkgDir: string) => void): string {
  const x = mk(`x-${name}`)
  execFileSync('tar', ['-xzf', real, '-C', x])
  edit(join(x, 'package'))
  const out = mk(`o-${name}`)
  execFileSync('npm', ['pack', '--pack-destination', out, '--ignore-scripts', '--silent'], { cwd: join(x, 'package') })
  return join(out, `vibase-sdk-${version}.tgz`)
}
const replaceIn = (file: string, from: string, to: string) => {
  const text = readFileSync(file, 'utf8')
  if (!text.includes(from)) throw new Error(`fixture: ${from} not in ${file}`)
  writeFileSync(file, text.split(from).join(to))
}
const run = (tarball: string) => {
  const lines: string[] = []
  const root = mk(`root-${lines.length}-${Math.random().toString(36).slice(2)}`)
  checkSdkTarball({ tarball, root, version, databaseIds: [], log: (l) => lines.push(l) })
  return lines
}
const refusal = (tarball: string): string => {
  try {
    run(tarball)
  } catch (e) {
    expect(e).toBeInstanceOf(ReleaseRefusal)
    return (e as Error).message
  }
  throw new Error('the check did not refuse')
}

describe('3. installed alone and resolved', () => {
  const tree = (names: string[]) => {
    const d = mk(`nm-${Math.random().toString(36).slice(2)}`)
    for (const n of names) mkdirSync(join(d, n), { recursive: true })
    return d
  }
  it('node_modules holding only @vibase/sdk has no problem', () => {
    expect(installedAloneProblems(tree(['@vibase/sdk', '.bin']))).toEqual([])
  })
  it('a second package in node_modules is a problem, named', () => {
    expect(installedAloneProblems(tree(['@vibase/sdk', 'left-pad'])).join()).toMatch(/left-pad/)
    expect(installedAloneProblems(tree(['@vibase/sdk', '@vibase/api'])).join()).toMatch(/@vibase\/api/)
  })
  it('no @vibase/sdk at all is a problem', () => {
    expect(installedAloneProblems(tree(['left-pad'])).length).toBeGreaterThan(0)
  })
  const manifest = (exports: unknown) => {
    const d = mk(`inst-${Math.random().toString(36).slice(2)}`)
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: '@vibase/sdk', exports }))
    return d
  }
  it('an installed manifest with both exports entries has no problem', () => {
    expect(
      sdkExportsProblems(
        manifest({
          '.': { types: './dist/index.d.ts', default: './dist/index.js' },
          './package.json': './package.json',
        }),
      ),
    ).toEqual([])
  })
  it.each(['.', './package.json'])('an installed manifest missing the %s entry is a problem', (entry) => {
    const all: Record<string, unknown> = { '.': { default: './dist/index.js' }, './package.json': './package.json' }
    delete all[entry]
    expect(sdkExportsProblems(manifest(all)).join()).toContain(entry)
  })
})

describe('a real SDK tarball', () => {
  it('passes, logging one line per SDK step', () => {
    const lines = run(real)
    const text = lines.join('\n')
    expect(text).toMatch(/sdk tarball ok: @vibase\/sdk/)
    expect(text).toMatch(/sdk installed alone \(node_modules: @vibase\/sdk only\)/)
    expect(text).toMatch(/sdk exports resolve: \., \.\/package\.json/)
    expect(text).toMatch(/sdk runtime: .*authorization/)
    expect(text).toMatch(/sdk types: TypeScript 5\.9\.3, NodeNext\/NodeNext ok .*ESNext\/Bundler ok/)
  })
  it('5c. the declarations TypeScript read are the installed ones, and the compiler is 5.9.3', () => {
    const typesLine = run(real).find((l) => l.startsWith('sdk types:'))!
    expect(typesLine).toContain('TypeScript 5.9.3')
    expect(typesLine).toMatch(/NodeNext\/NodeNext ok \(read .*node_modules\/@vibase\/sdk\/dist\/index\.d\.ts/)
    expect(typesLine).toMatch(/ESNext\/Bundler ok \(read .*node_modules\/@vibase\/sdk\/dist\/index\.d\.ts/)
    expect(typesLine).not.toContain('packages/sdk')
  })
})

describe('4. runtime call', () => {
  it('refuses a package that does not export isVibaseError', () => {
    const t = doctor('noerr', (p) => replaceIn(join(p, 'dist', 'index.js'), 'isVibaseError, ', ''))
    expect(refusal(t)).toMatch(/isVibaseError/)
  })
  it('refuses a package that does not export VibaseError', () => {
    const t = doctor('noclass', (p) =>
      replaceIn(join(p, 'dist', 'index.js'), 'isVibaseError, VibaseError', 'isVibaseError'),
    )
    expect(refusal(t)).toMatch(/VibaseError/)
  })
  it('refuses a client that sends no authorization header', () => {
    const t = doctor('noauth', (p) =>
      replaceIn(join(p, 'dist', 'client.js'), 'authorization: `Bearer', "'x-not-authorization': `Bearer"),
    )
    expect(refusal(t)).toMatch(/authorization header was null/)
  })
  it('refuses a client that calls the wrong URL', () => {
    const t = doctor('wrongurl', (p) =>
      replaceIn(join(p, 'dist', 'generated', 'operations.js'), '/api/v1/contacts/{id}', '/api/v2/contacts/{id}'),
    )
    expect(refusal(t)).toMatch(/URL or method/)
  })
})

describe('5. types are proven, not vacuous (NodeNext x Bundler)', () => {
  it('(a) a client typed any fails in both modes: the @ts-expect-error lines go unused', () => {
    const t = doctor('any', (p) => replaceIn(join(p, 'dist', 'client.d.ts'), '): Client<Ops>;', '): any;'))
    const m = refusal(t)
    expect(m).toMatch(/NodeNext\/NodeNext/)
    expect(m).toMatch(/ESNext\/Bundler/)
    expect(m).toMatch(/TS2578/)
  })
  it('(b) a declaration error in the shipped .d.ts fails both modes (skipLibCheck false)', () => {
    const t = doctor('baddts', (p) => {
      const f = join(p, 'dist', 'index.d.ts')
      writeFileSync(f, `${readFileSync(f, 'utf8')}export declare const broken: NotAType;\n`)
    })
    const m = refusal(t)
    expect(m).toMatch(/NodeNext\/NodeNext/)
    expect(m).toMatch(/ESNext\/Bundler/)
    expect(m).toMatch(/NotAType/)
  })
})

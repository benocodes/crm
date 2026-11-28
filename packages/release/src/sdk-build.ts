// The build of `@vibase/sdk` ([[OPS693]] D1): the SDK's own pinned TypeScript (5.9.3, `packages/sdk/package.json`) compiles the import closure of `src/index.ts` into `<outDir>/dist/`.
// Nothing is written into `packages/sdk`, and the generator, the test helper and the tests are never reached from `index.ts`, so they are never emitted.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ReleaseRefusal } from './errors.js'

const SDK = fileURLToPath(new URL('../../sdk/', import.meta.url))

/** The slice of the TypeScript 5.x API this build uses; the release package's own `typescript` types are 7.x, which has no such API. */
interface SdkTypeScript {
  ScriptTarget: { ES2022: number }
  ModuleKind: { NodeNext: number }
  ModuleResolutionKind: { NodeNext: number }
  createProgram(o: { rootNames: string[]; options: Record<string, unknown> }): {
    emit(): { emitSkipped: boolean; diagnostics: readonly unknown[] }
  }
  getPreEmitDiagnostics(program: unknown): readonly unknown[]
  formatDiagnostics(
    d: readonly unknown[],
    host: { getCanonicalFileName(f: string): string; getCurrentDirectory(): string; getNewLine(): string },
  ): string
}

/** Emits ES2022 ESM `.js` and a `.d.ts` per module, NodeNext, no source maps. A declaration-emit error is a refusal: the fix is an annotation in the SDK source. */
export async function buildSdk(o: { outDir: string }): Promise<void> {
  // The release package's own `typescript` is 7.x; the SDK's is the 5.x its generator needs, so it is required from the SDK's directory.
  const ts = createRequire(join(SDK, 'package.json'))('typescript') as SdkTypeScript
  const program = ts.createProgram({
    rootNames: [join(SDK, 'src', 'index.ts')],
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
      types: [],
      strict: true,
      skipLibCheck: true,
      declaration: true,
      sourceMap: false,
      declarationMap: false,
      rootDir: join(SDK, 'src'),
      outDir: join(o.outDir, 'dist'),
    },
  })
  const result = program.emit()
  const diagnostics = [...ts.getPreEmitDiagnostics(program), ...result.diagnostics]
  if (result.emitSkipped || diagnostics.length > 0)
    throw new ReleaseRefusal(
      `the SDK does not build: ${ts
        .formatDiagnostics(diagnostics, {
          getCanonicalFileName: (f: string) => f,
          getCurrentDirectory: () => SDK,
          getNewLine: () => '\n',
        })
        .trim()}`,
    )
}

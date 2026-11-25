import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { GENERATE_COMMAND } from './emit.js'
import { generateSdk, loadDocuments } from './index.js'
import { generateWorkspace } from './workspace.js'

export interface RunOptions {
  /** The process working directory (default: `process.cwd()`). */
  cwd?: string
  /** The directory the command was invoked from: `INIT_CWD` when pnpm sets it (DX604 D2). Relative `--out` and `--schema` resolve against it. */
  initCwd?: string
  /** The fetch `--url` uses (default: the global one). */
  fetch?: typeof fetch
  /** Where the no-source (built-in) run writes (default: the package's own `src/generated/`). */
  builtInDir?: string
}
export interface RunResult {
  /** 0 done; 1 a generation failed; 2 the command line was refused (nothing was read or written). */
  code: number
  stdout: string
  stderr: string
}

const GENERATED = fileURLToPath(new URL('../generated/', import.meta.url))
const USAGE = `usage: ${GENERATE_COMMAND} [--url <origin> | --schema <file>] [--out <dir>]
  no source: regenerate the built-in files in src/generated/
  --url <origin>   the deployment's two public OpenAPI documents (https; http only for localhost)
  --schema <file>  the workspace's schema file, built in-process
  --out <dir>      required with a source; never this package's src/generated/`

const refuse = (message: string): RunResult => ({ code: 2, stdout: '', stderr: `${message}\n${USAGE}\n` })

/** The generator's command (DX604 D2): flags in, files written, a code out. `main.ts` only calls it. */
export async function run(argv: string[], options: RunOptions = {}): Promise<RunResult> {
  let values: { url?: string; schema?: string; out?: string }
  try {
    values = parseArgs({
      args: argv,
      options: { url: { type: 'string' }, schema: { type: 'string' }, out: { type: 'string' } },
      allowPositionals: false,
      strict: true,
    }).values
  } catch (e) {
    return refuse((e as Error).message)
  }
  const base = options.initCwd ?? process.env.INIT_CWD ?? options.cwd ?? process.cwd()

  if (values.url === undefined && values.schema === undefined) {
    if (values.out !== undefined)
      return refuse('--out needs a source: give --url or --schema (or neither, for the built-in files)')
    const dir = options.builtInDir ?? GENERATED
    const generated = await generateSdk(await loadDocuments())
    await mkdir(dir, { recursive: true })
    await writeFile(resolve(dir, 'operations.ts'), generated.operations)
    await writeFile(resolve(dir, 'types.ts'), generated.types)
    return { code: 0, stdout: 'Generated src/generated/operations.ts and src/generated/types.ts\n', stderr: '' }
  }

  if (values.url !== undefined && values.schema !== undefined)
    return refuse('give exactly one source: --url or --schema, not both')
  if (values.out === undefined) return refuse('a source needs --out <dir>: where the two files are written')
  const out = resolve(base, values.out)
  const inside = relative(resolve(GENERATED), out)
  if (inside === '' || (!inside.startsWith('..') && !inside.startsWith(sep) && !/^[a-zA-Z]:/.test(inside)))
    return refuse(
      `--out ${values.out} is this package's own src/generated/: the built-ins never pick up a workspace's names`,
    )

  try {
    let generated: { operations: string; types: string }
    if (values.url !== undefined) {
      generated = await generateWorkspace({
        source: { url: values.url, ...(options.fetch ? { fetch: options.fetch } : {}) },
      })
    } else {
      const file = resolve(base, values.schema as string)
      generated = await generateWorkspace({
        source: { schema: await readFile(file, 'utf8'), name: basename(file) },
      })
    }
    await mkdir(out, { recursive: true })
    await writeFile(resolve(out, 'operations.ts'), generated.operations)
    await writeFile(resolve(out, 'types.ts'), generated.types)
    return {
      code: 0,
      stdout: `Generated ${resolve(out, 'operations.ts')} and ${resolve(out, 'types.ts')}\n`,
      stderr: '',
    }
  } catch (e) {
    return { code: 1, stdout: '', stderr: `${(e as Error).message}\n` }
  }
}

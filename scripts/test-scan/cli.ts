// The test scan's command line (OPS670). Never edits or deletes a test (D8); it lists.
//   pnpm test-scan scan [path-prefix ...] [--dry-run] [--limit n] [--concurrency n] [--max-input-tokens n] [--max-state-chars n] [--out dir]
//   pnpm test-scan extract [--removal-threshold p] [--keep-threshold p] [--out dir]
// Credentials: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment (scan only, never --dry-run). Exit codes: 0 ok, 1 some cases failed, 2 refused, 3 input-token ceiling hit.
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { extract } from './extract.ts'
import { EXIT, scan } from './scan.ts'

const HELP = `Usage: pnpm test-scan scan [path-prefix ...] [--dry-run] [--limit <n>] [--concurrency <n>] [--max-input-tokens <n>] [--max-state-chars <n>] [--out <dir>]
       pnpm test-scan extract [--removal-threshold <p>] [--keep-threshold <p>] [--out <dir>]
Slices every tracked test file into cases, asks Clef the fixed question set about each and stores the answers
(default .test-scan/); extract lists removal candidates from the store with no network call. Nothing is ever edited or deleted.
Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment for a real scan. Exit: 0 ok, 1 failed cases, 2 refused, 3 ceiling.`

const root = join(import.meta.dirname, '..', '..')

function int(name: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`)
  return n
}
function prob(name: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`--${name} must be a number from 0 to 1`)
  return n
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean' },
      limit: { type: 'string' },
      concurrency: { type: 'string' },
      'max-input-tokens': { type: 'string' },
      'max-state-chars': { type: 'string' },
      'removal-threshold': { type: 'string' },
      'keep-threshold': { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const [command, ...rest] = positionals
  if (values.help || !command) {
    console.log(HELP)
    return command || values.help ? EXIT.ok : EXIT.refused
  }
  const outDir = resolve(root, values.out ?? '.test-scan')
  if (command === 'scan') {
    const { exitCode } = await scan({
      root,
      outDir,
      env: process.env,
      paths: rest,
      dryRun: values['dry-run'],
      limit: int('limit', values.limit),
      concurrency: int('concurrency', values.concurrency),
      maxInputTokens: int('max-input-tokens', values['max-input-tokens']),
      maxStateChars: int('max-state-chars', values['max-state-chars']),
    })
    return exitCode
  }
  if (command === 'extract') {
    const r = extract(outDir, {
      removalThreshold: prob('removal-threshold', values['removal-threshold']),
      keepThreshold: prob('keep-threshold', values['keep-threshold']),
    })
    console.log(
      `${r.candidates.length} candidates, ${r.uncertain.length} uncertain: written to ${outDir}/candidates.json and candidates.md`,
    )
    return EXIT.ok
  }
  console.error(`unknown command: ${command}\n${HELP}`)
  return EXIT.refused
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(EXIT.refused)
  },
)

#!/usr/bin/env node
// `pnpm vibase <args>` from the repo root ([[API6]] D12). pnpm runs root scripts with the repo root as the working
// directory, which would silently rebase the caller's relative `@file` and `--output` paths, so this wrapper runs the built
// CLI in INIT_CWD (the directory the caller typed the command in). No dependencies; stdio is inherited, never buffered.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const cliDir = fileURLToPath(new URL('../packages/cli', import.meta.url))
const entry = fileURLToPath(new URL('../packages/cli/dist/vibase.js', import.meta.url))
const cwd = process.env.INIT_CWD || process.cwd()

if (!existsSync(entry)) {
  process.stderr.write('vibase: packages/cli/dist/vibase.js is missing, building it with `pnpm -C packages/cli build`\n')
  // The build's output goes to stderr so stdout stays the CLI's alone.
  const build = spawnSync('pnpm', ['-C', cliDir, 'build'], { cwd: repoRoot, stdio: ['ignore', process.stderr, process.stderr] })
  if (build.status !== 0 || !existsSync(entry)) {
    process.stderr.write('vibase: the build failed; run `pnpm install && pnpm -C packages/cli build` from the repo root\n')
    process.exit(2)
  }
}

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { cwd, stdio: 'inherit' })
child.on('error', (e) => {
  process.stderr.write(`vibase: could not start the CLI: ${e.message}\n`)
  process.exit(2)
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})

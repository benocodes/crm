// The process entry of `cli/server.js` ([[OPS240]] D21): `vibase-server <command>`. The package directory is the parent of the directory this file is bundled into (`<package>/cli/server.js`).
import { fileURLToPath } from 'node:url'
import { runInstance } from './main.js'

process.exitCode = await runInstance(
  process.argv.slice(2),
  { stdout: (t) => void process.stdout.write(t), stderr: (t) => void process.stderr.write(t), env: process.env },
  fileURLToPath(new URL('..', import.meta.url)),
)

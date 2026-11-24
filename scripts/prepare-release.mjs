#!/usr/bin/env node
// Maintainer helper: tag the release, wait for release.yml, download and verify the tarballs.
// `pnpm prepare-release [--dry-run]`. Publishing to npm stays a person's step (packages/release/README.md).
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dryRun = process.argv.includes('--dry-run')
const outRoot = process.env.VIBASE_RELEASES_DIR ?? join(homedir(), 'code', 'vibase-releases')
const REPO = 'benocodes/crm'

const out = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim()
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} failed`)
}
const fail = (msg) => {
  console.error(`prepare-release: ${msg}`)
  process.exit(1)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const version = JSON.parse(readFileSync('packages/cli/package.json', 'utf8')).version
const serverVersion = JSON.parse(readFileSync('packages/server-d1/package.json', 'utf8')).version
if (version !== serverVersion) fail(`@vibase/cli ${version} and @vibase/server-d1 ${serverVersion} differ`)
const tag = `v${version}`

// Preconditions: the Version Packages PR is merged, and HEAD is exactly origin/main.
if (out('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') fail('run this on main')
if (out('git', ['status', '--porcelain'])) fail('the working tree is not clean')
run('git', ['fetch', '--quiet', 'origin', 'main', '--tags'])
const head = out('git', ['rev-parse', 'HEAD'])
if (head !== out('git', ['rev-parse', 'origin/main'])) fail('main is not equal to origin/main: git pull first')
if (out('git', ['tag', '--list', tag])) fail(`tag ${tag} already exists`)
if (out('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])) fail(`tag ${tag} already exists on origin`)

const dest = join(outRoot, `vibase-${tag}`)
if (existsSync(dest) && readdirSync(dest).length) fail(`${dest} already exists and is not empty`)

console.log(`Release ${tag} at ${head.slice(0, 7)}; tarballs go to ${dest}`)
if (dryRun) {
  console.log('--dry-run: checks passed, nothing tagged')
  process.exit(0)
}

run('git', ['tag', tag, head])
run('git', ['push', 'origin', tag])

// Find the release.yml run this tag started, then wait for it.
let runId
for (let i = 0; i < 30 && !runId; i++) {
  const runs = JSON.parse(
    out('gh', [
      'run',
      'list',
      '-R',
      REPO,
      '--workflow',
      'release.yml',
      '--branch',
      tag,
      '--json',
      'databaseId,headSha',
      '--limit',
      '5',
    ]),
  )
  runId = runs.find((r) => r.headSha === head)?.databaseId
  if (!runId) await sleep(5000)
}
if (!runId) fail(`no release.yml run appeared for ${tag}; check the Actions tab`)
console.log(`Waiting for release.yml run ${runId} (https://github.com/${REPO}/actions/runs/${runId})`)
run('gh', ['run', 'watch', String(runId), '-R', REPO, '--exit-status', '--interval', '20'])

mkdirSync(dest, { recursive: true })
run('gh', ['release', 'download', tag, '-R', REPO, '--dir', dest])
run('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: dest })

console.log(`\nVerified. Publish from ${dest}:`)
console.log(`  npm publish vibase-server-d1-${version}.tgz --access public`)
console.log(`  npm publish vibase-cli-${version}.tgz --access public`)
console.log('then publish the draft GitHub Release.')

// [[OPS237]] D19, D24, P3: the shape of `.github/workflows/release.yml`, as a function over its text, with the absence mutations as tests of the function.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const FILE = fileURLToPath(new URL('../../../.github/workflows/release.yml', import.meta.url))
const VERSION_FILE = fileURLToPath(new URL('../../../.github/workflows/version.yml', import.meta.url))
const text = () => readFileSync(FILE, 'utf8')
const versionText = () => readFileSync(VERSION_FILE, 'utf8')

type Step = { uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string>; if?: string }
type Job = { permissions?: Record<string, string>; steps?: Step[]; needs?: string | string[]; if?: string }

/** Every way the workflow departs from D19, D24 and P3; empty means it is the release workflow. */
export function workflowProblems(src: string): string[] {
  const out: string[] = []
  const wf = parse(src) as { on?: Record<string, any>; permissions?: Record<string, string>; jobs?: Record<string, Job> }
  const on = wf.on ?? {}
  if (Object.keys(on).sort().join() !== 'push,workflow_dispatch') out.push(`triggers are ${Object.keys(on).join()}, expected exactly workflow_dispatch and push`)
  if (JSON.stringify(on.push) !== JSON.stringify({ tags: ['v*'] })) out.push(`push must be tags: ['v*'] and nothing else, found ${JSON.stringify(on.push)}`)
  if (JSON.stringify(wf.permissions) !== JSON.stringify({ contents: 'read' })) out.push('workflow-level permissions must be exactly contents: read')
  const jobs = wf.jobs ?? {}
  const build = jobs.build
  const release = jobs.release
  if (Object.keys(jobs).sort().join() !== 'build,release') out.push(`jobs are ${Object.keys(jobs).join()}, expected build and release`)
  for (const [name, job] of Object.entries(jobs)) {
    const w = job.permissions?.contents === 'write'
    if (w && name !== 'release') out.push(`job ${name} has write permission`)
    for (const [k, v] of Object.entries(job.permissions ?? {})) if (!(k === 'contents' && (v === 'read' || (v === 'write' && name === 'release')))) out.push(`job ${name} permission ${k}: ${v} is not allowed`)
  }
  if (release?.permissions?.contents !== 'write') out.push('the release job must have contents: write')
  if (JSON.stringify(release?.needs) !== JSON.stringify('build') && JSON.stringify(release?.needs) !== JSON.stringify(['build'])) out.push('the release job must need build')
  if (!/github\.ref_type\s*==\s*'tag'/.test(release?.if ?? '')) out.push("the release job must run only when github.ref_type == 'tag'")

  // Every action is pinned to a full commit SHA, from actions/* or pnpm/action-setup only.
  for (const job of Object.values(jobs)) for (const s of job.steps ?? []) {
    if (!s.uses) continue
    const m = /^([^@]+)@([0-9a-f]{40})(\s|$)/.exec(s.uses)
    if (!m) out.push(`uses ${s.uses} is not pinned to a 40-hex commit SHA`)
    else if (!(m[1]!.startsWith('actions/') || m[1] === 'pnpm/action-setup')) out.push(`uses ${m[1]} is not an actions/* or pnpm/action-setup action`)
  }
  // The tag comment beside each pin ("# v4.1.0").
  for (const line of src.split('\n')) if (/^\s*-?\s*uses:/.test(line) && !/#\s*v\d/.test(line)) out.push(`uses line has no tag comment: ${line.trim()}`)

  // No publish, no token, no secret but GITHUB_TOKEN.
  if (/npm\s+publish|pnpm\s+publish|NPM_TOKEN|NODE_AUTH_TOKEN|registry-url/.test(src)) out.push('the workflow publishes or carries an npm credential')
  for (const m of src.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) if (m[1] !== 'GITHUB_TOKEN') out.push(`references secrets.${m[1]}`)
  if (/changesets\/action|changeset publish|changeset tag/.test(src)) out.push('release.yml must not use changesets/action or run changeset publish or tag')
  if (/pull_request_target|--prerelease=false|--draft=false|--latest/.test(src)) out.push('a pull_request_target trigger or a flag that marks the release non-draft')

  // Build job: order.
  const runs = (build?.steps ?? []).map((s) => s.run ?? '')
  const at = (re: RegExp) => runs.findIndex((r) => re.test(r))
  const order = [
    ['frozen install', /pnpm install --frozen-lockfile/],
    ['tag check', /release:ci tag/],
    ['typecheck', /pnpm -r typecheck/],
    ['suites (all but api)', /pnpm -r --workspace-concurrency=1 --filter '!@vibase\/api' test/],
    ['api suite', /pnpm -C packages\/api test/],
    ['build', /pnpm -r build/],
    ['clean tree', /git status --porcelain/],
    ['release:build', /pnpm release:build(?!.*--allow-dirty)/],
    ['release:check', /pnpm release:check/],
    ['asset list', /release:ci assets/],
  ] as const
  let prev = -1
  for (const [name, re] of order) {
    const i = at(re)
    if (i < 0) out.push(`build job has no ${name} step`)
    else if (i <= prev) out.push(`build job step "${name}" is out of order`)
    else prev = i
  }
  if (runs.some((r) => /--allow-dirty/.test(r))) out.push('release:build must not use --allow-dirty')
  if (runs.some((r) => /test:postgres/.test(r))) out.push('Postgres suites must stay off')
  // The upload.
  const upload = (build?.steps ?? []).find((s) => s.uses?.startsWith('actions/upload-artifact@'))
  if (!upload) out.push('build job has no upload-artifact step')
  else {
    const paths = String(upload.with?.path ?? '').split('\n').map((p) => p.trim()).filter(Boolean)
    for (const want of ['vibase-cli-', 'vibase-server-d1-', 'SHA256SUMS']) if (!paths.some((p) => p.includes(want))) out.push(`the artifact does not carry ${want}`)
    if (paths.length !== 3) out.push(`the artifact carries ${paths.length} paths, expected exactly 3`)
    if (upload.with?.['retention-days'] !== 7) out.push('retention-days must be 7')
  }
  // The draft release.
  const rel = (release?.steps ?? []).map((s) => s.run ?? '').filter((r) => /gh release/.test(r))
  if (rel.length !== 1) out.push(`the release job has ${rel.length} gh release steps, expected 1`)
  else {
    if (!/gh release create/.test(rel[0]!)) out.push('the release must be created with gh release create')
    if (!/--draft(\s|$)/.test(rel[0]!)) out.push('the release is not created as a draft')
    if (/gh release (edit|upload|delete)/.test(rel[0]!)) out.push('the workflow must never edit or replace a release')
    if (!/CHANGELOG\.md/.test(rel[0]!)) out.push('the draft body must point to the two CHANGELOG.md files')
  }
  return out
}

/** Every way `version.yml` departs from D19/D25: push to main only, changesets/action SHA-pinned with no publish input, exactly two write permissions, no secret but GITHUB_TOKEN. */
export function versionWorkflowProblems(src: string): string[] {
  const out: string[] = []
  const wf = parse(src) as { on?: Record<string, any>; permissions?: Record<string, string>; jobs?: Record<string, Job> }
  const on = wf.on ?? {}
  if (JSON.stringify(on) !== JSON.stringify({ push: { branches: ['main'] } })) out.push(`version.yml must trigger on push to main only, found ${JSON.stringify(on)}`)
  const jobs = Object.values(wf.jobs ?? {})
  if (jobs.length !== 1) out.push(`version.yml has ${jobs.length} jobs, expected 1`)
  const perms = jobs[0]?.permissions ?? wf.permissions
  if (JSON.stringify(Object.entries(perms ?? {}).sort()) !== JSON.stringify([['contents', 'write'], ['pull-requests', 'write']])) out.push(`permissions must be exactly contents: write and pull-requests: write, found ${JSON.stringify(perms)}`)
  const steps = jobs.flatMap((j) => j.steps ?? [])
  let cs = 0
  for (const s of steps) {
    if (!s.uses) continue
    const m = /^([^@]+)@([0-9a-f]{40})(\s|$)/.exec(s.uses)
    if (!m) out.push(`uses ${s.uses} is not pinned to a 40-hex commit SHA`)
    else if (m[1] === 'changesets/action') {
      cs++
      if (s.with && 'publish' in s.with) out.push('changesets/action must have no publish input')
    } else if (!(m[1]!.startsWith('actions/') || m[1] === 'pnpm/action-setup')) out.push(`uses ${m[1]} is not allowed`)
  }
  if (cs !== 1) out.push(`expected exactly one changesets/action step, found ${cs}`)
  for (const line of src.split('\n')) if (/^\s*-?\s*uses:/.test(line) && !/#\s*v\d/.test(line)) out.push(`uses line has no tag comment: ${line.trim()}`)
  if (!steps.some((s) => /pnpm install --frozen-lockfile/.test(s.run ?? ''))) out.push('no frozen install step')
  if (/npm\s+publish|pnpm\s+publish|NPM_TOKEN|NODE_AUTH_TOKEN|registry-url|changeset publish|changeset tag|pull_request_target/.test(src)) out.push('version.yml publishes, tags, or carries an npm credential')
  for (const m of src.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) if (m[1] !== 'GITHUB_TOKEN') out.push(`references secrets.${m[1]}`)
  return out
}

describe('version.yml (D19, D25, D24)', () => {
  it('has the shape: push to main, changesets/action pinned with no publish, two write permissions, nothing published', () => {
    expect(versionWorkflowProblems(versionText())).toEqual([])
  })
  const mutateV = (name: string, f: (t: string) => string, expected: RegExp) =>
    it(`mutation: ${name} turns the check red`, () => {
      const mutated = f(versionText())
      expect(mutated).not.toEqual(versionText())
      expect(versionWorkflowProblems(mutated).join('\n')).toMatch(expected)
    })
  mutateV('a publish input on the action', (t) => t.replace(/^( +)with:\n/m, '$1with:\n$1  publish: pnpm changeset publish\n'), /no publish input|publishes/)
  mutateV('NPM_TOKEN in version.yml', (t) => t.replace(/secrets\.GITHUB_TOKEN/, 'secrets.NPM_TOKEN'), /NPM_TOKEN|publishes/)
  mutateV('the action pinned to a tag', (t) => t.replace(/changesets\/action@[0-9a-f]{40}/, 'changesets/action@v1'), /not pinned/)
  mutateV('a pull_request trigger', (t) => t.replace(/^on:\n/m, 'on:\n  pull_request:\n'), /push to main only/)
  mutateV('an extra permission', (t) => t.replace(/pull-requests: write/, 'pull-requests: write\n      id-token: write'), /permissions must be exactly/)
})

describe('release.yml (D19, D24, P3)', () => {
  it('has the shape: two triggers, the step order, the artifact, a draft release, no publish, pinned actions, write only on the release job', () => {
    expect(workflowProblems(text())).toEqual([])
  })

  // The absence mutations: each takes the real text, injects one fault and must be seen.
  const mutate = (name: string, f: (t: string) => string, expected: RegExp) =>
    it(`mutation: ${name} turns the check red`, () => {
      const mutated = f(text())
      expect(mutated).not.toEqual(text())
      expect(workflowProblems(mutated).join('\n')).toMatch(expected)
    })
  mutate('a pull_request trigger', (t) => t.replace(/^on:\n/m, 'on:\n  pull_request:\n'), /triggers are/)
  mutate('an npm publish step', (t) => t.replace(/^( +)- name: Build the release$/m, '$1- run: npm publish\n$&'), /publishes or carries/)
  mutate('no draft flag', (t) => t.replace(/ --draft/, ''), /not created as a draft/)
  mutate('an action pinned to a tag', (t) => t.replace(/actions\/checkout@[0-9a-f]{40}/, 'actions/checkout@v4'), /not pinned/)
  mutate('write permission on the build job', (t) => t.replace(/^( +)build:\n/m, '$1build:\n$1  permissions:\n$1    contents: write\n'), /build has write permission/)
  mutate('a secret other than GITHUB_TOKEN', (t) => t.replace(/secrets\.GITHUB_TOKEN/, 'secrets.NPM_TOKEN'), /secrets\.NPM_TOKEN/)
  mutate('release:build --allow-dirty', (t) => t.replace(/pnpm release:build/, 'pnpm release:build --allow-dirty'), /allow-dirty/)
  mutate('retention changed', (t) => t.replace(/retention-days: 7/, 'retention-days: 90'), /retention-days/)
  mutate('changesets/action added to release.yml', (t) => t.replace(/^( +)- name: Build the release$/m, '$1- uses: changesets/action@0000000000000000000000000000000000000000 # v1\n$&'), /changesets\/action/)
  mutate('the draft body without the CHANGELOG pointer', (t) => t.replace(/CHANGELOG\.md/g, 'notes'), /CHANGELOG/)
  mutate('the tag check dropped', (t) => t.replace(/release:ci tag/, 'echo skipped'), /no tag check/)
})

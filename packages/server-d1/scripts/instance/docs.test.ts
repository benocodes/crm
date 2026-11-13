// [[OPS237]] D20, P4: the two pages of the docs site tell the truth about the programs. Every `vibase-server` line names a subcommand and only flags the shipped
// parsers accept (asked of the parsers themselves, one flag at a time, not a hand list); every `vibase` line names a real client command (the commands derived
// from the API's own OpenAPI documents, plus the hand commands of the client's help); the tarball names are D2's; the repo-script path is under "From source".
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createApp, openApiPath, SURFACES } from '@vibase/api'
import { deriveCommands, RESERVED_FLAGS, mergeDocuments } from '../../../cli/src/derive.js'
import { GLOBAL_FLAGS, HAND_COMMANDS } from '../../../cli/src/help.js'
import { runInstance } from './main.js'
import { parseInstanceSetupArgs } from './setup-args.js'

const DOCS = fileURLToPath(new URL('../../../docs/src/content/docs/', import.meta.url))
const page = (p: string) => readFileSync(`${DOCS}${p}.md`, 'utf8')

interface Line { line: string; heading: string }

/** The shell lines of a page's ```bash blocks, continuations joined, each with the `##` heading it sits under. */
export function shellLines(md: string): Line[] {
  const out: Line[] = []
  let heading = ''
  let inBash = false
  let carry = ''
  for (const raw of md.split('\n')) {
    if (!inBash) {
      const h = /^##\s+(.*)$/.exec(raw)
      if (h) heading = h[1]!.trim()
      if (/^```(bash|sh)\s*$/.test(raw)) inBash = true
      continue
    }
    if (/^```\s*$/.test(raw)) {
      inBash = false
      continue
    }
    const t = raw.trim()
    if (t.endsWith('\\')) {
      carry += t.slice(0, -1).trim() + ' '
      continue
    }
    const full = (carry + t).trim()
    carry = ''
    if (full !== '' && !full.startsWith('#')) out.push({ line: full, heading })
  }
  return out
}

const stripEnv = (l: string) => l.replace(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/, '')
const flagsOf = (words: string[]) => words.filter((w) => w.startsWith('--') && w.length > 2).map((w) => w.split('=')[0]!)

const SERVER_COMMANDS = ['status', 'upgrade', 'setup']
const probes = new Map<string, Promise<boolean>>()
/** Does the shipped program accept this flag for this command? Asked of its own parser: the flag alone, and only "Unknown option" counts as no. */
function accepts(command: string, flag: string): Promise<boolean> {
  const key = `${command} ${flag}`
  if (!probes.has(key)) {
    probes.set(key, (async () => {
      if (command === 'setup') {
        try {
          parseInstanceSetupArgs([flag])
        } catch (e) {
          return !/Unknown option/.test(e instanceof Error ? e.message : '')
        }
        return true
      }
      const err: string[] = []
      await runInstance([command, flag], { stdout: () => {}, stderr: (t) => void err.push(t), env: {} }, '/nonexistent-package-dir')
      return !/Unknown option/.test(err.join(''))
    })())
  }
  return probes.get(key)!
}

async function serverProblems(rest: string[], where: string): Promise<string[]> {
  const [command, ...args] = rest
  if (command === '--version') return args.length ? [`${where}: --version takes no arguments`] : []
  if (!command || !SERVER_COMMANDS.includes(command)) return [`${where}: "${command ?? ''}" is not a vibase-server command`]
  const out: string[] = []
  for (const f of flagsOf(args)) if (!(await accepts(command, f))) out.push(`${where}: vibase-server ${command} does not accept ${f}`)
  return out
}

let clientCommands: Promise<ReturnType<typeof deriveCommands>> | undefined
const derived = () => (clientCommands ??= (async () => {
  const app = createApp({ workspace: {}, storage: () => ({ kind: 'd1', organizationId: '00000000-0000-7000-8000-000000000000', authProvider: '', authOrgId: '', runtime: { dialect: 'd1', maxSetSize: 0, execute: async () => { throw new Error('no storage') } } }) } as never)
  const docs = []
  for (const s of SURFACES) docs.push({ source: s, doc: await (await app.request(openApiPath(s))).json() })
  return deriveCommands(mergeDocuments(docs))
})())

const HAND = ['login', 'logout', 'config', 'events']
const flagNames = (text: string) => [...text.matchAll(/--([a-z][a-z-]*)/g)].map((m) => `--${m[1]}`)
async function clientProblems(rest: string[], where: string): Promise<string[]> {
  const words: string[] = []
  const flags = flagsOf(rest)
  const valued = new Set(['--server', '--profile', '--scope', '--data', '--output'])
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]!
    if (w.startsWith('--')) {
      if (valued.has(w) || (!['--api-key', '--version', '--help', '--refresh', '--all', '--follow'].includes(w) && rest[i + 1] && !rest[i + 1]!.startsWith('--') && false)) i++
      continue
    }
    words.push(w)
  }
  const global = flagNames(GLOBAL_FLAGS).concat(RESERVED_FLAGS.map((r) => `--${r}`), ['--version'])
  if (words.length === 0) return flags.every((f) => global.includes(f)) ? [] : [`${where}: unknown global flag in ${flags.join(' ')}`]
  const [first, second] = words as [string, string | undefined]
  if (HAND.includes(first)) {
    const row = HAND_COMMANDS.split('\n').filter((l) => l.trim().startsWith(`vibase ${first}`)).join(' ')
    const allowed = [...flagNames(row), ...global]
    return flags.filter((f) => !allowed.includes(f)).map((f) => `${where}: vibase ${first} does not accept ${f}`)
  }
  const cmds = await derived()
  const cmd = cmds.find((c) => c.resource === first && c.action === second)
  if (!cmd) return [`${where}: "vibase ${first} ${second ?? ''}" is not a client command`]
  const allowed = [...cmd.flags.map((f) => `--${f.name}`), ...global]
  return flags.filter((f) => !allowed.includes(f)).map((f) => `${where}: vibase ${first} ${second} does not accept ${f}`)
}

/** Every problem of a page's shell lines. */
export async function pageProblems(md: string, name: string): Promise<string[]> {
  const out: string[] = []
  for (const { line, heading } of shellLines(md)) {
    const where = `${name} [${heading}] \`${line}\``
    const cmd = stripEnv(line)
    for (const t of line.match(/\S*\.tgz/g) ?? []) if (!/^\.\/vibase-(cli|server-d1)-<version>\.tgz$/.test(t)) out.push(`${where}: tarball ${t} is not D2's name vibase-cli-<version>.tgz / vibase-server-d1-<version>.tgz`)
    if (/packages\/server-d1|setup:remote|db:migrate:remote|deploy:remote/.test(line) && heading !== 'From source') out.push(`${where}: the repository-script path belongs under "From source"`)
    let m: RegExpExecArray | null
    if ((m = /^npx @vibase\/server-d1@(\S+) (.*)$/.exec(cmd))) {
      if (m[1] !== '<version>') out.push(`${where}: the version must be the literal <version>`)
      out.push(...(await serverProblems(m[2]!.split(/\s+/), where)))
    } else if ((m = /^npx --package \.\/vibase-server-d1-<version>\.tgz vibase-server (.*)$/.exec(cmd))) out.push(...(await serverProblems(m[1]!.split(/\s+/), where)))
    else if ((m = /^vibase-server (.*)$/.exec(cmd))) out.push(...(await serverProblems(m[1]!.split(/\s+/), where)))
    else if (/vibase-server|@vibase\/server-d1/.test(cmd)) out.push(`${where}: a line that names the server package but is not one of its forms`)
    else if ((m = /^npm i(?:nstall)? -g (\S+)$/.exec(cmd))) {
      if (!/^(@vibase\/cli@<version>|\.\/vibase-cli-<version>\.tgz)$/.test(m[1]!)) out.push(`${where}: the client installs as @vibase/cli@<version> or ./vibase-cli-<version>.tgz`)
    } else if ((m = /^vibase (.*)$/.exec(cmd))) out.push(...(await clientProblems(m[1]!.split(/\s+/), where)))
    else if (/^pnpm vibase\b/.test(cmd)) out.push(`${where}: use the installed \`vibase\`, not \`pnpm vibase\``)
  }
  return out
}

const PAGES = ['getting-started/quickstart', 'deployment/self-hosting'] as const

describe('the docs name only what the programs have (D20, P4)', () => {
  it.each(PAGES)('%s: every command line is a real command with real flags', async (p) => {
    expect(await pageProblems(page(p), p)).toEqual([])
  })
  it('the quickstart is "using Vibase": no vibase-server, wrangler or setup:remote, and the client install is there in both forms', () => {
    const q = page('getting-started/quickstart')
    for (const w of ['vibase-server', 'wrangler', 'setup:remote', '@vibase/server-d1']) expect(q).not.toContain(w)
    expect(q).toContain('npm i -g @vibase/cli@<version>')
    expect(q).toContain('npm i -g ./vibase-cli-<version>.tgz')
  })
  it('self-hosting has the registry form and, after it, the tarball form, marked "until the packages are on npm"', () => {
    const s = page('deployment/self-hosting')
    expect(s).toMatch(/npx @vibase\/server-d1@<version> setup --env \S+ .*--dry-run/s)
    expect(s).toContain('npx --package ./vibase-server-d1-<version>.tgz vibase-server')
    expect(s).toMatch(/until the packages are on npm/i)
    expect(s).toMatch(/SHA256SUMS/)
    expect(s).toMatch(/^## From source$/m)
    for (const sub of ['setup', 'status', 'upgrade']) expect(s).toMatch(new RegExp(`@vibase/server-d1@<version> ${sub} `))
    for (const w of ['vibase_role', 'device', 'dynamic client registration']) expect(s.toLowerCase()).toContain(w.toLowerCase())
  })
  it('names where versions are listed and has no Deploy to Cloudflare section (P5)', () => {
    for (const p of PAGES) expect(page(p)).not.toMatch(/Deploy to Cloudflare/i)
    expect(page('getting-started/quickstart')).toMatch(/Releases page/)
  })

  describe('mutations (the check must see a wrong line)', () => {
    const s = () => page('deployment/self-hosting')
    it('a misspelled flag (--secret-file) in self-hosting is reported', async () => {
      const bad = s().replace('--secrets-file', '--secret-file')
      expect(bad).not.toEqual(s())
      expect((await pageProblems(bad, 'self-hosting')).join('\n')).toMatch(/does not accept --secret-file/)
    })
    it('an unknown subcommand, a pinned version, a tarball of another name and a repo script outside "From source" are reported', async () => {
      const lines = '## Elsewhere\n\n```bash\nvibase-server frobnicate --env x\nnpx @vibase/server-d1@0.1.0 status --env x\nnpm i -g ./vibase-0.1.0.tgz\npnpm -C packages/server-d1 setup:remote -- --env x\nvibase contacts nope\n```\n'
      const p = (await pageProblems(lines, 'x')).join('\n')
      expect(p).toMatch(/"frobnicate" is not a vibase-server command/)
      expect(p).toMatch(/literal <version>/)
      expect(p).toMatch(/not D2's name/)
      expect(p).toMatch(/belongs under "From source"/)
      expect(p).toMatch(/"vibase contacts nope" is not a client command/)
    })
  })
})

// [[OPS237]] D20, P4: the two pages of the docs site tell the truth about the programs. Every `vibase-server` line names a subcommand and only flags the shipped
// parsers accept (asked of the parsers themselves, one flag at a time, not a hand list); every `vibase` line names a real client command (the commands derived
// from the API's own OpenAPI documents, plus the hand commands of the client's help); the tarball names are D2's; the repo-script path is under "From source".
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createApp, openApiPath, SURFACES } from '@vibase/api'
import { deriveCommands, RESERVED_FLAGS, mergeDocuments } from '../../../cli/src/derive.js'
import { GLOBAL_FLAGS, HAND_COMMANDS } from '../../../cli/src/help.js'
import { runInstance } from './main.js'
import { NO_EMAIL_STATEMENT } from '../setup/verify-better-auth.js'
import { INSTANCE_HELP } from './main.js'
import { serverHelpProblems } from '../../../release/src/help-assertions.js'
import { parseInstanceSetupArgs } from './setup-args.js'
import { parseSchemaFile } from '../../../api/src/custom/schema-file.js'

const DOCS = fileURLToPath(new URL('../../../docs/src/content/docs/', import.meta.url))
const page = (p: string) => readFileSync(`${DOCS}${p}.md`, 'utf8')
// The deployment section is several pages (#645, #647): Deploy Vibase is the happy path, the edge cases are pages of their own.
const DEPLOYMENT = readdirSync(`${DOCS}deployment/`)
  .filter((f) => f.endsWith('.md') && f !== 'docs-site.md')
  .map((f) => `deployment/${f.slice(0, -3)}`)
const deployment = () => DEPLOYMENT.map((p) => ({ name: p, md: page(p) }))
/** Every deployment page's text, for a statement that may live on any of them. */
const allDeployment = () =>
  deployment()
    .map((d) => d.md)
    .join('\n')

interface Line {
  line: string
  heading: string
}

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
const flagsOf = (words: string[]) =>
  words.filter((w) => w.startsWith('--') && w.length > 2).map((w) => w.split('=')[0]!)

const SERVER_COMMANDS = ['init', 'status', 'upgrade', 'redeploy', 'setup', 'owner-reset']
const probes = new Map<string, Promise<boolean>>()
/** Does the shipped program accept this flag for this command? Asked of its own parser: the flag alone, and only "Unknown option" counts as no. */
function accepts(command: string, flag: string): Promise<boolean> {
  const key = `${command} ${flag}`
  if (!probes.has(key)) {
    probes.set(
      key,
      (async () => {
        if (command === 'setup') {
          try {
            parseInstanceSetupArgs([flag])
          } catch (e) {
            return !/Unknown option/.test(e instanceof Error ? e.message : '')
          }
          return true
        }
        const err: string[] = []
        await runInstance(
          [command, flag],
          { stdout: () => {}, stderr: (t) => void err.push(t), env: {} },
          '/nonexistent-package-dir',
        )
        return !/Unknown option/.test(err.join(''))
      })(),
    )
  }
  return probes.get(key)!
}

async function serverProblems(rest: string[], where: string): Promise<string[]> {
  const [command, ...args] = rest
  if (command === '--version' || command === '--help')
    return args.length ? [`${where}: ${command} takes no arguments`] : []
  if (!command || !SERVER_COMMANDS.includes(command))
    return [`${where}: "${command ?? ''}" is not a vibase-server command`]
  const out: string[] = []
  for (const f of flagsOf(args))
    if (!(await accepts(command, f))) out.push(`${where}: vibase-server ${command} does not accept ${f}`)
  return out
}

let clientCommands: Promise<ReturnType<typeof deriveCommands>> | undefined
const derived = () =>
  (clientCommands ??= (async () => {
    const app = createApp({
      workspace: {},
      storage: () => ({
        kind: 'd1',
        organizationId: '00000000-0000-7000-8000-000000000000',
        authProvider: '',
        authOrgId: '',
        runtime: {
          dialect: 'd1',
          maxSetSize: 0,
          execute: async () => {
            throw new Error('no storage')
          },
        },
      }),
    } as never)
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
      if (
        valued.has(w) ||
        (!['--api-key', '--version', '--help', '--refresh', '--all', '--follow'].includes(w) &&
          rest[i + 1] &&
          !rest[i + 1]!.startsWith('--') &&
          false)
      )
        i++
      continue
    }
    words.push(w)
  }
  const global = flagNames(GLOBAL_FLAGS).concat(
    RESERVED_FLAGS.map((r) => `--${r}`),
    ['--version'],
  )
  if (words.length === 0)
    return flags.every((f) => global.includes(f)) ? [] : [`${where}: unknown global flag in ${flags.join(' ')}`]
  const [first, second] = words as [string, string | undefined]
  if (HAND.includes(first)) {
    const row = HAND_COMMANDS.split('\n')
      .filter((l) => l.trim().startsWith(`vibase ${first}`))
      .join(' ')
    const allowed = [...flagNames(row), ...global]
    return flags.filter((f) => !allowed.includes(f)).map((f) => `${where}: vibase ${first} does not accept ${f}`)
  }
  const cmds = await derived()
  const cmd = cmds.find((c) => c.resource === first && c.action === second)
  if (!cmd) return [`${where}: "vibase ${first} ${second ?? ''}" is not a client command`]
  const allowed = [...cmd.flags.map((f) => `--${f.name}`), ...global]
  return flags
    .filter((f) => !allowed.includes(f))
    .map((f) => `${where}: vibase ${first} ${second} does not accept ${f}`)
}

/** Every problem of a page's shell lines. */
export async function pageProblems(md: string, name: string): Promise<string[]> {
  const out: string[] = []
  for (const { line, heading } of shellLines(md)) {
    const where = `${name} [${heading}] \`${line}\``
    const cmd = stripEnv(line)
    for (const t of line.match(/\S*\.tgz/g) ?? [])
      if (!/^\.\/vibase-(cli|server-d1)-<version>\.tgz$/.test(t))
        out.push(`${where}: tarball ${t} is not D2's name vibase-cli-<version>.tgz / vibase-server-d1-<version>.tgz`)
    if (
      /packages\/server-d1|setup:remote|db:migrate:remote|deploy:remote/.test(line) &&
      heading !== 'From source' &&
      !name.endsWith('from-source')
    )
      out.push(`${where}: the repository-script path belongs on the "Deploy from source" page`)
    let m: RegExpExecArray | null
    if ((m = /^npx @vibase\/server-d1@(\S+) (.*)$/.exec(cmd))) {
      if (m[1] !== '<version>') out.push(`${where}: the version must be the literal <version>`)
      out.push(...(await serverProblems(m[2]!.split(/\s+/), where)))
    } else if ((m = /^npx --package \.\/vibase-server-d1-<version>\.tgz vibase-server (.*)$/.exec(cmd)))
      out.push(...(await serverProblems(m[1]!.split(/\s+/), where)))
    else if ((m = /^vibase-server (.*)$/.exec(cmd))) out.push(...(await serverProblems(m[1]!.split(/\s+/), where)))
    else if ((m = /^npm i(?:nstall)? -g (\S+)$/.exec(cmd)) && /server-d1/.test(m[1]!)) {
      if (!/^(@vibase\/server-d1(@<version>)?|\.\/vibase-server-d1-<version>\.tgz)$/.test(m[1]!))
        out.push(`${where}: the server installs as @vibase/server-d1[@<version>] or ./vibase-server-d1-<version>.tgz`)
    } else if (/vibase-server|@vibase\/server-d1/.test(cmd))
      out.push(`${where}: a line that names the server package but is not one of its forms`)
    else if ((m = /^npm i(?:nstall)? -g (\S+)$/.exec(cmd))) {
      if (!/^(@vibase\/cli@<version>|\.\/vibase-cli-<version>\.tgz)$/.test(m[1]!))
        out.push(`${where}: the client installs as @vibase/cli@<version> or ./vibase-cli-<version>.tgz`)
    } else if ((m = /^vibase (.*)$/.exec(cmd))) out.push(...(await clientProblems(m[1]!.split(/\s+/), where)))
    else if (/^pnpm vibase\b/.test(cmd)) out.push(`${where}: use the installed \`vibase\`, not \`pnpm vibase\``)
  }
  return out
}

const PAGES = ['getting-started/quickstart', ...DEPLOYMENT]

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
  it('the install is the registry form on Deploy Vibase and the tarball form, checked against SHA256SUMS, on its own page; the other pages cover the rest', () => {
    const s = page('deployment/self-hosting')
    expect(s).toMatch(/^npm install -g @vibase\/server-d1$/m)
    expect(s).toMatch(/vibase-server setup --env \S+\n/)
    expect(s).toMatch(/--dry-run/)
    const t = page('deployment/release-tarball')
    expect(t).toContain('npm install -g ./vibase-server-d1-<version>.tgz')
    expect(t).toMatch(/SHA256SUMS/)
    expect(t).toMatch(/instead of fetching the package from npm/i)
    expect(page('deployment/from-source')).toContain('pnpm -C packages/server-d1 setup:remote')
    for (const sub of ['setup', 'status', 'upgrade', 'redeploy', 'owner-reset', 'init'])
      expect(allDeployment(), sub).toMatch(new RegExp(`^vibase-server ${sub}\\b`, 'm'))
    for (const w of ['vibase_role', 'device', 'dynamic client registration'])
      expect(page('deployment/clerk').toLowerCase()).toContain(w.toLowerCase())
  })
  it('names where versions are listed and has no Deploy to Cloudflare section (P5)', () => {
    for (const p of PAGES) expect(page(p), p).not.toMatch(/Deploy to Cloudflare/i)
    expect(page('getting-started/quickstart')).toMatch(/Releases page/)
  })

  describe('mutations (the check must see a wrong line)', () => {
    const s = () => page('deployment/manual-setup')
    it('a misspelled flag (--secret-file) in manual-setup is reported', async () => {
      const bad = s().replace('--secrets-file', '--secret-file')
      expect(bad).not.toEqual(s())
      expect((await pageProblems(bad, 'manual-setup')).join('\n')).toMatch(/does not accept --secret-file/)
    })
    it('an unknown subcommand, a pinned version, a tarball of another name and a repo script outside "From source" are reported', async () => {
      const lines =
        '## Elsewhere\n\n```bash\nvibase-server frobnicate --env x\nnpx @vibase/server-d1@0.1.0 status --env x\nnpm i -g ./vibase-0.1.0.tgz\npnpm -C packages/server-d1 setup:remote -- --env x\nvibase contacts nope\n```\n'
      const p = (await pageProblems(lines, 'x')).join('\n')
      expect(p).toMatch(/"frobnicate" is not a vibase-server command/)
      expect(p).toMatch(/literal <version>/)
      expect(p).toMatch(/not D2's name/)
      expect(p).toMatch(/belongs on the "Deploy from source" page/)
      expect(p).toMatch(/"vibase contacts nope" is not a client command/)
    })
  })
})

// [[OPS306]] obligation 6 (D13, cycle 1's part): the install docs describe Better Auth as the default path and say what the program says.
const read = (url: string) => readFileSync(fileURLToPath(new URL(url, import.meta.url)), 'utf8')
// The release and remote command lines moved from AGENTS.md to the ship-branch skill's command reference (#332).
const COMMANDS = () => read('../../../../.agents/skills/ship-branch/SKILL.md')
// The docs' own caveat (Deploy Vibase, Before you start): said in the docs' words, not a program constant.
const FREE_PLAN = ["exceed the Free plan's 10 ms CPU limit", 'has not been measured on Cloudflare']
const has = (md: string, text: string) =>
  md.replace(/\s+/g, ' ').toLowerCase().includes(text.replace(/\s+/g, ' ').toLowerCase())
const setupLines = (md: string) =>
  shellLines(md).filter((l) => / setup(:remote)? /.test(l.line) || /setup:remote/.test(l.line))
const NON_CLERK = () => deployment().filter((d) => d.name !== 'deployment/clerk')

describe('the docs agree with the program on Better Auth (OPS306 D13)', () => {
  const s = () => page('deployment/self-hosting')
  it('self-hosting: the first setup command has no --auth clerk, and no setup command on any page but the Clerk page has it', () => {
    const lines = setupLines(s())
    expect(lines.length).toBeGreaterThan(0)
    expect(lines[0]!.line).not.toContain('--auth clerk')
    for (const d of NON_CLERK()) for (const l of setupLines(d.md)) expect(l.line, d.name).not.toContain('--auth clerk')
  })
  it('the Clerk page: every setup command carries --auth clerk, and there are some', () => {
    const lines = setupLines(page('deployment/clerk'))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(l.line, l.heading).toContain('--auth clerk')
  })
  it('self-hosting: the Better Auth path is the page, no Clerk flag or key is on it and Clerk is a link in its closing list, and Clerk is not required to prepare', () => {
    const md = s()
    const heads = [...md.matchAll(/^##\s+(.*)$/gm)].map((m) => m[1]!)
    expect(heads.some((h) => /claim/i.test(h))).toBe(true)
    const [beforeMore, more] = md.split(/^## More$/m)
    expect(more, 'a More section').toBeDefined()
    expect(beforeMore).not.toMatch(/--auth clerk|CLERK_/)
    expect(more).toMatch(/\]\(\/deployment\/clerk\/\)/)
    expect(md.split(/^## Before you start$/m)[1]!.split(/^## /m)[0]).not.toMatch(/Clerk/)
  })
  it("the no-email statement is the program's constant (on the sign-in page), the Google redirect URI form is there, and Deploy Vibase has the Free-plan caveat", () => {
    const si = page('deployment/sign-in-and-email')
    expect(has(si, NO_EMAIL_STATEMENT)).toBe(true)
    expect(si).toContain('/auth/callback/google')
    for (const part of FREE_PLAN) expect(has(s(), part), part).toBe(true)
  })
  it('self-hosting names the owner invitation link printed once', () => {
    expect(s()).toMatch(/shown once|printed once/i)
  })
  it('the recover-owner page gives the command, says what it prints once, and why the secrets file must be kept (OPS307 D13)', () => {
    const body = page('deployment/recover-owner')
    expect(body).toContain('owner-reset --env <name>')
    expect(body).toMatch(/--email/)
    expect(has(body, 'reset link')).toBe(true)
    expect(has(body, 'invitation')).toBe(true)
    expect(has(body, 'printed once')).toBe(true)
    expect(has(body, 'AUTH_SECRET')).toBe(true)
    expect(has(body, 'keep')).toBe(true)
    expect(has(body, 'Cloudflare credentials')).toBe(true)
    expect(body).toMatch(/--dry-run/)
  })
  it('the source path on the Deploy from source page carries the bootstrap --owner-reset command line, and no other page has one', () => {
    const lines = shellLines(page('deployment/from-source')).filter((l) => l.line.includes('--owner-reset'))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines)
      expect(l.line).toContain(
        'CONFIRM_REMOTE=1 pnpm -C packages/server-d1 bootstrap -- --remote --env <name> --owner-reset',
      )
    for (const d of deployment().filter((x) => x.name !== 'deployment/from-source'))
      expect(
        shellLines(d.md).filter((l) => l.line.includes('bootstrap -- --remote')),
        d.name,
      ).toEqual([])
  })
  it('the ship-branch command reference lists the owner-reset command line', () => {
    const line = COMMANDS()
      .split('\n')
      .find((l) => l.includes('bootstrap -- --remote --env <name> --owner-reset'))
    expect(line).toBeDefined()
    expect(line).toContain('vibase-server owner-reset --env <name>')
  })
  it('the ship-branch command reference: setup:remote takes [--auth better-auth|clerk|none] and says better-auth is the default for a new instance', () => {
    const line = COMMANDS()
      .split('\n')
      .find((l) => l.includes('setup:remote -- --env <name>'))!
    expect(line).toContain('[--auth better-auth|clerk|none]')
    expect(line).toMatch(/`?better-auth`? is the default for a new instance/)
  })
  it('mutation: a docs page that quotes an edited statement is not the constant (the check sees the edit)', () => {
    const edited = NO_EMAIL_STATEMENT.replace('no self-service password reset', 'self-service password reset')
    expect(has(s(), edited)).toBe(false)
  })
})

// [[OPS308]] obligation 6 (D13, the workers.dev part): the docs, both usage lines and release:check's help assertions agree with the program.
describe('the docs and help agree with the program on workers.dev (OPS308 D13)', () => {
  const USAGE = '(--api-host <host> | --workers-dev)'
  /** [[OPS501]] D6: on `vibase-server setup` the pair is optional (a recorded host is the default); `setup:remote` still requires it. */
  const SERVER_USAGE = '[--api-host <host> | --workers-dev]'
  it("the domains page has the no-domain path with --workers-dev, the registration flag as the operator's one-time step, and the move section with its consequences", () => {
    const md = page('deployment/domains')
    expect(md).toMatch(/vibase-server setup --env \S+ --workers-dev /)
    expect(has(md, '--register-workers-subdomain')).toBe(true)
    expect(has(md, 'one-time')).toBe(true)
    const heads = [...md.matchAll(/^##\s+(.*)$/gm)].map((m) => m[1]!)
    expect(heads.some((h) => /move to a custom domain/i.test(h))).toBe(true)
    const body = md.split(/^##\s+Move to a custom domain.*$/im)[1] ?? ''
    expect(body).toMatch(/--api-host \S+ --change-host/)
    for (const w of ['sign in again', 'vibase login', 'reconnect', 'redirect URI']) expect(has(body, w), w).toBe(true)
    expect(body.length).toBeGreaterThan(0)
  })
  it("the ship-branch command reference's setup:remote line takes the host flag pair", () => {
    const line = COMMANDS()
      .split('\n')
      .find((l) => l.includes('setup:remote -- --env <name>'))!
    expect(line).toContain(USAGE)
  })
  it("both usage lines and the setup:remote header name the pair; release:check's help assertion requires it and sees an edited line", () => {
    expect(INSTANCE_HELP).toContain(`vibase-server setup --env <name> ${SERVER_USAGE}`)
    expect(read('../setup-remote.ts')).toContain(USAGE)
    expect(serverHelpProblems(INSTANCE_HELP)).toEqual([])
    expect(serverHelpProblems(INSTANCE_HELP.replace(SERVER_USAGE, '--api-host <host>'))).toEqual([
      `setup --env <name> ${SERVER_USAGE} ... [--dry-run] [--yes]`,
    ])
    expect(serverHelpProblems(INSTANCE_HELP.replace('settings file and secrets file', 'secrets file'))).toEqual([
      'init writes the settings file and the secrets file',
    ])
  })
  it('OPS487 D8: release:check needs both `upgrade --env <name> [--dry-run]` and `redeploy --env <name> [--dry-run]`, and rejects an `upgrade ... [--rollback]` line', () => {
    expect(serverHelpProblems(INSTANCE_HELP)).toEqual([])
    expect(serverHelpProblems(INSTANCE_HELP.replace('vibase-server redeploy --env <name> [--dry-run]', 'x'))).toEqual([
      'redeploy [--dry-run] [--yes] [--schema <path>]',
    ])
    expect(serverHelpProblems(INSTANCE_HELP.replace('vibase-server upgrade --env <name> [--dry-run]', 'x'))).toEqual([
      'upgrade [--dry-run] [--yes] (no --rollback)',
    ])
    expect(
      serverHelpProblems(
        INSTANCE_HELP.replace('upgrade --env <name> [--dry-run]', 'upgrade --env <name> [--dry-run] [--rollback]'),
      ),
    ).toEqual(['upgrade [--dry-run] [--yes] (no --rollback)'])
  })
  it('the setup usage line of the program (printed on a refusal) names the pair', async () => {
    const { runSetup } = await import('./setup.js')
    const err: string[] = []
    await runSetup(['--env', 'x', '--bogus'], { out: () => {}, err: (l: string) => void err.push(l) } as never)
    expect(err.join('\n')).toContain(SERVER_USAGE)
  })
})

describe('OPS493 D6, D7: vibase-server lines carry no CONFIRM_REMOTE; the :remote lines keep it', () => {
  const server = /vibase-server|@vibase\/server-d1@|vibase-server-d1-/
  const offenders = (md: string) =>
    md
      .split('\n')
      .filter((l) => /CONFIRM_REMOTE/.test(l) && server.test(l) && !/:remote|bootstrap -- --remote|pnpm -C/.test(l))
  it('no deployment page has a vibase-server line naming CONFIRM_REMOTE, the :remote lines on the source page still do, and the question is explained', () => {
    for (const d of deployment()) expect(offenders(d.md), d.name).toEqual([])
    expect(page('deployment/from-source')).toMatch(/CONFIRM_REMOTE=1 pnpm -C packages\/server-d1 setup:remote/)
    const md = page('deployment/manual-setup')
    expect(md).toMatch(/proceed\? \[Y\/n\]/)
    expect(md).toMatch(/--yes/)
  })
  it('the server README template: no CONFIRM_REMOTE at all, and it names the question and --yes', () => {
    const md = read('../../../release/templates/server-d1-README.md')
    expect(md).not.toMatch(/CONFIRM_REMOTE/)
    expect(md).toMatch(/proceed\? \[Y\/n\]/)
    expect(md).toMatch(/--yes/)
  })
  it("ship-branch's Command reference: its vibase-server lines have no CONFIRM_REMOTE and tell agents to pass --yes", () => {
    const md = read('../../../../.agents/skills/ship-branch/SKILL.md')
    const lines = md
      .split('\n')
      .filter((l) => /^npx @vibase\/server-d1@<version> (upgrade|redeploy|setup|owner-reset)/.test(l))
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(l).not.toMatch(/CONFIRM_REMOTE/)
    expect(md).toMatch(/agents pass `--yes`/i)
  })
  it('mutation: a vibase-server line with CONFIRM_REMOTE=1 is an offender', () => {
    expect(offenders('CONFIRM_REMOTE=1 npx @vibase/server-d1@<version> setup --env x')).toHaveLength(1)
    expect(offenders('CONFIRM_REMOTE=1 pnpm -C packages/server-d1 setup:remote -- --env x')).toEqual([])
  })
})

// [[OPS496]] D7: setup's verify goes through the Cloudflare API and reads `/health` once; no page claims a wait or a retried read for `vibase-server setup`.
describe('OPS496: the verify description', () => {
  const pages = (): [string, string][] => [
    ['the deployment pages', allDeployment()],
    ['the server README template', read('../../../release/templates/server-d1-README.md')],
  ]
  it.each([0, 1])('page %i: no 300 s, five minute or retries claim about verify', (i) => {
    const [name, md] = pages()[i]!
    expect(md, name).not.toMatch(/300\s?s\b|five minute|verify retries|retries inside/i)
  })
  it('Deploy Vibase names the not-reachable-yet verify outcome as a DNS wait', () => {
    // The page no longer describes the verify's API checks and its single /health read (trimmed in #647); it must not contradict them.
    const md = page('deployment/self-hosting')
    expect(md).toMatch(/not reachable yet/)
    expect(md).toMatch(/DNS/)
  })
})

describe('OPS494 D8: init in the help and the docs', () => {
  it('the help lists init first, in at most five lines, and the Secrets footer mentions it', () => {
    const lines = INSTANCE_HELP.split('\n')
    const at = lines.findIndex((l) => l.startsWith('  vibase-server init'))
    expect(at).toBeGreaterThan(-1)
    expect(lines.findIndex((l) => l.startsWith('  vibase-server status'))).toBeGreaterThan(at)
    let end = at
    while (lines[end] !== '') end++
    expect(end - at).toBeLessThanOrEqual(5)
    expect(lines.find((l) => l.startsWith('Secrets:'))).toMatch(/init/)
    expect(serverHelpProblems(INSTANCE_HELP)).toEqual([])
  })
  it.each([
    [
      'the server README template',
      () => read('../../../release/templates/server-d1-README.md'),
      /vibase-server init --env/,
    ],
    ['self-hosting', () => page('deployment/self-hosting'), /^vibase-server init$/m],
    ['manual-setup', () => page('deployment/manual-setup'), /vibase-server init --env/],
  ])('%s gives the vibase-server init command', (_n, md, re) => {
    expect(md()).toMatch(re)
  })
  const RECIPE = '../../../../knowledge/recipes/deploy-a-new-instance.md'
  it.skipIf(!existsSync(fileURLToPath(new URL(RECIPE, import.meta.url))))(
    "the recipe's step 4 uses vibase-server init",
    () => {
      const md = read(RECIPE)
      const step4 = md.slice(md.indexOf('## 4.'), md.indexOf('## 5.'))
      expect(step4).toMatch(/vibase-server init/)
    },
  )
})

// [[OPS501]] D7: init writes the settings file, and the short form is what the docs and the help show next.
describe('OPS501 D7: the short form in the help and the docs', () => {
  it('the help: init says it writes both files and setup needs only --env after it; at most five init lines', () => {
    const lines = INSTANCE_HELP.split('\n')
    const at = lines.findIndex((l) => l.startsWith('  vibase-server init'))
    let end = at
    while (lines[end] !== '') end++
    expect(end - at).toBeLessThanOrEqual(5)
    expect(lines.slice(at, end).join('\n')).toMatch(/settings file and secrets file/)
    expect(lines.slice(at, end).join('\n')).toMatch(/setup then needs only --env/)
  })
  it('the server README template: the setup line is the short form and the init paragraph names the settings file', () => {
    const md = read('../../../release/templates/server-d1-README.md')
    expect(md).toMatch(/setup --env <name> \[--dry-run\]\n/)
    expect(md).toMatch(/writes the settings file \(the API host, the auth provider and the owner email/)
  })
  it('self-hosting: init writes the settings file and the secrets file; manual-setup says `setup --env mycompany` is the whole command after it', () => {
    const md = page('deployment/self-hosting')
    expect(md).toMatch(/writes two files outside the package/)
    expect(md).toMatch(/the settings file \(.*\) and the secrets file/)
    expect(page('deployment/manual-setup')).toMatch(/`setup --env mycompany` is the whole command/)
  })
  const RECIPE = '../../../../knowledge/recipes/deploy-a-new-instance.md'
  it.skipIf(!existsSync(fileURLToPath(new URL(RECIPE, import.meta.url))))(
    "the recipe's steps 4 and 5 use the short form",
    () => {
      const md = read(RECIPE)
      const step4 = md.slice(md.indexOf('## 4.'), md.indexOf('## 5.'))
      expect(step4).toMatch(/stage: "init"/)
      expect(step4).toMatch(/`setup --env <env>` command it prints/)
      expect(md.slice(md.indexOf('## 5.'))).toMatch(/\nvs setup --env <env> --dry-run\n/)
    },
  )
})

// [[CORE569]]: every schema-file sample in the docs (a fenced json block or an inline `{...}` span with `"version": 1`) is a file the shipped parser accepts.
describe('the schema-file samples in the docs parse', () => {
  const samples = (md: string): string[] => [
    ...[...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!),
    ...[...md.matchAll(/`(\{[^`]*\})`/g)].map((m) => m[1]!),
  ]
  it('guides/schema has samples, and all parse', () => {
    const found = samples(page('guides/schema')).filter((s) => /"version"\s*:\s*1/.test(s))
    expect(found.length).toBeGreaterThan(0)
    for (const s of found) expect(() => parseSchemaFile(s), s).not.toThrow()
  })
  it.each(DEPLOYMENT)('%s: any schema sample on it parses', (p) => {
    for (const s of samples(page(p)).filter((x) => /"version"\s*:\s*1/.test(x)))
      expect(() => parseSchemaFile(s), s).not.toThrow()
  })
})

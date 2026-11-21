// [[OPS237]] D20, P4: the two pages of the docs site tell the truth about the programs. Every `vibase-server` line names a subcommand and only flags the shipped
// parsers accept (asked of the parsers themselves, one flag at a time, not a hand list); every `vibase` line names a real client command (the commands derived
// from the API's own OpenAPI documents, plus the hand commands of the client's help); the tarball names are D2's; the repo-script path is under "From source".
import { existsSync, readFileSync } from 'node:fs'
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

const DOCS = fileURLToPath(new URL('../../../docs/src/content/docs/', import.meta.url))
const page = (p: string) => readFileSync(`${DOCS}${p}.md`, 'utf8')

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
  if (command === '--version') return args.length ? [`${where}: --version takes no arguments`] : []
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
    if (/packages\/server-d1|setup:remote|db:migrate:remote|deploy:remote/.test(line) && heading !== 'From source')
      out.push(`${where}: the repository-script path belongs under "From source"`)
    let m: RegExpExecArray | null
    if ((m = /^npx @vibase\/server-d1@(\S+) (.*)$/.exec(cmd))) {
      if (m[1] !== '<version>') out.push(`${where}: the version must be the literal <version>`)
      out.push(...(await serverProblems(m[2]!.split(/\s+/), where)))
    } else if ((m = /^npx --package \.\/vibase-server-d1-<version>\.tgz vibase-server (.*)$/.exec(cmd)))
      out.push(...(await serverProblems(m[1]!.split(/\s+/), where)))
    else if ((m = /^vibase-server (.*)$/.exec(cmd))) out.push(...(await serverProblems(m[1]!.split(/\s+/), where)))
    else if (/vibase-server|@vibase\/server-d1/.test(cmd))
      out.push(`${where}: a line that names the server package but is not one of its forms`)
    else if ((m = /^npm i(?:nstall)? -g (\S+)$/.exec(cmd))) {
      if (!/^(@vibase\/cli@<version>|\.\/vibase-cli-<version>\.tgz)$/.test(m[1]!))
        out.push(`${where}: the client installs as @vibase/cli@<version> or ./vibase-cli-<version>.tgz`)
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
    for (const sub of ['setup', 'status', 'upgrade', 'redeploy'])
      expect(s).toMatch(new RegExp(`@vibase/server-d1@<version> ${sub} `))
    for (const w of ['vibase_role', 'device', 'dynamic client registration'])
      expect(s.toLowerCase()).toContain(w.toLowerCase())
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
      const lines =
        '## Elsewhere\n\n```bash\nvibase-server frobnicate --env x\nnpx @vibase/server-d1@0.1.0 status --env x\nnpm i -g ./vibase-0.1.0.tgz\npnpm -C packages/server-d1 setup:remote -- --env x\nvibase contacts nope\n```\n'
      const p = (await pageProblems(lines, 'x')).join('\n')
      expect(p).toMatch(/"frobnicate" is not a vibase-server command/)
      expect(p).toMatch(/literal <version>/)
      expect(p).toMatch(/not D2's name/)
      expect(p).toMatch(/belongs under "From source"/)
      expect(p).toMatch(/"vibase contacts nope" is not a client command/)
    })
  })
})

// [[OPS306]] obligation 6 (D13, cycle 1's part): the install docs describe Better Auth as the default path and say what the program says.
const read = (url: string) => readFileSync(fileURLToPath(new URL(url, import.meta.url)), 'utf8')
const README = () => read('../../README.md')
// The release and remote command lines moved from AGENTS.md to the ship-branch skill's command reference (#332).
const COMMANDS = () => read('../../../../.agents/skills/ship-branch/SKILL.md')
const FREE_PLAN =
  "one password hash may exceed the Workers Free plan's 10 ms CPU limit; Workers Paid is the safe plan for password sign-in until it is measured on Cloudflare"
const has = (md: string, text: string) =>
  md.replace(/\s+/g, ' ').toLowerCase().includes(text.replace(/\s+/g, ' ').toLowerCase())
const setupLines = (md: string) =>
  shellLines(md).filter((l) => / setup(:remote)? /.test(l.line) || /setup:remote/.test(l.line))
const CLERK_HEADING = /clerk/i

describe('the docs agree with the program on Better Auth (OPS306 D13)', () => {
  const s = () => page('deployment/self-hosting')
  it('self-hosting: the first setup command has no --auth clerk, and no setup command before the Clerk section has it', () => {
    const lines = setupLines(s())
    expect(lines.length).toBeGreaterThan(0)
    expect(lines[0]!.line).not.toContain('--auth clerk')
    for (const l of lines.filter((x) => !CLERK_HEADING.test(x.heading)))
      expect(l.line, l.heading).not.toContain('--auth clerk')
  })
  it('self-hosting: every setup command in the Clerk section carries --auth clerk, and there is one', () => {
    const lines = setupLines(s()).filter((x) => CLERK_HEADING.test(x.heading))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(l.line, l.heading).toContain('--auth clerk')
  })
  it('self-hosting: the Better Auth path comes before the Clerk section, and Clerk is not required to prepare', () => {
    const md = s()
    const heads = [...md.matchAll(/^##\s+(.*)$/gm)].map((m) => m[1]!)
    const clerk = heads.findIndex((h) => CLERK_HEADING.test(h))
    const betterAuth = heads.findIndex((h) => /better auth|owner invitation|claim/i.test(h))
    expect(betterAuth).toBeGreaterThanOrEqual(0)
    expect(clerk).toBeGreaterThan(betterAuth)
    expect(md.split(/^## Prepare your accounts$/m)[1]!.split(/^## /m)[0]).not.toMatch(/Clerk/)
  })
  it.each([
    ['self-hosting', () => s()],
    ['the server-d1 README', () => README()],
  ])(
    "%s: the no-email statement is the program's constant, the Google redirect URI form and the Free-plan sentence are there",
    (_n, md) => {
      expect(has(md(), NO_EMAIL_STATEMENT)).toBe(true)
      expect(md()).toContain('/auth/callback/google')
      expect(has(md(), FREE_PLAN)).toBe(true)
    },
  )
  it('the server-d1 README: the first setup command has no --auth clerk, and a Clerk command carries it', () => {
    const lines = setupLines(README())
    expect(lines[0]!.line).not.toContain('--auth clerk')
    expect(lines.some((l) => l.line.includes('--auth clerk'))).toBe(true)
  })
  it('self-hosting names the owner invitation link printed once', () => {
    expect(s()).toMatch(/shown once|printed once/i)
  })
  it.each([
    ['self-hosting', () => s()],
    ['the server-d1 README', () => README()],
  ])(
    '%s: an owner-reset section gives the command, says what it prints once, and why the secrets file must be kept (OPS307 D13)',
    (_n, md) => {
      const text = md()
      const section = /^#{2,3}\s+.*(owner-reset|recover).*$/im.exec(text)
      expect(section, 'a heading naming owner-reset or recovery').not.toBeNull()
      const body = text.slice(section!.index).split(/^## /m)[0]!
      expect(body).toContain('owner-reset --env <name>')
      expect(body).toMatch(/--email/)
      expect(has(body, 'reset link')).toBe(true)
      expect(has(body, 'invitation')).toBe(true)
      expect(has(body, 'printed once')).toBe(true)
      expect(has(body, 'AUTH_SECRET')).toBe(true)
      expect(has(body, 'keep')).toBe(true)
      expect(has(body, 'Cloudflare credentials')).toBe(true)
      expect(body).toMatch(/--dry-run/)
    },
  )
  it('self-hosting: the source path under "From source" carries the bootstrap --owner-reset command line', () => {
    const lines = shellLines(s()).filter((l) => l.line.includes('--owner-reset'))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) {
      expect(l.heading).toBe('From source')
      expect(l.line).toContain(
        'CONFIRM_REMOTE=1 pnpm -C packages/server-d1 bootstrap -- --remote --env <name> --owner-reset',
      )
    }
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
  const s = () => page('deployment/self-hosting')
  const USAGE = '(--api-host <host> | --workers-dev)'
  it("self-hosting has the no-domain path with --workers-dev, the registration flag as the operator's one-time step, and the move section with its consequences", () => {
    const md = s()
    expect(md).toMatch(/npx @vibase\/server-d1@<version> setup --env \S+ --workers-dev /)
    expect(has(md, '--register-workers-subdomain')).toBe(true)
    expect(has(md, 'one-time')).toBe(true)
    const heads = [...md.matchAll(/^##\s+(.*)$/gm)].map((m) => m[1]!)
    expect(heads.some((h) => /moving to a custom domain/i.test(h))).toBe(true)
    const body = md.slice(md.search(/^##\s+Moving to a custom domain/im)).split(/^## /m)[1] ?? ''
    expect(md).toMatch(/--api-host \S+ --change-host/)
    for (const w of ['sign in again', 'vibase login', 'reconnect', 'redirect URI']) expect(has(md, w), w).toBe(true)
    expect(body.length).toBeGreaterThan(0)
  })
  it("the server-d1 README has the no-domain path and the move, and the ship-branch command reference's setup:remote line takes the host flag pair", () => {
    expect(README()).toMatch(/--workers-dev/)
    expect(README()).toMatch(/--change-host/)
    const line = COMMANDS()
      .split('\n')
      .find((l) => l.includes('setup:remote -- --env <name>'))!
    expect(line).toContain(USAGE)
  })
  it("both usage lines and the setup:remote header name the pair; release:check's help assertion requires it and sees an edited line", () => {
    expect(INSTANCE_HELP).toContain(`vibase-server setup --env <name> ${USAGE}`)
    expect(read('../setup-remote.ts')).toContain(USAGE)
    expect(serverHelpProblems(INSTANCE_HELP)).toEqual([])
    expect(serverHelpProblems(INSTANCE_HELP.replace(USAGE, '--api-host <host>'))).toEqual([
      `setup --env <name> ${USAGE} ... [--dry-run] [--yes]`,
    ])
  })
  it('OPS487 D8: release:check needs both `upgrade --env <name> [--dry-run]` and `redeploy --env <name> [--dry-run]`, and rejects an `upgrade ... [--rollback]` line', () => {
    expect(serverHelpProblems(INSTANCE_HELP)).toEqual([])
    expect(serverHelpProblems(INSTANCE_HELP.replace('vibase-server redeploy --env <name> [--dry-run]', 'x'))).toEqual([
      'redeploy [--dry-run] [--yes]',
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
    expect(err.join('\n')).toContain(USAGE)
  })
})

describe('OPS493 D6, D7: vibase-server lines carry no CONFIRM_REMOTE; the :remote lines keep it', () => {
  const server = /vibase-server|@vibase\/server-d1@|vibase-server-d1-/
  const offenders = (md: string) =>
    md
      .split('\n')
      .filter((l) => /CONFIRM_REMOTE/.test(l) && server.test(l) && !/:remote|bootstrap -- --remote|pnpm -C/.test(l))
  it('self-hosting: no vibase-server or npx @vibase/server-d1 line names CONFIRM_REMOTE, the :remote lines still do, and the question is explained', () => {
    const md = page('deployment/self-hosting')
    expect(offenders(md)).toEqual([])
    expect(md).toMatch(/CONFIRM_REMOTE=1 pnpm -C packages\/server-d1 setup:remote/)
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
    ['self-hosting.md', page('deployment/self-hosting')],
    ['the server README template', read('../../../release/templates/server-d1-README.md')],
  ]
  it.each([0, 1])('page %i: no 300 s, five minute or retries claim about verify', (i) => {
    const [name, md] = pages()[i]!
    expect(md, name).not.toMatch(/300\s?s\b|five minute|verify retries|retries inside/i)
  })
  it('self-hosting.md describes the API checks, the single read and the DNS note', () => {
    const md = page('deployment/self-hosting')
    expect(md).toMatch(/Verify asks the Cloudflare API, not your host/)
    expect(md).toMatch(/one request to `https:\/\/<your host>\/health`/)
    expect(md).toMatch(/not reachable yet/)
    expect(md).toMatch(/DNS propagation/)
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
    ['the server README template', () => read('../../../release/templates/server-d1-README.md')],
    ['self-hosting', () => page('deployment/self-hosting')],
  ])('%s gives the vibase-server init command', (_n, md) => {
    expect(md()).toMatch(/vibase-server init --env/)
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

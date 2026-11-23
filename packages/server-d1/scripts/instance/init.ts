// `vibase-server init` ([[OPS494]]): asks for (or takes as flags) the instance's name, host, owner email, auth and email providers, then writes its settings file and its secrets file: generated
// secrets in, an empty line for every value only the person can supply, never overwritten. Local only: nothing here touches Cloudflare, Google or Clerk.
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { CALLBACK_PATH, isValidPushVar } from '@vibase/api'
import { RemoteRefusal } from '../remote.js'
import {
  apiHostProblem,
  authProblem,
  checkNameLengths,
  derivedNames,
  emailProblem,
  envNameProblem,
} from '../setup/args.js'
import { newAuthSecret, type AuthProvider } from '../setup/better-auth.js'
import { ABORT_LINE, confirmProceed } from './prompt.js'
import { defaultSecretsPath } from './secrets.js'
import { defaultSettingsPath, initSettingsText, loadAnySettings, writeFileAtomic } from './settings.js'
import { InstanceRefusal, isRefusal, type InstanceDeps } from './types.js'

export const USAGE =
  'usage: vibase-server init [--env <name>] [--api-host <host>] [--owner-email <email>] [--auth better-auth|clerk|none] [--email gmail|none] [--gcp-project <id>] [--secrets-file <path>] [--yes]'
const EXIT_DONE = 0
const EXIT_REFUSED = 2

export interface InitInputs {
  env: string
  apiHost: string
  ownerEmail?: string
  auth: AuthProvider
  gmail: boolean
  gcpProject?: string
}

/** `--email`: a comma-separated list of `gmail`, or `none`. */
function emailProvidersProblem(v: string): { gmail: boolean } | string {
  const parts = v.split(',').map((p) => p.trim())
  if (parts.length === 1 && parts[0] === 'none') return { gmail: false }
  if (parts.every((p) => p === 'gmail')) return { gmail: true }
  return `--email ${v}: expected gmail (more are coming) or none`
}
/** The derived names are setup's: the Workflow's is the longest of the four, so the env is judged against all five ([[OPS262]] D5). */
function envLengthProblem(env: string): string | null {
  try {
    checkNameLengths(Object.values(derivedNames(env)))
    return null
  } catch (e) {
    return `--env ${env}: ${(e as Error).message}`
  }
}

/** The file ops `createSecretsFile` uses; a test swaps one to make a write fail. */
export type FileOps = Pick<
  typeof fs,
  'mkdirSync' | 'openSync' | 'writeSync' | 'fchmodSync' | 'closeSync' | 'unlinkSync'
>

/** Creates the file exclusively at mode 600 (its parent, when missing, at 700). A write that fails part-way removes the file; a file that exists is never opened for writing. */
export function createSecretsFile(path: string, text: string, ops: FileOps = fs): void {
  ops.mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  let fd: number
  try {
    fd = ops.openSync(path, 'wx', 0o600)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST')
      throw new InstanceRefusal(`${path} already exists: edit it instead (init never overwrites a file)`)
    throw e
  }
  try {
    ops.fchmodSync(fd, 0o600)
    ops.writeSync(fd, text)
  } catch (e) {
    try {
      ops.closeSync(fd)
    } catch {}
    try {
      ops.unlinkSync(path)
    } catch {}
    throw e
  }
  ops.closeSync(fd)
}

export interface Generated {
  authSecret: string
  credentialsKey: string
  oauthStateSecret: string
}
export const generate = (): Generated => ({
  authSecret: newAuthSecret(),
  credentialsKey: randomBytes(32).toString('base64'),
  oauthStateSecret: randomBytes(32).toString('base64'),
})

/** The file's text ([[OPS494]] D4): groups by choice, each value under a one-line comment; supplied values are empty assignments. */
export function buildSecretsText(i: InitInputs, g: Generated): string {
  const L: string[] = [
    `# Secrets for the Vibase instance "${i.env}" (${i.apiHost}). Fill in the empty values, then run the setup command init printed. Mode 600: keep it private.`,
    '',
    '# Cloudflare: the account to deploy to, and an API token for it (its scopes are in the @vibase/server-d1 README).',
    'CLOUDFLARE_ACCOUNT_ID=',
    'CLOUDFLARE_API_TOKEN=',
  ]
  const google = (id: string, secret: string, uri: string) => [
    `# A Google Web OAuth client; add the redirect URI ${uri}. The id ends .apps.googleusercontent.com, the secret starts GOCSPX-.`,
    `${id}=`,
    `${secret}=`,
  ]
  if (i.auth === 'better-auth')
    L.push(
      '',
      '# Better Auth: signs sessions. Generated; never replace it (a new value signs everyone out).',
      `AUTH_SECRET=${g.authSecret}`,
      '',
      '# Google sign-in (optional; both values or neither).',
      ...google('AUTH_GOOGLE_CLIENT_ID', 'AUTH_GOOGLE_CLIENT_SECRET', `https://${i.apiHost}/auth/callback/google`),
    )
  if (i.auth === 'clerk')
    L.push(
      '',
      "# Clerk: this instance's keys, from the Clerk dashboard's API keys page.",
      'CLERK_SECRET_KEY=',
      'CLERK_PUBLISHABLE_KEY=',
    )
  if (i.gmail) {
    const p = i.gcpProject ?? '<project-id>'
    const push = [
      `GMAIL_TOPIC_NAME=projects/${p}/topics/gmail.watch.${i.env}`,
      `GMAIL_PUSH_SUBSCRIPTION=projects/${p}/subscriptions/gmail.push.${i.env}`,
      `GMAIL_PUSH_SERVICE_ACCOUNT=gmail-push@${p}.iam.gserviceaccount.com`,
    ]
    L.push(
      '',
      '# Gmail stays off until both Google client values are set. The sign-in client is fine: add the Gmail redirect URI to it.',
      ...google('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', `https://${i.apiHost}${CALLBACK_PATH}`),
      '# Encrypts stored mailbox credentials. Generated; back it up (losing it makes connected mailboxes unreadable) and never replace it.',
      `CREDENTIALS_KEY=${g.credentialsKey}`,
      '# Signs the connect flow. Generated.',
      `OAUTH_STATE_SECRET=${g.oauthStateSecret}`,
      '',
      i.gcpProject
        ? '# Live Gmail push (optional), from the Google Cloud project given to init.'
        : '# Live Gmail push (optional): replace <project-id> and uncomment all three.',
      ...push.map((l) => (i.gcpProject ? l : `# ${l}`)),
    )
  }
  return `${L.join('\n')}\n`
}

const shellWord = (v: string): string => (/^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replaceAll("'", `'\\''`)}'`)

export async function runInit(argv: string[], deps: InstanceDeps): Promise<number> {
  try {
    return await init(argv, deps)
  } catch (e) {
    if (!isRefusal(e)) throw e
    deps.err(`vibase-server init: ${(e as Error).message}`)
    return EXIT_REFUSED
  }
}

/** A judged input: the problem to print, or the value. */
type Judged<T> = { problem: string } | { ok: T }
const judged = <T>(problem: string | null, ok: () => T): Judged<T> => (problem ? { problem } : { ok: ok() })
type Aborted = typeof ABORTED
const ABORTED = Symbol('aborted')

async function init(argv: string[], deps: InstanceDeps): Promise<number> {
  let v: ReturnType<typeof parseArgs>['values']
  try {
    v = parseArgs({
      args: argv.filter((a) => a !== '--'),
      options: {
        env: { type: 'string' },
        'api-host': { type: 'string' },
        'owner-email': { type: 'string' },
        auth: { type: 'string' },
        email: { type: 'string' },
        'gcp-project': { type: 'string' },
        'secrets-file': { type: 'string' },
        yes: { type: 'boolean', short: 'y' },
      },
      strict: true,
    }).values
  } catch (e) {
    throw new InstanceRefusal(`${e instanceof Error ? e.message : 'bad arguments'}; ${USAGE}`)
  }
  const flag = (k: string) => v[k] as string | undefined
  const terminal = deps.question.interactive

  // One input: from its flag (a bad value is a refusal naming it), else asked on a terminal (a bad answer prints the rule and asks again), else its default or a refusal.
  async function input<T>(o: {
    flag: string
    prompt: string
    judge: (value: string) => Judged<T>
    fallback?: () => T | undefined
    optional?: boolean
  }): Promise<T | Aborted> {
    const given = flag(o.flag)
    const check = o.judge
    if (given !== undefined) {
      const r = check(given)
      if ('problem' in r) throw new InstanceRefusal(r.problem)
      return r.ok
    }
    if (terminal) {
      for (;;) {
        const a = await deps.question.ask(o.prompt)
        if (a === null) return ABORTED
        const t = a.trim()
        if (t === '') {
          const f = o.fallback?.()
          if (f !== undefined) return f
          if (o.optional) return undefined as T
          deps.err(`--${o.flag} is required`)
          continue
        }
        const r = check(t)
        if ('problem' in r) {
          deps.err(r.problem)
          continue
        }
        return r.ok
      }
    }
    const f = o.fallback?.()
    if (f !== undefined) return f
    if (o.optional) return undefined as T
    throw new InstanceRefusal(`--${o.flag} is required (no terminal to ask on); ${USAGE}`)
  }
  const bail = () => {
    deps.out(ABORT_LINE)
    return EXIT_DONE
  }

  const env = await input<string>({
    flag: 'env',
    prompt: 'instance name (lower-case letters, digits, dashes): ',
    judge: (x) => judged(envNameProblem(x) ?? envLengthProblem(x), () => x),
  })
  if (env === ABORTED) return bail()
  const apiHost = await input<string>({
    flag: 'api-host',
    prompt: 'API host (a domain on your Cloudflare account, e.g. api.example.com): ',
    judge: (x) => judged(apiHostProblem(x), () => x),
  })
  if (apiHost === ABORTED) return bail()
  // Owner email follows the auth choice ([[OPS494]] D1): optional only when `--auth none` is given; asked before auth is, it is otherwise required.
  const ownerOptional = flag('auth') === 'none'
  const ownerEmail = await input<string | undefined>({
    flag: 'owner-email',
    prompt: `owner email${ownerOptional ? ' (optional)' : ''}: `,
    judge: (x) => judged(emailProblem(x), () => x),
    optional: ownerOptional,
  })
  if (ownerEmail === ABORTED) return bail()
  const auth = await input<AuthProvider>({
    flag: 'auth',
    prompt: 'auth provider (better-auth, clerk, none) [better-auth]: ',
    judge: (x) => judged(authProblem(x), () => x as AuthProvider),
    fallback: () => 'better-auth',
  })
  if (auth === ABORTED) return bail()
  if (ownerEmail === undefined && auth !== 'none')
    throw new InstanceRefusal(`--owner-email is required with --auth ${auth} (the first owner is invited); ${USAGE}`)
  const mail = await input<{ gmail: boolean }>({
    flag: 'email',
    prompt: 'email providers (gmail, none) [gmail]: ',
    judge: (x) => {
      const r = emailProvidersProblem(x)
      return typeof r === 'string' ? { problem: r } : { ok: r }
    },
    fallback: () => ({ gmail: true }),
  })
  if (mail === ABORTED) return bail()
  const gcpProject = flag('gcp-project')
  if (gcpProject !== undefined) {
    if (!mail.gmail) throw new InstanceRefusal('--gcp-project only applies with Gmail (--email gmail)')
    const probe = `projects/${gcpProject}/topics/x`
    if (!isValidPushVar('GMAIL_TOPIC_NAME', probe))
      throw new InstanceRefusal(`--gcp-project ${gcpProject}: not a Google Cloud project id`)
  }
  const inputs: InitInputs = { env, apiHost, ownerEmail, auth, gmail: mail.gmail, gcpProject }

  // Every refusal runs before the summary and the question.
  const path = flag('secrets-file') ?? defaultSecretsPath(deps.env, deps.homedir, env)
  if (exists(path)) throw new InstanceRefusal(`${path} already exists: edit it instead (init never overwrites a file)`)
  const settingsPath = defaultSettingsPath(deps.env, deps.homedir, env)
  // [[OPS501]] D2: a full record is a set-up instance (its secrets must not be regenerated); a file init wrote is replaced; anything else cannot be read as either.
  let replacing = false
  if (exists(settingsPath)) {
    let parsed: ReturnType<typeof loadAnySettings>
    try {
      parsed = loadAnySettings(settingsPath, env, { allowNoControl: true })
    } catch (e) {
      throw new InstanceRefusal(
        `${settingsPath} exists but is neither an init-written file nor a set-up instance's record (${(e as Error).message}): fix or remove it`,
      )
    }
    if (parsed.kind === 'full')
      throw new InstanceRefusal(
        `${env} is already set up (${settingsPath} exists): restore the secrets file you kept; do not regenerate it (a new AUTH_SECRET or CREDENTIALS_KEY would not match the Worker's)`,
      )
    replacing = true
  }

  deps.out(`init: will write ${path}`)
  deps.out(`init: will ${replacing ? 'replace' : 'write'} ${settingsPath}${replacing ? ' (written by init)' : ''}`)
  deps.out(
    `  env ${env}, api host ${apiHost}, owner email ${ownerEmail ?? '(none)'}, auth ${auth}, email ${mail.gmail ? 'gmail' : 'none'}`,
  )
  if (!(await confirmProceed(deps, v.yes === true))) {
    deps.out(ABORT_LINE)
    return EXIT_DONE
  }

  // The settings file first: a leftover init-written file is harmless and replaced by a rerun, a leftover secrets file would block it.
  writeFileAtomic(settingsPath, initSettingsText({ env, api_host: apiHost, auth, owner_email: ownerEmail }))
  const g = generate()
  createSecretsFile(path, buildSecretsText(inputs, g))

  const generated = [
    ...(auth === 'better-auth' ? ['AUTH_SECRET'] : []),
    ...(mail.gmail ? ['CREDENTIALS_KEY', 'OAUTH_STATE_SECRET'] : []),
  ]
  deps.out(`wrote ${path} (mode 600)`)
  deps.out(`wrote ${settingsPath}`)
  if (generated.length > 0)
    deps.out(
      `generated: ${generated.join(', ')}${mail.gmail ? ' (back it up: losing CREDENTIALS_KEY makes connected mailboxes unreadable)' : ''}`,
    )
  const fill = [
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_TOKEN',
    ...(auth === 'clerk' ? ['CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY'] : []),
  ]
  const off = [...(auth === 'better-auth' ? ['Google sign-in'] : []), ...(mail.gmail ? ['Gmail'] : [])]
  deps.out(
    `fill in: ${fill.join(', ')}${off.length > 0 ? `; ${off.join(' and ')} stay off until their Google values are added` : ''}`,
  )
  // [[OPS501]] D7: setup reads the host, provider and owner email from the settings file; only a secrets file at a non-default path is repeated.
  deps.out('next:')
  deps.out(
    `  vibase-server setup --env ${env}${flag('secrets-file') ? ` --secrets-file ${shellWord(flag('secrets-file')!)}` : ''}`,
  )
  return EXIT_DONE
}

/** True when anything (a file, a link, a dangling link) is at the path. */
function exists(path: string): boolean {
  try {
    fs.lstatSync(path)
    return true
  } catch {
    return false
  }
}

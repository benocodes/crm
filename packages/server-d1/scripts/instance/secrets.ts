// The instance secrets file ([[OPS210]] D10, [[OPS231]]): dotenv, refused when group- or world-accessible. Values leave this module only inside the
// wrangler child's environment; `redact` is how any child output is made printable.
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { instancesDir } from './settings.js'
import { InstanceRefusal } from './types.js'

export interface Secrets {
  CLOUDFLARE_ACCOUNT_ID: string
  CLOUDFLARE_API_TOKEN: string
  /** The file's own text (`''` when there is none): `setup` reads its Clerk and Gmail values from it ([[OPS232]] P1). Never printed. */
  text: string
  /** Replaces every secret value in `text` (a wrangler failure's output) before it is printed. */
  redact(text: string): string
}

export const defaultSecretsPath = (env: Record<string, string | undefined>, homedir: string, envName: string): string => join(instancesDir(env, homedir), `${envName}.env`)

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2]!.trim()
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1)
    out[m[1]!] = v
  }
  return out
}

const NAMES = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'] as const
/** Values shorter than this are not masked: they are not secrets, and masking them would mangle any output. */
const MIN_MASKED = 4

export function loadSecrets(path: string, env: Record<string, string | undefined>): Secrets {
  const fromEnv = (n: (typeof NAMES)[number]) => (env[n] ? env[n] : undefined)
  let file: Record<string, string> = {}
  let text = ''
  let stat: ReturnType<typeof statSync> | undefined
  try {
    stat = statSync(path)
  } catch {
    stat = undefined
  }
  if (stat === undefined) {
    // The process environment alone may supply both Cloudflare names ([[OPS210]] D10).
    if (!NAMES.every((n) => fromEnv(n))) throw new InstanceRefusal(`no secrets file at ${path}: create it (mode 600) with ${NAMES.join(' and ')}, or pass --secrets-file <path>`)
  } else {
    if ((stat.mode & 0o077) !== 0) throw new InstanceRefusal(`${path} is accessible by group or others (mode ${(stat.mode & 0o777).toString(8)}): run chmod 600 on it`)
    text = readFileSync(path, 'utf8')
    file = parseDotenv(text)
  }
  const value = (n: (typeof NAMES)[number]): string => {
    const v = fromEnv(n) ?? (file[n] ? file[n] : undefined)
    if (v === undefined) throw new InstanceRefusal(`${n} is not set: put it in ${path} or the process environment`)
    return v
  }
  const CLOUDFLARE_ACCOUNT_ID = value('CLOUDFLARE_ACCOUNT_ID')
  const CLOUDFLARE_API_TOKEN = value('CLOUDFLARE_API_TOKEN')
  const masked = [...new Set([CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, ...Object.values(file), ...NAMES.map((n) => fromEnv(n) ?? '')].filter((v) => v.length >= MIN_MASKED))].sort((a, b) => b.length - a.length)
  return { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, text, redact: (text) => masked.reduce((t, v) => t.split(v).join('***'), text) }
}

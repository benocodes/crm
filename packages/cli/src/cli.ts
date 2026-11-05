import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { cacheDirPath, configPath, loadConfig, profileName, resolveConnection, saveConfig, serverOrigin, type Config } from './config.js'
import { deriveCommands } from './derive.js'
import { discover } from './discovery.js'
import { CliError, usage } from './errors.js'
import { commandHelp, resourceHelp, topHelp } from './help.js'
import { apiError, execute, json } from './http.js'
import { deviceGrant, ensureFresh, fetchAuthServer, getJson, refreshProfile, revokeRefreshToken, withLock } from './oauth.js'
import { GLOBAL_VALUE_FLAGS, parseInvocation } from './invoke.js'
import type { Command, Deps } from './types.js'

/**
 * Splits the command words (the first two non-flag tokens, flags' values skipped) from the rest, which keeps its order.
 * Command words come first: `vibase contacts list --limit 5`.
 */
function splitWords(argv: string[]): { words: string[]; rest: string[]; first: number } {
  const words: string[] = []
  const rest: string[] = []
  let first = -1
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!
    if (tok === '--') {
      rest.push(...argv.slice(i))
      break
    }
    if (tok.startsWith('-')) {
      rest.push(tok)
      if ((GLOBAL_VALUE_FLAGS as readonly string[]).includes(tok) && i + 1 < argv.length) rest.push(argv[++i]!)
    } else if (words.length < 2) {
      if (words.length === 0) first = i
      words.push(tok)
    } else rest.push(tok)
  }
  return { words, rest, first }
}

/** The flags every command shares, read leniently (the command's own flags are parsed after it is known). */
function globals(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    strict: false,
    allowPositionals: true,
    options: { server: { type: 'string' }, profile: { type: 'string' }, refresh: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' } },
  })
  const s = (v: unknown) => (typeof v === 'string' ? v : undefined)
  return { server: s(values.server), profile: s(values.profile), refresh: values.refresh === true, help: values.help === true, version: values.version === true }
}

/** Runs one command line and returns the exit code. Never throws, never exits the process. */
export async function run(argv: string[], deps: Deps): Promise<number> {
  try {
    return await main(argv, deps)
  } catch (e) {
    if (e instanceof CliError) {
      await json(deps, 'stderr', { error: { code: e.code, message: e.message } })
      return e.exit
    }
    await json(deps, 'stderr', { error: { code: 'internal', message: e instanceof Error ? e.message : 'unexpected failure' } })
    return 1
  }
}

async function main(argv: string[], deps: Deps): Promise<number> {
  const g = globals(argv)
  if (g.version) {
    await deps.stdout.write(`vibase-cli/${deps.version}\n`)
    return 0
  }
  const { words, rest, first } = splitWords(argv)
  const others = argv.filter((_, i) => i !== first)
  switch (words[0]) {
    case 'login':
      return login(others, deps)
    case 'logout':
      return logout(others, deps)
    case 'config':
      return configCommand(words[1], rest, deps)
  }

  const cfg = loadConfig(configPath(deps))
  const wantsHelp = g.help || words.length === 0
  // Help and unknown commands need the instance but no credential; running one needs both.
  let conn: ReturnType<typeof resolveConnection>
  try {
    conn = resolveConnection(cfg, g, deps.env, { needKey: false })
  } catch (e) {
    if (wantsHelp && words.length === 0 && e instanceof CliError && e.code === 'no_server') {
      await deps.stdout.write(topHelp(undefined))
      return 0
    }
    throw e
  }
  const cacheDir = cacheDirPath(deps)
  let found = await discover(conn.server, deps, { cacheDir, refresh: g.refresh })
  const lookup = (cmds: Command[]) => cmds.find((c) => c.resource === words[0]!.replace(/_/g, '-') && c.action === (words[1] ?? '').replace(/_/g, '-'))
  let commands = deriveCommands(found.ops)

  if (words.length === 0) {
    await deps.stdout.write(topHelp(commands, conn.server))
    return 0
  }
  let cmd = words.length === 2 ? lookup(commands) : undefined
  if (words.length === 1 || g.help) {
    const resource = words[0]!.replace(/_/g, '-')
    let of = commands.filter((c) => c.resource === resource)
    // A stale cache may predate the resource: refresh once before deciding it does not exist, so one word answers as on a fresh cache.
    if (words.length === 1 && of.length === 0 && !found.fresh) {
      found = await discover(conn.server, deps, { cacheDir, refresh: true })
      commands = deriveCommands(found.ops)
      of = commands.filter((c) => c.resource === resource)
    }
    if (words.length === 2 && !cmd && !found.fresh) {
      found = await discover(conn.server, deps, { cacheDir, refresh: true })
      commands = deriveCommands(found.ops)
      cmd = lookup(commands)
    }
    if (cmd) {
      await deps.stdout.write(commandHelp(cmd))
      return 0
    }
    if (of.length > 0) {
      await deps.stdout.write(resourceHelp(resource, of))
      return g.help ? 0 : 2
    }
    if (g.help) {
      await deps.stdout.write(topHelp(commands, conn.server))
      return 0
    }
  }
  if (!cmd && !found.fresh) {
    found = await discover(conn.server, deps, { cacheDir, refresh: true })
    commands = deriveCommands(found.ops)
    cmd = lookup(commands)
  }
  if (!cmd) throw usage(`unknown command "${words.join(' ')}" on ${conn.server}: run \`vibase --help\` to list the commands`)

  const inv = await parseInvocation(cmd, rest, { readFile: (p) => readFile(p, 'utf8'), readStdin: () => deps.readStdin() })
  const withKey = resolveConnection(cfg, g, deps.env, { needKey: true })
  if (!withKey.oauth) return execute(cmd, inv, { server: withKey.server, key: withKey.key! }, deps)
  // An OAuth grant: refreshed ahead of expiry, and once more when the server answers 401 (D20).
  const fresh = await ensureFresh(deps, withKey.profile, withKey.oauth)
  const refresh = async (rejected: string) => (await refreshProfile(deps, withKey.profile, { kind: 'rejected', stale: rejected })).access_token
  return execute(cmd, inv, { server: withKey.server, key: fresh.access_token, refresh }, deps)
}

const SECRET_ARG = 'login reads the key from stdin only: `printf %s "$KEY" | vibase login --api-key --server <url> [--profile <name>]`'

async function login(args: string[], deps: Deps): Promise<number> {
  let values: { 'api-key'?: boolean; server?: string; profile?: string; scope?: string }
  try {
    const parsed = parseArgs({ args, options: { 'api-key': { type: 'boolean' }, server: { type: 'string' }, profile: { type: 'string' }, scope: { type: 'string' } }, allowPositionals: true })
    // Anything else on the line might be the key: refuse without echoing it.
    if (parsed.positionals.length > 0) throw new Error('positional')
    values = parsed.values
  } catch {
    throw usage(`login takes --server, --profile and --scope, or --api-key with --server and --profile. ${SECRET_ARG}`)
  }
  if (values['api-key'] && values.scope !== undefined) throw usage('--scope applies to device login, not to --api-key')
  const rawServer = values.server ?? (deps.env.VIBASE_SERVER || undefined)
  if (!rawServer) throw usage('login needs --server <url> (or VIBASE_SERVER)')
  const server = serverOrigin(rawServer)
  const name = profileName(values.profile ?? (deps.env.VIBASE_PROFILE || undefined) ?? 'default')
  const path = configPath(deps)
  if (!values['api-key']) return deviceLogin(server, name, values.scope, deps)
  const cfg = loadConfig(path)
  if (deps.stdinIsTTY) throw usage(`stdin is a terminal. ${SECRET_ARG}`)
  const key = (await deps.readStdin()).trim()
  if (key === '' || /\s/.test(key) || key.length > 512) throw usage('stdin must hold the API key and nothing else')
  cfg.profiles[name] = { kind: 'api_key', server, api_key: key }
  cfg.default_profile ??= name
  saveConfig(path, cfg)
  await json(deps, 'stdout', { profile: name, server })
  return 0
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== ''

/** Device login ([[API6]] D11, D19): every refusal comes before the device request, and nothing is stored until the grant succeeds. */
async function deviceLogin(server: string, name: string, scopeFlag: string | undefined, deps: Deps): Promise<number> {
  const path = configPath(deps)
  loadConfig(path) // a malformed or world-readable config is refused before the user is asked to approve anything
  const wkUrl = `${server}/.well-known/vibase`
  const wk = await getJson(wkUrl, deps)
  if (wk.status !== 200 || typeof wk.body !== 'object' || wk.body === null) throw usage(`${wkUrl} answered ${wk.status}: this does not look like a vault instance`, 'discovery_failed')
  const auth = wk.body.auth
  if (!auth || typeof auth !== 'object' || !nonEmpty(auth.cli_client_id) || !nonEmpty(auth.issuer)) {
    throw usage(`this instance accepts API keys only (no sign-in is configured for the CLI): use \`vibase login --api-key --server ${server}\``, 'api_keys_only')
  }
  const prUrl: unknown = auth.protected_resource_metadata ?? `${server}/.well-known/oauth-protected-resource`
  if (!nonEmpty(prUrl) || new URL(prUrl, server).origin !== server) throw usage(`${wkUrl} names the protected-resource metadata at ${String(prUrl).slice(0, 200)}, which is not on ${server}: refusing to continue`, 'origin_mismatch')
  const pr = await getJson(prUrl, deps)
  if (pr.status !== 200 || !Array.isArray(pr.body?.scopes_supported) || !pr.body.scopes_supported.every(nonEmpty)) throw usage(`${prUrl} has no scopes_supported list`, 'discovery_failed')
  const supported: string[] = pr.body.scopes_supported
  const as = await fetchAuthServer(auth.issuer, deps)

  let scopes = supported
  if (scopeFlag !== undefined) {
    scopes = scopeFlag.split(',').map((s) => s.trim()).filter((s) => s !== '')
    if (scopes.length === 0) throw usage('--scope needs at least one scope (a,b,...)', 'unknown_scope')
    const unknown = scopes.filter((s) => s !== 'offline_access' && !supported.includes(s))
    if (unknown.length > 0) throw usage(`${server} does not support the scope ${unknown.join(', ')} (supported: ${supported.join(', ')})`, 'unknown_scope')
  }
  const requested = [...new Set([...scopes, 'offline_access'])].join(' ')
  const grant = await deviceGrant(as, auth.cli_client_id, requested, deps)

  // Reload: another process may have written the config while the person was approving. Replaces any credential of the profile.
  const cfg = loadConfig(path)
  cfg.profiles[name] = { kind: 'oauth', server, issuer: auth.issuer, client_id: auth.cli_client_id, ...grant }
  cfg.default_profile ??= name
  saveConfig(path, cfg)

  let res: Response
  try {
    res = await deps.fetch(`${server}/meta/v1/me`, { headers: { authorization: `Bearer ${grant.access_token}`, accept: 'application/json', 'user-agent': `vibase-cli/${deps.version}` }, redirect: 'error' })
  } catch (e) {
    throw new CliError(1, 'network_error', `signed in, but could not reach ${server}/meta/v1/me: ${e instanceof Error ? e.message : 'request failed'}`)
  }
  if (!res.ok) throw await apiError(res)
  const me = (await res.json().catch(() => undefined)) as any
  if (me === undefined) throw new CliError(1, 'invalid_response', 'the response of /meta/v1/me was not JSON')
  await json(deps, 'stdout', me)
  if (me.principal?.kind === 'agent' && Array.isArray(me.active_organization?.scopes) && me.active_organization.scopes.length === 0) {
    const id = String(me.principal.id)
    await deps.stderr.write(`Signed in as the agent account ${id}, which has no scopes yet: an owner must grant them, for example\n  vibase agents update ${id} --data '{"scopes":["contacts:read","contacts:write"]}'\n`)
  }
  return 0
}

async function logout(args: string[], deps: Deps): Promise<number> {
  let profile: string | undefined
  try {
    const parsed = parseArgs({ args, options: { profile: { type: 'string' } }, allowPositionals: false })
    profile = parsed.values.profile
  } catch {
    throw usage('logout takes --profile <name> only')
  }
  const path = configPath(deps)
  const cfg = loadConfig(path)
  const name = profileName(profile ?? (deps.env.VIBASE_PROFILE || undefined) ?? cfg.default_profile ?? 'default')
  if (!Object.hasOwn(cfg.profiles, name)) throw usage(`no profile named "${name}"`, 'no_profile')
  if (cfg.profiles[name]!.kind === 'oauth') return oauthLogout(name, deps)
  delete cfg.profiles[name]
  if (cfg.default_profile === name) delete cfg.default_profile
  saveConfig(path, cfg)
  await json(deps, 'stdout', { profile: name, removed: true })
  return 0
}

/** D21: revoke the refresh token (RFC 7009), then remove the profile whatever the revocation did. Under the refresh lock, so no refresh rotates it meanwhile. */
async function oauthLogout(name: string, deps: Deps): Promise<number> {
  const path = configPath(deps)
  const state: { outcome: 'revoked' | 'unsupported' | 'nothing' | CliError } = { outcome: 'nothing' }
  await withLock(deps, async () => {
    const cfg = loadConfig(path)
    const p = Object.hasOwn(cfg.profiles, name) ? cfg.profiles[name] : undefined
    if (!p) throw usage(`no profile named "${name}"`, 'no_profile')
    if (p.kind === 'oauth' && p.refresh_token !== '') {
      try {
        state.outcome = await revokeRefreshToken(p, deps)
      } catch (e) {
        if (!(e instanceof CliError)) throw e
        state.outcome = new CliError(1, e.code, `could not revoke the grant (the local credential is removed anyway; it may stay valid until it expires): ${e.message}`)
      }
    }
    delete cfg.profiles[name]
    if (cfg.default_profile === name) delete cfg.default_profile
    saveConfig(path, cfg)
  })
  const { outcome } = state
  await json(deps, 'stdout', { profile: name, removed: true })
  if (outcome instanceof CliError) {
    await json(deps, 'stderr', { error: { code: outcome.code, message: outcome.message } })
    return outcome.exit
  }
  if (outcome === 'unsupported') await deps.stderr.write('note: the issuer advertises no revocation endpoint, so the grant was not revoked; it lives until it expires\n')
  return 0
}

async function configCommand(action: string | undefined, rest: string[], deps: Deps): Promise<number> {
  if (action !== 'get' && action !== 'set') throw usage('usage: vibase config get <key> | vibase config set <key> <value>')
  const [key, value, ...more] = rest
  if (!key || more.length > 0 || (action === 'get' && value !== undefined) || (action === 'set' && value === undefined)) throw usage(`usage: vibase config ${action === 'get' ? 'get <key>' : 'set <key> <value>'}`)
  if (/api_key|secret|token/i.test(key)) throw usage('credentials are not readable or settable through config: use `vibase login`')
  const path = configPath(deps)
  const cfg: Config = loadConfig(path)
  const m = /^profiles\.([^.]+)\.(server|kind)$/.exec(key)
  if (key !== 'default_profile' && !m) throw usage(`unknown key "${key}": default_profile, profiles.<name>.server, profiles.<name>.kind`)
  const profile = m ? (Object.hasOwn(cfg.profiles, m[1]!) ? cfg.profiles[m[1]!] : undefined) : undefined
  if (action === 'get') {
    await json(deps, 'stdout', m ? (profile ? profile[m[2] as 'server' | 'kind'] : null) : (cfg.default_profile ?? null))
    return 0
  }
  if (m) {
    if (m[2] === 'kind') throw usage('profiles.<name>.kind is read-only')
    if (!profile) throw usage(`no profile named "${m[1]}"`, 'no_profile')
    if (profile.kind === 'oauth') throw usage('an OAuth profile is bound to the server it signed in to: run `vibase login --server <url>` instead')
    profile.server = serverOrigin(value!)
  } else {
    const name = profileName(value!)
    if (!Object.hasOwn(cfg.profiles, name)) throw usage(`no profile named "${name}"`, 'no_profile')
    cfg.default_profile = name
  }
  saveConfig(path, cfg)
  await json(deps, 'stdout', value)
  return 0
}

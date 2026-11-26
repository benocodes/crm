// Build-time settings (DX637 P4): VIBASE_URL and VIBASE_CLIENT_ID, from the environment or from the gitignored settings file, the environment winning.
// Nothing here is secret: the client is a public one, and the deployment's URL is public.
export interface AppConfig {
  /** The deployment's URL (the API origin), e.g. http://localhost:8787. */
  vibaseUrl: string
  /** The first-party client's id (`oauth_clients.create`). */
  clientId: string
}

/** `KEY=value` lines; blank lines and `#` comments are skipped, one pair of surrounding quotes is removed. */
export function parseSettings(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, '$2')
  }
  return out
}

export function resolveConfig(env: Record<string, string | undefined>, fileText = ''): AppConfig {
  const file = parseSettings(fileText)
  const get = (name: string): string => {
    const v = env[name] || file[name]
    if (!v) throw new Error(`${name} is not set: put it in the environment or in settings.env (see settings.env.example)`)
    return v
  }
  return { vibaseUrl: new URL(get('VIBASE_URL')).origin, clientId: get('VIBASE_CLIENT_ID') }
}

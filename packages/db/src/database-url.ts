function redact(url: string): string {
  try {
    const u = new URL(url)
    u.password = ''
    u.username = ''
    return u.toString()
  } catch {
    return '<unparseable url>'
  }
}

/** Returns the database name of `url`, or throws unless it names a test database. */
export function assertTestDatabaseName(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
  if (!name) throw new Error(`refusing: no database name in ${redact(url)}`)
  if (!/(^|_)test(_|$)/.test(name)) {
    throw new Error(`refusing: database "${name}" is not a test database`)
  }
  return name
}

/** `vault_test_` + the worktree folder name, folded to `[a-z0-9_]`. */
export function worktreeDatabaseName(worktreeRoot: string): string {
  const base = worktreeRoot.replace(/\/+$/, '').split('/').pop() ?? ''
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `vault_test_${slug}`
}

/** The same URL with the username replaced and the password removed. */
export function withUser(url: string, user: string): string {
  const u = new URL(url)
  u.username = user
  u.password = ''
  return u.toString()
}

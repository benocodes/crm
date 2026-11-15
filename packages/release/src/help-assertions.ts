// What `release:check` requires of the installed `vibase-server --help` ([[OPS249]] D13, [[OPS307]]): each command's usage line, as a pure function a test can run against the real help text.
// The check itself runs the installed bin; the needles live here so a unit test sees them without a tarball.
export const SERVER_HELP_NEEDLES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'status --env', pattern: /vibase-server status --env/ },
  {
    name: 'upgrade [--dry-run] [--rollback]',
    pattern: /vibase-server upgrade --env <name> \[--dry-run\] \[--rollback\]/,
  },
  {
    name: 'setup --env <name> (--api-host <host> | --workers-dev)',
    pattern: /vibase-server setup --env <name> \(--api-host <host> \| --workers-dev\)/,
  },
  { name: 'owner-reset --env <name>', pattern: /vibase-server owner-reset --env <name>/ },
]

/** The usage lines the help text lacks, by name. */
export function serverHelpProblems(help: string): string[] {
  return SERVER_HELP_NEEDLES.filter((n) => !n.pattern.test(help)).map((n) => n.name)
}

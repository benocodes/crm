// What `release:check` requires of the installed `vibase-server --help` ([[OPS249]] D13, [[OPS307]]): each command's usage line, as a pure function a test can run against the real help text.
// The check itself runs the installed bin; the needles live here so a unit test sees them without a tarball.
export const SERVER_HELP_NEEDLES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  {
    name: 'init [--env <name>] [--api-host <host>] ...',
    pattern: /vibase-server init \[--env <name>\] \[--api-host <host>\]/,
  },
  { name: 'status --env', pattern: /vibase-server status --env/ },
  {
    name: 'upgrade [--dry-run] [--yes] (no --rollback)',
    pattern: /vibase-server upgrade --env <name> \[--dry-run\] \[--yes\](?! \[--rollback\])/,
  },
  { name: 'redeploy [--dry-run] [--yes]', pattern: /vibase-server redeploy --env <name> \[--dry-run\] \[--yes\]/ },
  {
    name: 'setup --env <name> [--api-host <host> | --workers-dev] ... [--dry-run] [--yes]',
    pattern:
      /vibase-server setup --env <name> \[--api-host <host> \| --workers-dev\][^\n]*\n[^\n]*\[--dry-run\] \[--yes\]/,
  },
  {
    name: 'init writes the settings file and the secrets file',
    pattern: /Writes a new instance's settings file and secrets file/,
  },
  {
    name: 'owner-reset --env <name> ... [--dry-run] [--yes]',
    pattern: /vibase-server owner-reset --env <name> \[--email <owner>\] \[--dry-run\] \[--yes\]/,
  },
  { name: 'the shared proceed? [Y/n] line', pattern: /proceed\? \[Y\/n\]/ },
]

/** [[OPS493]] D7: what the help must not say any more. */
export const SERVER_HELP_FORBIDDEN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'no CONFIRM_REMOTE', pattern: /CONFIRM_REMOTE/ },
  { name: 'no "No prompts"', pattern: /No prompts/ },
]

/** The usage lines the help text lacks, by name. */
export function serverHelpProblems(help: string): string[] {
  return [
    ...SERVER_HELP_NEEDLES.filter((n) => !n.pattern.test(help)).map((n) => n.name),
    ...SERVER_HELP_FORBIDDEN.filter((n) => n.pattern.test(help)).map((n) => n.name),
  ]
}

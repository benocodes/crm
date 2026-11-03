import type { Command } from './types.js'

export const HAND_COMMANDS = `Commands that are always here:
  vibase login --api-key --server <url> [--profile <name>]   store an API key (read from stdin, never argv)
  vibase logout [--profile <name>]                           forget a profile
  vibase config get|set <key> [value]                        read or change the configuration`

export const GLOBAL_FLAGS = `Flags every command takes:
  --server <url>     the instance (an origin); overrides VIBASE_SERVER and the profile
  --profile <name>   the profile to use; overrides VIBASE_PROFILE
  --refresh          fetch the instance's command list again instead of using the cache
  --data <json|@file|->   the whole request body; flags override its keys
  --all              (lists) follow next_cursor and print one JSON line per record
  --output <path|->  (binary commands) write the bytes to a file, or to stdout with -`

const group = (commands: Command[]) => {
  const by = new Map<string, Command[]>()
  for (const c of commands) by.set(c.resource, [...(by.get(c.resource) ?? []), c])
  return by
}

export function topHelp(commands: Command[] | undefined, server?: string): string {
  const lines = ['vibase: the vault on the command line', '', 'Usage: vibase <resource> <action> [ids] [--flags] [--data <json>]', '']
  if (commands) {
    lines.push(`Resources of ${server}:`)
    for (const [resource, cmds] of [...group(commands)].sort(([a], [b]) => a.localeCompare(b))) lines.push(`  ${resource.padEnd(22)}${cmds.map((c) => c.action).join(', ')}`)
  } else lines.push('Resources come from the instance: pass --server or run `vibase login --api-key --server <url>` first.')
  lines.push('', HAND_COMMANDS, '', GLOBAL_FLAGS, '', 'vibase <resource> --help and vibase <resource> <action> --help describe a command.')
  return lines.join('\n') + '\n'
}

export function resourceHelp(resource: string, commands: Command[]): string {
  const lines = [`vibase ${resource} <action>`, '']
  for (const c of commands) lines.push(`  ${c.action.padEnd(14)}${c.summary}`)
  return lines.join('\n') + '\n'
}

export function commandHelp(c: Command): string {
  const pos = c.pathParams.map((p) => ` <${p}>`).join('')
  const lines = [`vibase ${c.resource} ${c.action}${pos} [flags]`, '', c.summary || `${c.method} ${c.path}`, '', `Calls ${c.method} ${c.path}.`]
  if (c.error) lines.push('', `Not available: ${c.error}`)
  if (c.flags.length) {
    lines.push('', 'Flags:')
    for (const f of c.flags) {
      const type = f.type === 'json' ? 'json' : f.enum ? f.enum.join('|') : f.type
      const where = f.where === 'query' ? 'query' : 'body'
      lines.push(`  --${f.name}${f.type === 'boolean' ? '' : ` <${type}>`}`.padEnd(30) + `${f.type === 'boolean' ? 'boolean ' : f.type === 'integer' || f.type === 'number' ? `${f.type} ` : ''}(${where}${f.required ? ', required' : ''})${f.description ? ' ' + f.description : ''}`)
    }
  }
  if (c.dataOnly.length) lines.push('', `Only through --data: ${c.dataOnly.join(', ')}`)
  if (c.hasBody) lines.push('', 'The body can be given whole with --data <json|@file|->; null values only that way.')
  if (c.paginated) lines.push('', '--all follows next_cursor and prints one JSON line per record.')
  if (c.binary) lines.push('', 'Binary: bytes go to stdout when it is not a terminal; on a terminal give --output <path>.')
  return lines.join('\n') + '\n'
}

import type { Command, Invocation } from './types.js'

export interface InvokeIo {
  readFile(path: string): Promise<string>
  readStdin(): Promise<string>
}
/** Turns the words after the command into one request ([[API6]] D7): positional path parameters, flags, `--data`. */
export function parseInvocation(_cmd: Command, _args: string[], _io: InvokeIo): Promise<Invocation> {
  throw new Error('not implemented')
}

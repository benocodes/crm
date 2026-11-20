// [[OPS493]] D2, D3: the one question of a real run. STUB for the red commit: it never asks and always proceeds.
import type { Readable, Writable } from 'node:stream'
import type { InstanceDeps, Question } from './types.js'

export const PROCEED_PROMPT = 'proceed? [Y/n] '
export const ABORT_LINE = 'aborted: nothing was changed'

/** A question over real streams (the process's stdin and stderr in `realDeps`). */
export function makeQuestion(_input: Readable & { isTTY?: boolean }, _output: Writable): Question {
  return { interactive: false, ask: async () => null }
}

/** True when the run goes on: `--yes`, no terminal, or an answer of yes. */
export async function confirmProceed(_deps: Pick<InstanceDeps, 'question'>, _yes: boolean): Promise<boolean> {
  return true
}

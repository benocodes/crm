// [[OPS493]] D2, D3: the one question of a real run of a mutating command, asked once after the plan and before the first write.
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { InstanceDeps, Question } from './types.js'

export const PROCEED_PROMPT = 'proceed? [Y/n] '
export const ABORT_LINE = 'aborted: nothing was changed'

/**
 * A question over real streams (the process's stdin and stderr in `realDeps`): the prompt goes to `output`, one line is read from `input`. Lines typed ahead are kept in order; end of
 * input answers `null`. The input is paused between questions, so an answered question never keeps the process alive.
 */
export function makeQuestion(input: Readable & { isTTY?: boolean }, output: Writable): Question {
  const lines: string[] = []
  let closed = false
  let wake: (() => void) | null = null
  const rl = createInterface({ input, terminal: false })
  rl.on('line', (l) => {
    lines.push(l)
    wake?.()
  })
  rl.on('close', () => {
    closed = true
    wake?.()
  })
  rl.pause()
  return {
    interactive: input.isTTY === true,
    async ask(prompt) {
      output.write(prompt)
      while (lines.length === 0 && !closed) {
        rl.resume()
        await new Promise<void>((r) => (wake = r))
        wake = null
      }
      rl.pause()
      return lines.shift() ?? null
    },
  }
}

/** True when the run goes on: `--yes`, no terminal on stdin, or an answer of yes (empty, `y`, `yes`). `n` or `no` or end of input is false; any other answer asks again. */
export async function confirmProceed(deps: Pick<InstanceDeps, 'question'>, yes: boolean): Promise<boolean> {
  if (yes || !deps.question.interactive) return true
  for (;;) {
    const a = await deps.question.ask(PROCEED_PROMPT)
    if (a === null) return false
    const t = a.trim().toLowerCase()
    if (t === '' || t === 'y' || t === 'yes') return true
    if (t === 'n' || t === 'no') return false
  }
}

/** A question made on first use: `interactive` reads `process.stdin.isTTY` without opening a reader, and only `ask` attaches one. */
export function lazyQuestion(make: () => Question): Question {
  let q: Question | null = null
  return {
    get interactive() {
      return process.stdin.isTTY === true
    },
    ask: (prompt) => (q ??= make()).ask(prompt),
  }
}

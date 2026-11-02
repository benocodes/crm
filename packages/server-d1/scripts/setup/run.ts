import type { SetupDeps, StepResult } from './types.js'

export interface SetupOutcome {
  exitCode: number
  results: StepResult[]
  /** True when a config write ended the run early ([[OPS65]] D10). */
  stoppedAfterConfigWrite: boolean
}

/** Runs `setup:remote` ([[OPS65]] D6). Stub: red tests first. */
export async function runSetup(_argv: string[], _procEnv: NodeJS.ProcessEnv, _deps: SetupDeps): Promise<SetupOutcome> {
  throw new Error('not implemented')
}

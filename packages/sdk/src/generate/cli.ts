// RED STUB (DX604): replaced by the implementation in the green commit.
export interface RunOptions {
  cwd?: string
  initCwd?: string
  fetch?: typeof fetch
  builtInDir?: string
}

export async function run(
  _argv: string[],
  _options: RunOptions = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  throw new Error('not implemented')
}

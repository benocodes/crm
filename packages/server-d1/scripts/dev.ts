// STUB (red commit): `pnpm dev`'s runner ([[UI489]] D7, P2).
export interface DevChild {
  exited: Promise<number>
  stop(): Promise<void>
}
export interface DevDeps {
  build(): Promise<number>
  startWorker(args: string[]): DevChild
  startDevServer(): Promise<DevChild>
  onSignal(handler: () => void): () => void
  log(line: string): void
}
export async function runDev(_args: string[], _deps: DevDeps): Promise<number> {
  throw new Error('not implemented')
}

// STUB (red commit): the dev server of the page bundles ([[UI489]] D5).
export const DEV_PORT = 5173
export const WORKER_PORT = 8787
export const devOwnedPaths = (): string[] => []
export interface DevServer {
  url: string
  close(): Promise<void>
}
export async function startDevServer(_opts: { upstream: string; port?: number }): Promise<DevServer> {
  throw new Error('not implemented')
}

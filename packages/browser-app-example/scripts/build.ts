// pnpm -C packages/browser-app-example build -> dist/ (DX637 D11). Stub: red commit.
import { fileURLToPath } from 'node:url'

export const OUT = fileURLToPath(new URL('../dist', import.meta.url))
export async function buildApp(_env: Record<string, string | undefined> = process.env, _out: string = OUT): Promise<void> {}

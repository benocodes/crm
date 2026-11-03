// Stub (red commit): the implementation follows.
import { fileURLToPath } from 'node:url'

/** The directory `wrangler.jsonc`'s `assets.directory` names. */
export const ASSETS_DIR = fileURLToPath(new URL('../dist/assets', import.meta.url))

export async function buildConnect(_outDir: string = ASSETS_DIR): Promise<void> {}

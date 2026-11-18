import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// [[UI461]] D3 (group 2): after sign-in or acceptance the pages go to /home. No source under src/ui may default to '/connect' (the allow-list in continuation.ts names it as a return target, which is a different thing).
describe("no '/connect' default remains in the auth pages", () => {
  const files = readdirSync(new URL('.', import.meta.url)).filter(
    (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && f !== 'continuation.ts',
  )
  it.each(files)('%s', (f) => {
    expect(readFileSync(new URL(f, import.meta.url), 'utf8')).not.toMatch(/['"`]\/connect['"`]/)
  })
})

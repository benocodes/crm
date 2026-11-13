// What must never be in the release package ([[OPS210]] D8). The scan reads every file under a directory; findings name the file and the kind, never a value.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'jsonc-parser'
import { ReleaseRefusal } from './errors.js'
import { listFiles } from './manifest.js'

export type ForbiddenKind = 'env-file' | 'dev-vars' | 'wrangler-config' | 'env-key' | 'sk_live_' | 'sk_test_' | 'pem' | 'database-id'
export interface Finding {
  file: string
  kind: ForbiddenKind
}

/** A PEM block: its header followed by a key body. The bare header is not a finding: the Worker's own key parser holds that literal. */
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----(?:\\r|\\n|\s)*[A-Za-z0-9+/=]{16,}/

/** Every `env.<name>.d1_databases[].database_id` of a wrangler config, read from the text. */
export function envDatabaseIds(wranglerJsonc: string): string[] {
  const cfg = parse(wranglerJsonc) as { env?: Record<string, { d1_databases?: { database_id?: string }[] }> }
  const ids: string[] = []
  for (const env of Object.values(cfg.env ?? {})) for (const db of env.d1_databases ?? []) if (db.database_id) ids.push(db.database_id)
  return ids
}

export function scanForbidden(dir: string, opts: { databaseIds: readonly string[] }): Finding[] {
  const out: Finding[] = []
  for (const file of listFiles(dir)) {
    const base = file.slice(file.lastIndexOf('/') + 1)
    if (base === '.env' || base.startsWith('.env.')) out.push({ file, kind: 'env-file' })
    if (base === '.dev.vars' || base.startsWith('.dev.vars.')) out.push({ file, kind: 'dev-vars' })
    if (base === 'wrangler.jsonc' || base === 'wrangler.json' || base === 'wrangler.toml') out.push({ file, kind: 'wrangler-config' })
    const text = readFileSync(join(dir, file), 'latin1')
    if (file === 'wrangler.base.jsonc' && 'env' in ((parse(text) as object | undefined) ?? {})) out.push({ file, kind: 'env-key' })
    if (text.includes('sk_live_')) out.push({ file, kind: 'sk_live_' })
    if (text.includes('sk_test_')) out.push({ file, kind: 'sk_test_' })
    if (PEM_BLOCK.test(text)) out.push({ file, kind: 'pem' })
    if (opts.databaseIds.some((id) => text.includes(id))) out.push({ file, kind: 'database-id' })
  }
  return out
}

export function assertNoForbidden(dir: string, opts: { databaseIds: readonly string[] }): void {
  const found = scanForbidden(dir, opts)
  if (found.length === 0) return
  throw new ReleaseRefusal(`forbidden content in the release: ${found.map((f) => `${f.file} (${f.kind})`).join(', ')}`)
}

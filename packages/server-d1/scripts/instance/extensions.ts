// The extensions file on the tooling side ([[CORE315]] D26 to D30, [[CORE543]]): validate the file before any write, derive its digest, read the live `__c` schema through wrangler, plan the apply, and compare the file with what
// the live Worker reports. Pure and synchronous where it can be; every wrangler call stays in `upgrade.ts`, which hands this module a row reader.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  liveSchemaFrom,
  planApply,
  violationRefusals,
  type ApplyPlan,
  type LiveSchema,
  type Refusal,
} from '../../../api/src/custom/apply.js'
import { DeclarationError, type ObjectDeclaration } from '../../../api/src/custom/declaration.js'
import { literal } from '../../../api/src/custom/ddl.js'
import { parseExtensionsFile } from '../../../api/src/custom/extensions.js'
import { InstanceRefusal } from './types.js'

/** The Text module's name: the release-built `worker.js` imports it by exactly this ([[CORE543]] P7). */
export const EXTENSIONS_MODULE = 'vibase-extensions.json'
/** What a deploy with no file attaches ([[CORE315]] D27). */
export const EMPTY_EXTENSIONS = '{"version":1,"objects":{}}\n'

export interface ExtensionsRun {
  /** Absolute. */
  path: string
  bytes: Buffer
  digest: string
  objects: Record<string, ObjectDeclaration>
}
/** What a `/health` says of the attached file ([[CORE543]] P1): `null` none, `{digest, objects}` a file, `{digest, error}` a file the Worker could not load. */
export type LiveExtensions = null | { digest: string; objects: string[] } | { digest: string; error: string }

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Reads and validates the file with the validator the Worker uses; a refusal names the path and the rule code ([[CORE543]] D26). */
export function loadExtensionsFile(path: string): ExtensionsRun {
  const abs = resolve(path)
  let bytes: Buffer
  try {
    bytes = readFileSync(abs)
  } catch {
    throw new InstanceRefusal(`cannot read the extensions file ${abs}`)
  }
  try {
    const file = parseExtensionsFile(bytes.toString('utf8'))
    return { path: abs, bytes, digest: sha256Hex(bytes), objects: file.objects }
  } catch (e) {
    if (e instanceof DeclarationError)
      throw new InstanceRefusal(`${abs}: ${e.rule}${e.path ? ` at ${e.path}` : ''}: ${e.message}`)
    throw e
  }
}

/** The digest a run attaches: `null` when there is no file or it declares no objects (the Worker reports `null` for both, P1). */
export const runDigest = (run: ExtensionsRun | null): string | null =>
  run === null || Object.keys(run.objects).length === 0 ? null : run.digest

/** `/health.extensions` as the tooling reads it: no key (an older build) is none, an unreadable shape is none, an error marker is a file the Worker could not load (P1). */
export function liveExtensionsOf(health: unknown): LiveExtensions {
  const e = (health as { extensions?: unknown } | null | undefined)?.extensions
  if (typeof e !== 'object' || e === null) return null
  const { digest, objects, error } = e as { digest?: unknown; objects?: unknown; error?: unknown }
  if (typeof digest !== 'string') return null
  if (typeof error === 'string') return { digest, error }
  if (Array.isArray(objects)) return { digest, objects: objects.filter((o): o is string => typeof o === 'string') }
  return null
}

const names = (objects: string[]): string =>
  `${objects.length} object${objects.length === 1 ? '' : 's'}: ${objects.join(', ')}`
const liveText = (live: LiveExtensions): string =>
  live === null
    ? 'none'
    : 'error' in live
      ? `${live.digest} (invalid: ${live.error})`
      : `${live.digest} (${names(live.objects)})`
const runText = (run: ExtensionsRun | null): string =>
  run === null
    ? 'none'
    : Object.keys(run.objects).length === 0
      ? `${run.digest} (no objects)`
      : `${run.digest} (${names(Object.keys(run.objects))})`

/** The line `status` prints. */
export const liveExtensionsLine = (live: LiveExtensions): string => `extensions: ${liveText(live)}`
/** The plan line naming both digests (D29). */
export const extensionsLine = (live: LiveExtensions, run: ExtensionsRun | null): string =>
  `extensions: live ${liveText(live)} -> run ${runText(run)}`

/** The refusal text, or `null` ([[CORE543]] D29): the live Worker has a file (or one it could not load) and this run has none, so the deploy would drop it silently. */
export function extensionsGuard(
  live: LiveExtensions,
  run: ExtensionsRun | null,
  mode: 'upgrade' | 'redeploy',
  env: string,
): string | null {
  if (live === null || run !== null) return null
  const what =
    'error' in live
      ? `an extensions file it could not load (digest ${live.digest})`
      : `an extensions file (digest ${live.digest}, ${names(live.objects)})`
  const drop = `a file with no objects (${EMPTY_EXTENSIONS.trim()}) drops it on purpose`
  return mode === 'redeploy'
    ? `the live Worker carries ${what} and this run has none: it would be dropped. Pass --extensions <path> to attach one (${drop}), or record one with an earlier redeploy --extensions`
    : `the live Worker carries ${what} and this instance records none: upgrade would drop it. Run vibase-server redeploy --extensions <path> --env ${env} to attach one and record it (${drop})`
}

/** True when `/health` shows what this run attached (P4): none and none, or the same digest and no error. */
export function extensionsMatch(live: LiveExtensions, expect: string | null): boolean {
  if (expect === null) return live === null
  return live !== null && !('error' in live) && live.digest === expect
}

/** The statement with each `?` replaced by the literal of its bind (wrangler's `--command` takes no binds); a name goes in as a quoted literal, never as SQL. */
export function inlineBinds(sql: string, binds: unknown[]): string {
  let i = 0
  return sql.replace(/\?/g, () => literal(binds[i++] as string | number | boolean))
}

export type SqlReader = (sql: string) => unknown[] | Promise<unknown[]>
/** The live `__c` schema through `readSql`, one read per statement (P8): the library's own reader over a transport with no binds. */
export const readRemoteLiveSchema = (readSql: SqlReader): Promise<LiveSchema> =>
  liveSchemaFrom(async <T>(sql: string, ...binds: unknown[]) => (await readSql(inlineBinds(sql, binds))) as T[])

export interface RemotePlan {
  plan: ApplyPlan
  /** The plan's own refusals and one `unique_violation` per value a new unique index would refuse. */
  refused: Refusal[]
}
/** The plan and the violation reads against the live schema, before any write (P2). */
export async function planRemote(objects: Record<string, ObjectDeclaration>, readSql: SqlReader): Promise<RemotePlan> {
  const plan = planApply(objects, await readRemoteLiveSchema(readSql))
  const refused = [...plan.refused]
  for (const r of plan.reads)
    refused.push(...violationRefusals(r, (await readSql(r.sql)) as { value: unknown; ids: unknown }[]))
  return { plan, refused }
}

const list = (items: string[]): string => (items.length === 0 ? 'none' : items.join(', '))
/** The plan lines `--dry-run` and the question print (P2). */
export function planLines(p: RemotePlan): string[] {
  const { plan } = p
  return [
    `extensions plan: ${plan.statements.length} statement${plan.statements.length === 1 ? '' : 's'}`,
    `  create: ${list(plan.created)}`,
    `  add: ${list(plan.added.map((a) => `${a.object}.${a.field}`))}`,
    `  index: ${list(plan.indexed.map((i) => i.index))}`,
    `  archived: ${list(plan.archived.map((a) => (a.field === undefined ? a.object : `${a.object}.${a.field}`)))}`,
    ...plan.statements.map((s) => `  sql: ${s.replace(/\s+/g, ' ')}`),
  ]
}
/** The refusal text of a plan that cannot run: one line per refusal, by rule code. */
export const refusalText = (refused: Refusal[]): string =>
  `the extensions file cannot be applied (nothing was changed):\n${refused.map((r) => `  ${r.rule}: ${r.message}`).join('\n')}`

/** The statements as the `--file` content: each ends in `;` and a newline. */
export const statementsFile = (statements: string[]): string => `${statements.map((s) => `${s};`).join('\n')}\n`

/** The rows of `wrangler d1 execute --json`'s output ([[CORE543]] P8). */
export function rowsOf(stdout: string): unknown[] {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    throw new Error('unreadable output from wrangler d1 execute')
  }
  const error = (json as { error?: { text?: unknown; notes?: { text?: unknown }[] } } | null)?.error
  if (error) {
    const notes = Array.isArray(error.notes)
      ? error.notes.map((n) => (typeof n?.text === 'string' ? n.text : '')).join(' ')
      : ''
    throw new Error(
      `wrangler d1 execute failed: ${notes || (typeof error.text === 'string' ? error.text : 'unknown error')}`,
    )
  }
  const results = Array.isArray(json) ? (json[0] as { results?: unknown } | undefined)?.results : undefined
  if (!Array.isArray(results)) throw new Error('unexpected output shape from wrangler d1 execute')
  return results
}

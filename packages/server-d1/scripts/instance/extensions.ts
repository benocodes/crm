// The extensions file on the tooling side ([[CORE315]] D26 to D30, [[CORE543]]): validate the file before any write, derive its digest, read the live `__c` schema through wrangler, plan the apply, and stage
// the module beside the Worker. STUB: the red commit; the bodies follow.
import type { ApplyPlan, LiveSchema, Refusal } from '../../../api/src/custom/apply.js'
import type { ObjectDeclaration } from '../../../api/src/custom/declaration.js'
import type { InstanceSettings } from './types.js'

/** The Text module's name: the release-built `worker.js` imports it by exactly this ([[CORE543]] P7). */
export const EXTENSIONS_MODULE = 'vibase-extensions.json'
/** What a deploy with no file attaches ([[CORE315]] D27). */
export const EMPTY_EXTENSIONS = '{"version":1,"objects":{}}\n'

export interface ExtensionsRun {
  path: string
  bytes: Buffer
  digest: string
  objects: Record<string, ObjectDeclaration>
}
/** What a `/health` says of the attached file ([[CORE543]] P1): `null` none, `{digest, objects}` a file, `{digest, error}` a file the Worker could not load. */
export type LiveExtensions = null | { digest: string; objects: string[] } | { digest: string; error: string }

export const sha256Hex = (_bytes: Uint8Array): string => {
  throw new Error('not implemented')
}
export function loadExtensionsFile(_path: string): ExtensionsRun {
  throw new Error('not implemented')
}
/** The digest a run attaches: `null` when there is no file or it declares no objects (the Worker reports `null` for both, P1). */
export const runDigest = (_run: ExtensionsRun | null): string | null => {
  throw new Error('not implemented')
}
export function liveExtensionsOf(_health: unknown): LiveExtensions {
  throw new Error('not implemented')
}
/** The refusal text, or `null` ([[CORE543]] D29): the live Worker has a file (or one it could not load) and this run has none. */
export function extensionsGuard(
  _live: LiveExtensions,
  _run: ExtensionsRun | null,
  _mode: 'upgrade' | 'redeploy',
  _env: string,
): string | null {
  throw new Error('not implemented')
}
/** The plan lines naming both digests (D29). */
export function extensionsLines(_live: LiveExtensions, _run: ExtensionsRun | null): string[] {
  throw new Error('not implemented')
}
/** True when `/health` shows what this run attached (P4). */
export function extensionsMatch(_live: LiveExtensions, _run: ExtensionsRun | null): boolean {
  throw new Error('not implemented')
}
/** The live `__c` schema through one wrangler read per call (P8); `readSql` returns the rows of a SELECT. */
export async function readRemoteLiveSchema(
  _readSql: (sql: string) => unknown[] | Promise<unknown[]>,
): Promise<LiveSchema> {
  throw new Error('not implemented')
}
export interface RemotePlan {
  plan: ApplyPlan
  refused: Refusal[]
}
/** The plan and the violation reads against the live schema, before any write (P2). */
export async function planRemote(
  _objects: Record<string, ObjectDeclaration>,
  _readSql: (sql: string) => unknown[] | Promise<unknown[]>,
): Promise<RemotePlan> {
  throw new Error('not implemented')
}
/** The plan lines `--dry-run` and the question print (P2). */
export function planLines(_p: RemotePlan): string[] {
  throw new Error('not implemented')
}
/** The statements as the `--file` content. */
export const statementsFile = (_statements: string[]): string => {
  throw new Error('not implemented')
}
/** The recorded path, validated ([[CORE543]] P3): absolute. */
export const recordedExtensions = (_s: InstanceSettings): string | undefined => {
  throw new Error('not implemented')
}

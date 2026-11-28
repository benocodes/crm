// STUB (red commit)
import { ReleaseRefusal } from './errors.js'
export const CHECK_USAGE = 'usage: release:check [<cli tarball> <server tarball> <sdk tarball>]'
export class CheckUsageError extends ReleaseRefusal {}
export interface CheckTarballs {
  client: string
  server: string
  sdk: string
}
export function resolveCheckArgs(args: string[], dist: string, version: string): CheckTarballs {
  return { client: args[0] ?? dist + version, server: args[1] ?? '', sdk: args[2] ?? '' }
}
export function verifyBesideSums(t: CheckTarballs): string | null {
  return t.client ? null : null
}

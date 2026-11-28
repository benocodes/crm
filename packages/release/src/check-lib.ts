// `release:check`'s arguments and its SHA256SUMS step ([[OPS709]] D7): pure enough to unit-test without running the whole check.
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ReleaseRefusal } from './errors.js'
import { verifySums } from './pack.js'

export const CHECK_USAGE = 'usage: release:check [<cli tarball> <server tarball> <sdk tarball>]'

/** A wrong number of tarball arguments: the script prints the usage line and exits 2, before any work. */
export class CheckUsageError extends ReleaseRefusal {}

export interface CheckTarballs {
  client: string
  server: string
  sdk: string
}

/** Zero arguments: the three tarballs `release:build` wrote in `dist`; three: cli, server, sdk, in that order. Any other count is a usage error. */
export function resolveCheckArgs(args: string[], dist: string, version: string): CheckTarballs {
  if (args.length === 0)
    return {
      client: join(dist, `vibase-cli-${version}.tgz`),
      server: join(dist, `vibase-server-d1-${version}.tgz`),
      sdk: join(dist, `vibase-sdk-${version}.tgz`),
    }
  if (args.length === 3) return { client: args[0]!, server: args[1]!, sdk: args[2]! }
  throw new CheckUsageError(CHECK_USAGE)
}

/** When the three tarballs sit beside a `SHA256SUMS` it must match them all (a hand-repacked copy elsewhere is not verified: `null`); returns the log line. */
export function verifyBesideSums(t: CheckTarballs): string | null {
  const dirs = new Set([t.client, t.server, t.sdk].map((f) => dirname(resolve(f))))
  if (dirs.size !== 1) return null
  const dir = [...dirs][0]!
  if (!existsSync(join(dir, 'SHA256SUMS'))) return null
  const bad = verifySums(dir)
  if (bad.length > 0) throw new ReleaseRefusal(`SHA256SUMS does not match the tarballs: ${bad.join(', ')}`)
  return 'SHA256SUMS ok: three tarballs (cli, server, sdk)'
}

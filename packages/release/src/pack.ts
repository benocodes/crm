// The build output ([[OPS210]] D2): two npm tarballs and one SHA256SUMS in `dist`, from the two staged package directories. Nothing is published.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** `npm pack` each directory into `dist` (npm's own names for the scoped packages), drop every other tarball, and write `SHA256SUMS` over the two in `sha256sum` format. */
export function packRelease(o: { clientDir: string; serverDir: string; dist: string; version: string }): { client: string; server: string; sums: string } {
  mkdirSync(o.dist, { recursive: true })
  for (const f of readdirSync(o.dist)) if (f.endsWith('.tgz') || f === 'SHA256SUMS') rmSync(join(o.dist, f))
  for (const dir of [o.clientDir, o.serverDir]) execFileSync('npm', ['pack', '--pack-destination', o.dist, '--ignore-scripts', '--silent'], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] })
  const client = join(o.dist, `vibase-cli-${o.version}.tgz`)
  const server = join(o.dist, `vibase-server-d1-${o.version}.tgz`)
  for (const t of [client, server]) if (!existsSync(t)) throw new Error(`npm pack did not produce ${t}`)
  const sums = join(o.dist, 'SHA256SUMS')
  writeFileSync(sums, [client, server].map((t) => `${sha(t)}  ${t.slice(o.dist.length + 1)}`).join('\n') + '\n')
  return { client, server, sums }
}

/** Every disagreement between `SHA256SUMS` and the tarballs beside it: `<file> (mismatch|missing|extra)`; empty means the sums are right and complete. */
export function verifySums(dist: string): string[] {
  const listed = new Map<string, string>()
  for (const line of readFileSync(join(dist, 'SHA256SUMS'), 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line)
    if (m) listed.set(m[2]!, m[1]!)
  }
  const problems: string[] = []
  for (const [name, hash] of listed) {
    if (!existsSync(join(dist, name))) problems.push(`${name} (missing)`)
    else if (sha(join(dist, name)) !== hash) problems.push(`${name} (mismatch)`)
  }
  for (const f of readdirSync(dist)) if (f.endsWith('.tgz') && !listed.has(f)) problems.push(`${f} (extra)`)
  return problems
}

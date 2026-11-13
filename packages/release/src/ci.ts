// The CI side of the release ([[OPS237]] P1, P2): the tag check and the release-asset list, called by `.github/workflows/release.yml` through `scripts/ci.ts`.

export type TagDecision = { mode: 'build-only' } | { mode: 'release'; tag: string }

export function decideTag(_run: { refType?: string; refName?: string }, _version: string): TagDecision {
  throw new Error('not implemented')
}

export function releaseAssets(_dist: string, _version: string): string[] {
  throw new Error('not implemented')
}

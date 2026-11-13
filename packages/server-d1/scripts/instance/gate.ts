import type { ReleaseManifest } from '../../../release/src/manifest.js'
import type { InstanceDeps, InstanceSettings } from './types.js'

export interface GateOptions {
  envName: string
  settingsPath?: string
  secretsPath?: string
}
export interface GateOutcome {
  manifest: ReleaseManifest
  settings: InstanceSettings
  settingsPath: string
  live: { version: string; commit: string | null }
  /** `null`: no tracker table. */
  applied: string[] | null
  /** Names in the package not applied yet, in release order. */
  pending: string[]
  notes: string[]
}
export function parseSemver(_v: string): [number, number, number, string] | null {
  throw new Error('not implemented')
}
/** Negative when `a` is older than `b`. Both must be semver. */
export function compareSemver(_a: string, _b: string): number {
  throw new Error('not implemented')
}
export async function runGate(_o: GateOptions, _deps: InstanceDeps): Promise<GateOutcome> {
  throw new Error('not implemented')
}

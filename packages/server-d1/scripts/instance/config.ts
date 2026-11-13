import type { ConfigLike } from '../remote.js'
import type { InstanceSettings } from './types.js'

export interface InstalledPaths {
  worker: string
  assets: string
  migrations: string
}
export function generateConfig(_base: Record<string, any>, _settings: InstanceSettings, _paths: InstalledPaths): Record<string, any> & ConfigLike {
  throw new Error('not implemented')
}
/** Writes the generated config into a fresh temp directory, runs `fn` with its path, and deletes the directory afterwards, on success and on failure. */
export function withGeneratedConfig<T>(_o: { packageDir: string; settings: InstanceSettings; tmpRoot: string }, _fn: (configPath: string) => T): T {
  throw new Error('not implemented')
}

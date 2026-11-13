import type { InstanceSettings } from './types.js'

export function defaultSettingsPath(_env: Record<string, string | undefined>, _homedir: string, _envName: string): string {
  throw new Error('not implemented')
}
export function parseSettings(_text: string, _envName: string, _path: string): InstanceSettings {
  throw new Error('not implemented')
}
export function loadSettings(_path: string, _envName: string): InstanceSettings {
  throw new Error('not implemented')
}

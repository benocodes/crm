// STUB (red commit): the real model lands with the implementation.
export type SwitchDef = {
  id: string
  areaKey: string
  kind: 'read' | 'read_sensitive' | 'request_approval' | 'write' | 'name'
  label: string
  scopes: string[]
  defaultOn: boolean
}
export type AreaModel = { key: string; name: string; sentence: string; requested: string[]; switches: SwitchDef[] }
export type ConsentModel = { requested: string[]; signIn: string[]; areas: AreaModel[] }
export type SwitchState = Record<string, boolean>

export const buildConsentModel = (_requested: readonly string[]): ConsentModel => ({ requested: [], signIn: [], areas: [] })
export const defaultState = (_m: ConsentModel): SwitchState => ({})
export const effectiveOn = (_m: ConsentModel, _s: SwitchState, _sw: SwitchDef): boolean => false
export const grantedScopes = (_m: ConsentModel, _s: SwitchState): string => ''

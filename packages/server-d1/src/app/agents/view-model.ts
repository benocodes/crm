// [[UI459]] D3-D8: the Agents page's logic as a pure view model (red-commit stub: the shapes, none of the behaviour).
import type { ApiResult } from '../session/api.js'
import type { AgentRecord } from '../session/types.js'

export interface AgentRowModel {
  id: string
  name: string
  disabled: boolean
  status: { text: 'Enabled' | 'Disabled'; tone: 'success' | 'neutral' }
  meta: string[]
  action: 'disable' | 'enable' | null
  grantCommand: string | null
  formManaged: boolean
}
export interface AgentsView {
  access: boolean
  canWrite: boolean
  rows: AgentRowModel[]
}
export type ToggleOutcome =
  | { kind: 'updated'; record: AgentRecord; announce: string }
  | { kind: 'reload' }
  | { kind: 'form'; text: string }
  | { kind: 'error'; text: string }

export const FORM_MANAGED_LINE = ''
export const connectedText = (_a: AgentRecord, _meId: string, _formName?: string): string => ''
export const permissionsLine = (_scopes: readonly string[]): string => ''
export const datesLine = (_a: AgentRecord, _fmt: (iso: string) => string): string => ''
export const sortAgents = (a: AgentRecord[]): AgentRecord[] => a
export const grantCommand = (_id: string): string => ''
export function buildAgentsView(_i: {
  scopes: readonly string[]
  meId: string
  agents: AgentRecord[]
  forms: ReadonlyMap<string, string> | null
  formatDate: (iso: string) => string
}): AgentsView {
  return { access: false, canWrite: false, rows: [] }
}
export const toggleOutcome = (_r: ApiResult<AgentRecord>, _name: string, _disabled: boolean): ToggleOutcome => ({
  kind: 'reload',
})

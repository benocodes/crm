import type { Principal } from '../auth/types.js'
import type { Operation, OperationInput, Registry } from '../registry.js'

// Stub for the red commit: the module loads, no behaviour yet.
export interface McpTool {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  _meta: { 'vibase/surface': 'api' | 'meta' }
}
export interface ToolEntry {
  op: Operation
  tool: McpTool
}
export const deriveTools = (_registry: Registry): readonly ToolEntry[] => []
export const isVisible = (_op: Operation, _principal: Principal, _workspace: boolean): boolean => false
export const splitArguments = (_op: Operation, _args: Record<string, unknown>): OperationInput => ({ params: {}, query: {}, body: undefined })

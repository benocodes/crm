import type { Client, ClientOptions, OperationMap } from './types.js'
import type { BuiltInOperations } from './generated/types.js'

export function createClient<Ops extends OperationMap = BuiltInOperations>(_options: ClientOptions<Ops>): Client<Ops> {
  throw new Error('not implemented')
}

import type { ClientDeps } from './sync.js'
import type { ObjectStore } from '../../objects/store.js'
import type { MailSyncInstances } from '../../sync/request.js'
import type { Transport } from '../../executions/transport.js'
export type GmailTransportDeps=ClientDeps&{objects:ObjectStore;instances?:MailSyncInstances}
export function gmailTransport(_deps:GmailTransportDeps):Transport {return {dispatch:async()=>({kind:'unknown'}),reconcile:async()=>({kind:'unknown'})}}

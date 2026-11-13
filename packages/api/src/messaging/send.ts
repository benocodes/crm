import { enqueuedOperation } from '../executions/enqueue.js'
import { sendInput } from './send-input.js'
import { sql, type SqlBool } from 'kysely'
import { defineOperation,readMaybe,unit,type QueryContext,type Row } from '@vibase/storage'
import type { Authorisation,PrepareContext } from '../registry.js'
import type { PreparedEnv } from '../storage/definition.js'
import { ApiError } from '../errors.js'

export function requireReplyRead(env:PreparedEnv,args:Record<string,unknown>):void {
  if(args.mode==='reply'&&!env.scopes.has({resource:'messages',action:'read'}))throw new ApiError(403,'insufficient_scope','requires messages:read')
}
export const SEND_GRANTS=['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send']
export function sendConnectionQuery(org:string,id:string) {
  return sql<Row>`select c.id, c.identity_id, c.owner_id, c.account_id, c.updated_at, c.granted_scopes, i.value as mailbox
    from channel_connections c join identities i on i.id=c.identity_id and i.organization_id=c.organization_id
    where c.id=${id} and c.organization_id=${org} and c.provider='google' and c.status='active' and c.deleted_at is null
      and i.kind='email' and i.own=1 and i.deleted_at is null
      and exists(select 1 from json_each(c.granted_scopes) where value=${SEND_GRANTS[0]})
      and exists(select 1 from json_each(c.granted_scopes) where value=${SEND_GRANTS[1]})`
}
export function sendAnchorQuery(org:string,connection:string,thread:string) {
  return sql<Row>`select m.id as message_id,m.external_id,s.id as source_id,s.provider_message_id,s.provider_thread_id,m.occurred_at
    from messages m join message_sources s on s.message_id=m.id and s.organization_id=m.organization_id
    where m.organization_id=${org} and m.thread_id=${thread} and m.kind='message' and m.retracted_at is null and s.connection_id=${connection}
      and exists(select 1 from thread_sources t where t.organization_id=m.organization_id and t.thread_id=m.thread_id and t.connection_id=s.connection_id and t.provider_thread_id=s.provider_thread_id)
    order by m.occurred_at desc,m.id desc limit 1`
}

async function authorise(env:PreparedEnv,args:Record<string,unknown>,ctx:PrepareContext):Promise<Authorisation> {
  requireReplyRead(env,args)
  const id=String(args.connection_id)
  const connection=sendConnectionQuery(env.organizationId,id)
  const anchor=args.mode==='reply'?sendAnchorQuery(env.organizationId,id,String(args.thread_id)):null
  const planned=await ctx.read(defineOperation<{connection:Row|null,anchor:Row|null}>({name:'messages.send.authorise',mutates:false,
    reads:qc=>({connection:readMaybe(connection.compile(qc.db)),...(anchor?{anchor:readMaybe(anchor.compile(qc.db))}:{})}),
    build:found=>unit({steps:[],events:[],decode:()=>({connection:found.maybe('connection'),anchor:anchor?found.maybe('anchor'):null})})}))
  const c=planned.connection
  if(!c)throw new ApiError(409,'connection_cannot_send','connection cannot send')
  if(anchor&&!planned.anchor)throw new ApiError(409,'no_sendable_connection','thread has no sendable anchor on this connection')
  const a=planned.anchor
  // Pin every selected fact, including the independently mutable source and identity rows. The same selector in the guard also pins latest eligibility.
  const guards=(_qc:QueryContext)=>[
    sql<SqlBool>`exists(select 1 from (${connection}) c where c.identity_id=${c.identity_id} and c.owner_id=${c.owner_id} and c.account_id=${c.account_id} and c.updated_at=${c.updated_at} and c.granted_scopes=${c.granted_scopes} and c.mailbox=${c.mailbox})`,
    ...(a&&anchor?[sql<SqlBool>`exists(select 1 from (${anchor}) a where a.message_id=${a.message_id} and a.external_id=${a.external_id} and a.source_id=${a.source_id} and a.provider_message_id=${a.provider_message_id} and a.provider_thread_id=${a.provider_thread_id} and a.occurred_at=${a.occurred_at})`]:[]),
  ]
  return {clientRefDomain:String(c.mailbox).split('@')[1],resolution:{connection_id:id,owner_id:c.owner_id,mailbox:c.mailbox,...(a?{anchor:a}:{})},guards}
}

export function messageSendOperation() {
  const op=enqueuedOperation({name:'messages.send',summary:'Send plain-text email',path:'/messages/send',scope:{resource:'messages',action:'write'},readScope:{resource:'messages',action:'read'},transport:'gmail',input:sendInput,authorise})
  op.proposal={eligible:true,alsoRequires:'Reply requires messages:read. New mail needs no read scope. Connection credentials remain human-managed.'}
  return op
}

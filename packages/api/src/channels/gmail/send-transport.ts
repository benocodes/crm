import { gmailClientFor,markConnectionStatus,type ClientDeps } from './sync.js'
import type { ObjectStore } from '../../objects/store.js'
import { requestSync,type MailSyncInstances } from '../../sync/request.js'
import type { DispatchOutcome,Transport,TransportCall } from '../../executions/transport.js'
import { defineOperation,execute,readMaybe,unit,type Row } from '@vibase/storage'
import { sendConnectionQuery } from '../../messaging/send.js'
import { readSendBody } from '../../messaging/send-body.js'
import { GmailApiError,isGmailThrottle,type GmailClient } from './client.js'
import { GmailCredentialError,GoogleRefreshError } from './token.js'
import { GmailChannel,GmailAnchorError } from './channel.js'
import { header,messageIdTokens } from './mime.js'
export type GmailTransportDeps=ClientDeps&{objects:ObjectStore;instances?:MailSyncInstances}

export function gmailTransport(d:GmailTransportDeps):Transport {
  async function live(call:TransportCall):Promise<Row|null>{
    call.signal.throwIfAborted()
    const id=String(call.resolution.connection_id)
    const op=defineOperation<Row|null>({name:'gmail.send_connection',mutates:false,reads:qc=>({c:readMaybe(sendConnectionQuery(d.organizationId,id).compile(qc.db))}),build:found=>unit({steps:[],events:[],decode:()=>found.maybe('c')})})
    const c=(await execute(d.binding,{kind:'internal',organizationId:d.organizationId},op)).value
    // Reconnection to a different mailbox must not change the immutable From identity.
    return c&&c.mailbox===call.resolution.mailbox?c:null
  }
  async function kick(connectionId:string):Promise<void>{
    if(d.instances)try{await requestSync({...d,instances:d.instances},connectionId)}catch{/* The mark survives a lost start; a failed mark is served by stale recovery. Confirmed mail remains sent. */}
  }
  async function confirm(client:GmailClient,id:string,clientRef:string,threadId?:string):Promise<boolean>{
    const m=await client.getMessageMetadata(id)
    // Gmail rewrites the Message-ID on send, so the header cannot be compared with `clientRef`: the id, thread and SENT label are the proof.
    void clientRef
    return m.id===id&&typeof m.threadId==='string'&&m.threadId.length>0&&(!threadId||m.threadId===threadId)&&m.labelIds?.includes('SENT')===true
  }
  const result=(call:TransportCall)=>({connection_id:String(call.resolution.connection_id),external_id:call.clientRef})
  async function markInvalidGrant(err:unknown,call:TransportCall):Promise<boolean>{
    if(!(err instanceof GoogleRefreshError)||err.code!=='invalid_grant')return false
    try{await markConnectionStatus(d,String(call.resolution.connection_id),String(call.resolution.owner_id),'reauth_required','invalid_grant')}catch{/* safe failure result, no provider detail */}
    return true
  }
  async function classify(err:unknown,posted:boolean,call:TransportCall):Promise<DispatchOutcome>{
    if(await markInvalidGrant(err,call))return {kind:'not_sent',code:'reauth_required'}
    if(err instanceof GmailCredentialError)return {kind:'not_sent',code:'reauth_required'}
    if(err instanceof GmailAnchorError)return {kind:'not_sent',code:'anchor_missing'}
    if(err instanceof GmailApiError){
      const throttled:boolean=isGmailThrottle(err)
      if(throttled)return {kind:'not_sent',code:'retryable',...(err.retryAfterSeconds!==null?{retryAfterMs:err.retryAfterSeconds*1000}:{})}
      if(err.status===401)return {kind:'not_sent',code:'reauth_required'}
      if(err.status===403)return {kind:'not_sent',code:'permission_missing'}
      if(err.status===400||err.status===404)return {kind:'not_sent',code:!posted&&call.arguments.mode==='reply'?'anchor_missing':'provider_rejected'}
    }
    return posted?{kind:'unknown'}:{kind:'not_sent',code:'retryable'}
  }
  return {
    async dispatch(call){
      let posted=false
      try{
        const c=await live(call)
        if(!c)return {kind:'not_sent',code:'permission_missing'}
        let text:string
        try{text=await readSendBody(d.objects,d.organizationId,call.arguments.body)}catch{return {kind:'not_sent',code:'provider_rejected'}}
        call.signal.throwIfAborted()
        const client=gmailClientFor(d,String(c.id),String(c.owner_id),call.signal)
        const a=call.resolution.anchor as Record<string,unknown>|undefined
        const sent=await new GmailChannel(client).postToThread({from:String(call.resolution.mailbox),to:(call.arguments.to??[]) as string[],cc:(call.arguments.cc??[]) as string[],bcc:(call.arguments.bcc??[]) as string[],subject:String(call.arguments.subject??''),text,client_ref:call.clientRef,provider_thread_id:a?String(a.provider_thread_id):null,provider_anchor_id:a?String(a.provider_message_id):null,...(a?{anchor_external_id:String(a.external_id)}:{})},call.signal,()=>{posted=true})
        // A successful POST response is the provider's acceptance: that is delivery, no second look needed.
        await kick(String(c.id));return {kind:'sent',result:result(call)}
      }catch(err){return classify(err,posted,call)}
    },
    async reconcile(call){
      try{
        const c=await live(call);if(!c)return {kind:'unknown'}
        const client=gmailClientFor(d,String(c.id),String(c.owner_id),call.signal)
        const matches=await client.listMessages({q:`rfc822msgid:${call.clientRef} in:sent`,maxResults:2})
        if(matches.nextPageToken||matches.messages.length!==1)return {kind:'unknown'}
        const m=matches.messages[0]!
        if(!await confirm(client,m.id,call.clientRef,m.threadId))return {kind:'unknown'}
        await kick(String(c.id));return {kind:'found',result:result(call)}
      }catch(err){await markInvalidGrant(err,call);return {kind:'unknown'}}
    },
  }
}

import { afterAll,beforeAll,beforeEach,expect,it } from 'vitest'
import { execute,uuidv7 } from '@vault/storage'
import { openActionKit,type ActionKit } from '../../test/action-kit.js'
import { connectOperation } from '../../connections/connect.js'
import { sealToken } from '../../connections/credentials.js'
import { ScopeSet } from '../../scopes.js'
import { memoryObjectStore } from '../../objects/store.js'
import { storeSendBody } from '../../messaging/send-body.js'
import { gmailTransport,type GmailTransportDeps } from './send-transport.js'
import type { TransportCall } from '../../executions/transport.js'
import { runExecution } from '../../executions/runner.js'

let k:ActionKit,connection:string,owner:string
const objects=memoryObjectStore(),key=new Uint8Array(32).fill(7)
let posts=0,kicks=0,refreshes=0,searches=0,accepted=false,lose=false,empty=0,ambiguous=false,failStatus=0,failReason='',badConfirmation=false
const seenSignals:unknown[]=[]
const f:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));seenSignals.push(init?.signal)
  if(url.hostname==='oauth2.googleapis.com'){refreshes++;return Response.json({access_token:'fake-access-token'})}
  if(url.pathname.endsWith('/messages/send')){
    posts++;if(failStatus)return Response.json({error:{errors:[{reason:failReason}],message:'PROVIDER_SECRET_CANARY'}},{status:failStatus,headers:{'Retry-After':'17'}})
    accepted=true;if(lose)throw new Error('LOST_PROVIDER_SECRET_CANARY')
    return Response.json({id:'sent-provider-id',threadId:'sent-provider-thread'})
  }
  if(url.pathname.endsWith('/messages')){
    searches++;expect(url.searchParams.get('q')).toBe('rfc822msgid:fixed@example.test in:sent');expect(url.searchParams.get('maxResults')).toBe('2')
    if(empty-->0||!accepted)return Response.json({messages:[]})
    return Response.json({messages:[{id:'sent-provider-id',threadId:'sent-provider-thread'},...(ambiguous?[{id:'second'}]:[])]})
  }
  if(url.pathname.endsWith('/messages/sent-provider-id'))return Response.json({id:'sent-provider-id',threadId:'sent-provider-thread',labelIds:['SENT'],payload:{headers:[{name:'Message-ID',value:badConfirmation?'<wrong@example.test>':'<fixed@example.test>'}]}})
  throw new Error('unexpected fake URL')
}
const deps=():GmailTransportDeps=>({binding:k.binding,organizationId:k.organizationId,objects,config:{clientId:'fake-client',clientSecret:'fake-secret',credentialsKey:key,keyVersion:1},fetch:f,clock:k.now,newId:uuidv7,randomBytes:n=>crypto.getRandomValues(new Uint8Array(n)),instances:{create:async()=>{kicks++}}})
const call=async():Promise<TransportCall>=>({executionId:uuidv7(),operation:'messages.send',arguments:{connection_id:connection,mode:'new',subject:'Hello',to:['recipient@example.test'],cc:[],bcc:[],body:await storeSendBody(objects,k.organizationId,'TRANSPORT_BODY_CANARY')},resolution:{connection_id:connection,mailbox:'owner@example.test',owner_id:owner},clientRef:'fixed@example.test',attempt:1,signal:new AbortController().signal})
beforeAll(async()=>{k=await openActionKit({objects})})
afterAll(()=>k.close())
beforeEach(async()=>{
  await k.reset();owner=k.owner.id;posts=kicks=refreshes=searches=empty=failStatus=0;accepted=lose=ambiguous=badConfirmation=false;failReason='';seenSignals.length=0
  const env={actor:{id:owner,kind:'user' as const},organizationId:k.organizationId,scopes:ScopeSet.parse(k.owner.scopes),now:k.now(),newId:uuidv7,randomBytes:(n:number)=>crypto.getRandomValues(new Uint8Array(n))}
  connection=(await execute(k.binding,{kind:'tenant',actorId:owner,organizationId:k.organizationId},connectOperation(env,{google_sub:'transport-owner',mailbox:'owner@example.test',own_addresses:['owner@example.test'],granted_scopes:['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send'],ciphertext:await sealToken(key,'fake-refresh-token',crypto.getRandomValues(new Uint8Array(12))),key_version:1,history_id:'1000'}))).value.connection_id
})
it('dispatch confirms exact RFC id/SENT before sync; result uses external id rather than provider id, under one signal',async()=>{
  const c=await call(),t=gmailTransport(deps())
  expect(await t.dispatch(c)).toEqual({kind:'sent',result:{connection_id:connection,external_id:'fixed@example.test'}})
  expect([posts,refreshes,kicks]).toEqual([1,1,1]);expect(seenSignals.every(s=>s===c.signal)).toBe(true)
})
it('lost accepted POST and delayed search never permit a second POST; eventually positive evidence finds delivery',async()=>{
  const c=await call(),t=gmailTransport(deps());lose=true;empty=1
  expect(await t.dispatch(c)).toEqual({kind:'unknown'})
  expect(await t.reconcile!(c)).toEqual({kind:'unknown'});expect(kicks).toBe(0)
  expect(await t.reconcile!(c)).toEqual({kind:'found',result:{connection_id:connection,external_id:'fixed@example.test'}})
  expect(posts).toBe(1);expect(kicks).toBe(1)
})
it.each([{status:400,code:'provider_rejected'},{status:401,code:'reauth_required'},{status:403,code:'permission_missing'},{status:404,code:'provider_rejected'},{status:429,code:'retryable'},{status:403,reason:'rateLimitExceeded',code:'retryable'},{status:403,reason:'userRateLimitExceeded',code:'retryable'}])('classifies explicit send refusal $status $reason safely',async({status,code,reason})=>{
  failStatus=status;failReason=reason??'';const outcome=await gmailTransport(deps()).dispatch(await call())
  expect(outcome).toEqual({kind:'not_sent',code,...(code==='retryable'?{retryAfterMs:17000}:{})});expect(kicks).toBe(0);expect(JSON.stringify(outcome)).not.toContain('CANARY')
})
it.each([408,500,503])('send HTTP %s is uncertain',async(status)=>{failStatus=status;expect(await gmailTransport(deps()).dispatch(await call())).toEqual({kind:'unknown'});expect(kicks).toBe(0)})
it('bad confirmation is unknown and ambiguous search is unknown; neither starts capture',async()=>{
  badConfirmation=true;const t=gmailTransport(deps()),c=await call();expect(await t.dispatch(c)).toEqual({kind:'unknown'})
  expect(await t.reconcile!(c)).toEqual({kind:'unknown'});badConfirmation=false;ambiguous=true
  expect(await t.reconcile!(c)).toEqual({kind:'unknown'});expect(posts).toBe(1);expect(kicks).toBe(0)
})
it('a failed capture start retains its mark and never downgrades confirmed delivery',async()=>{
  const d=deps();d.instances={create:async()=>{throw new Error('lost-start')}}
  expect((await gmailTransport(d).dispatch(await call())).kind).toBe('sent')
  expect((await k.rows('mail_sync_state'))[0]!.sync_requested_at).toBe(k.now().toISOString());expect(posts).toBe(1)
})
it('missing body and revoked connection fail before any POST, missing credential is reauth_required',async()=>{
  const c=await call();await objects.delete(`orgs/${k.organizationId}/outbound/sha256/${(c.arguments.body as {sha256:string}).sha256}/body.txt`)
  expect(await gmailTransport(deps()).dispatch(c)).toEqual({kind:'not_sent',code:'provider_rejected'});expect(posts).toBe(0)
  const good=await call();await k.d1.prepare('delete from channel_credentials where connection_id=?').bind(connection).run()
  expect(await gmailTransport(deps()).dispatch(good)).toEqual({kind:'not_sent',code:'reauth_required'});expect(posts).toBe(0)
})

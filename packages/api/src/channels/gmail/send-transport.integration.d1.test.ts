import { afterAll,beforeAll,beforeEach,expect,it } from 'vitest'
import { execute,uuidv7 } from '@vault/storage'
import { openActionKit,type ActionKit } from '../../test/action-kit.js'
import { connectOperation } from '../../connections/connect.js'
import { sealToken } from '../../connections/credentials.js'
import { ScopeSet } from '../../scopes.js'
import { memoryObjectStore } from '../../objects/store.js'
import { runExecution,MAX_ATTEMPTS } from '../../executions/runner.js'
import { dueConnections,STALE_MS } from '../../sync/request.js'
import { storeSendBody } from '../../messaging/send-body.js'
import { gmailTransport,type GmailTransportDeps } from './send-transport.js'
import type { TransportCall } from '../../executions/transport.js'

let k:ActionKit,connection:string,owner:string
const objects=memoryObjectStore(),key=new Uint8Array(32).fill(7)
let posts=0,kicks=0,refreshes=0,searches=0,accepted=false,lose=false,empty=0,ambiguous=false,failStatus=0,failReason='',badConfirmation=false
let expectedRef='fixed@example.test'
let refreshInvalid=false,badSuccess=false,refreshHold:(()=>Promise<void>)|undefined,metadataHold:(()=>Promise<void>)|undefined
const seenSignals:unknown[]=[]
const f:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));seenSignals.push(init?.signal)
  if(url.hostname==='oauth2.googleapis.com'){refreshes++;if(refreshHold)await refreshHold();if(refreshInvalid)return Response.json({error:'invalid_grant',error_description:'PROVIDER_SECRET_CANARY'},{status:400});return Response.json({access_token:'fake-access-token'})}
  if(url.pathname.endsWith('/messages/send')){
    posts++;if(failStatus)return Response.json({error:{errors:[{reason:failReason}],message:'PROVIDER_SECRET_CANARY'}},{status:failStatus,headers:{'Retry-After':'17'}})
    accepted=true;if(badSuccess)return Response.json({unexpected:'PROVIDER_SECRET_CANARY'});if(lose)throw new Error('LOST_PROVIDER_SECRET_CANARY')
    return Response.json({id:'sent-provider-id',threadId:'sent-provider-thread'})
  }
  if(url.pathname.endsWith('/messages')){
    searches++;expect(url.searchParams.get('q')).toBe(`rfc822msgid:${expectedRef} in:sent`);expect(url.searchParams.get('maxResults')).toBe('2')
    if(empty-->0||!accepted)return Response.json({messages:[]})
    return Response.json({messages:[{id:'sent-provider-id',threadId:'sent-provider-thread'},...(ambiguous?[{id:'second'}]:[])]})
  }
  if(url.pathname.endsWith('/messages/sent-provider-id')){if(metadataHold)await metadataHold();return Response.json({id:'sent-provider-id',threadId:'sent-provider-thread',labelIds:['SENT'],payload:{headers:[{name:'Message-ID',value:badConfirmation?'<wrong@example.test>':`<${expectedRef}>`}]}})}
  throw new Error('unexpected fake URL')
}
const deps=():GmailTransportDeps=>({binding:k.binding,organizationId:k.organizationId,objects,config:{clientId:'fake-client',clientSecret:'fake-secret',credentialsKey:key,keyVersion:1},fetch:f,clock:k.now,newId:uuidv7,randomBytes:n=>crypto.getRandomValues(new Uint8Array(n)),instances:{create:async()=>{kicks++}}})
const call=async():Promise<TransportCall>=>({executionId:uuidv7(),operation:'messages.send',arguments:{connection_id:connection,mode:'new',subject:'Hello',to:['recipient@example.test'],cc:[],bcc:[],body:await storeSendBody(objects,k.organizationId,'TRANSPORT_BODY_CANARY')},resolution:{connection_id:connection,mailbox:'owner@example.test',owner_id:owner},clientRef:'fixed@example.test',attempt:1,signal:new AbortController().signal})
beforeAll(async()=>{k=await openActionKit({objects})})
afterAll(()=>k.close())
beforeEach(async()=>{
  await k.reset();owner=k.owner.id;posts=kicks=refreshes=searches=empty=failStatus=0;accepted=lose=ambiguous=badConfirmation=false;failReason='';expectedRef='fixed@example.test';refreshInvalid=badSuccess=false;refreshHold=metadataHold=undefined;seenSignals.length=0
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

it.each(['invalid_grant','unreadable','key_version','inactive','grant'] as const)('pre-POST credential/connection failure %s is definite and safe, including owner reauth attribution',async fault=>{
  const c=await call()
  if(fault==='invalid_grant')refreshInvalid=true
  if(fault==='unreadable')await k.d1.prepare("update channel_credentials set refresh_token_ciphertext='unreadable'").run()
  if(fault==='key_version')await k.d1.prepare('update channel_credentials set key_version=99').run()
  if(fault==='inactive')await k.d1.prepare("update channel_connections set status='suspended'").run()
  if(fault==='grant')await k.d1.prepare("update channel_connections set granted_scopes='[]'").run()
  expect(await gmailTransport(deps()).dispatch(c)).toEqual({kind:'not_sent',code:['inactive','grant'].includes(fault)?'permission_missing':'reauth_required'})
  expect(posts).toBe(0);expect(kicks).toBe(0)
  if(fault==='invalid_grant'){
    expect((await k.rows('channel_connections'))[0].status).toBe('reauth_required')
    const event=(await k.events('connection.updated')).at(-1)!;expect(event.actor_id).toBe(owner)
    expect(JSON.stringify(event)).not.toContain('PROVIDER_SECRET')
  }
})
it('malformed success is unknown, and credential failure while reconciling never changes uncertainty into a refusal',async()=>{
  const c=await call();badSuccess=true;const t=gmailTransport(deps())
  expect(await t.dispatch(c)).toEqual({kind:'unknown'});expect(kicks).toBe(0)
  refreshInvalid=true;expect(await t.reconcile!(c)).toEqual({kind:'unknown'});expect(posts).toBe(1)
  expect((await k.rows('channel_connections'))[0].status).toBe('reauth_required');expect((await k.events('connection.updated')).at(-1)!.actor_id).toBe(owner)
})
it('late abort-ignoring refresh cannot POST or rotate after the shared signal expires',async()=>{
  const c=await call(),controller=new AbortController();c.signal=controller.signal
  refreshHold=async()=>{controller.abort();await Promise.resolve()}
  const out=await gmailTransport(deps()).dispatch(c)
  expect(out.kind).not.toBe('sent');expect(posts).toBe(0);expect(seenSignals).toEqual([controller.signal])
})
it('one signal aborting during confirmation leaves unknown and never marks capture',async()=>{
  const c=await call(),controller=new AbortController();c.signal=controller.signal
  metadataHold=async()=>{controller.abort();throw new DOMException('aborted','AbortError')}
  expect(await gmailTransport(deps()).dispatch(c)).toEqual({kind:'unknown'})
  expect(posts).toBe(1);expect(kicks).toBe(0);expect(seenSignals.every(s=>s===controller.signal)).toBe(true)
})
it('failed mark keeps confirmed delivery and existing stale recovery serves it; lost start mark is due immediately',async()=>{
  const d=deps(),binding=d.binding
  // A failing mark after confirmation is swallowed only by the post-confirmation scheduling seam.
  d.binding={...binding,runtime:{...binding.runtime,execute:async (...a)=>{
    if(a[1].name==='sync.mark_requested')throw new Error('mark failed')
    return binding.runtime.execute(...a)
  }}} as typeof binding
  expect((await gmailTransport(d).dispatch(await call())).kind).toBe('sent');expect(kicks).toBe(0)
  expect(await dueConnections(deps(),new Date(k.now().getTime()+STALE_MS))).toContain(connection)
  const retry=deps();retry.instances={create:async()=>{throw new Error('lost start')}}
  expect((await gmailTransport(retry).dispatch(await call())).kind).toBe('sent')
  expect(await dueConnections(deps(),k.now())).toContain(connection)
})
it.each([400,401,403,404,429,408,503])('real runner mirrors provider %s outcomes safely to its approved request and audit',async status=>{
  const p=await k.call(k.owner,'POST','/api/v1/action-requests',{operation:'messages.send',arguments:{connection_id:connection,mode:'new',subject:'Hello',to:['recipient@example.test'],body:'RUNNER_PRIVATE_CANARY'},reason:'review'})
  expect(p.status).toBe(201)
  const a=await k.call(k.owner,'POST',`/api/v1/action-requests/${p.body.id}/approve`,{});expect(a.status).toBe(200)
  failStatus=status
  const out=await runExecution({binding:k.binding,registry:k.registry,transports:{gmail:gmailTransport(deps())},clock:k.now,newId:uuidv7},a.body.execution_id)
  const expected:Record<number,string>={400:'provider_rejected',401:'reauth_required',403:'permission_missing',404:'provider_rejected'}
  expect(out).toEqual(expected[status]?{outcome:'failed',code:expected[status]}:{outcome:'retry'})
  const e=(await k.rows('action_executions'))[0],r=(await k.rows('action_requests'))[0]
  expect(e.authorised_by).toBe(owner);expect(r.status).toBe(expected[status]?'failed':'approved')
  if(expected[status]){
    expect([e.error_code,r.error_code]).toEqual([expected[status],expected[status]])
    expect((await k.events('action_execution.failed'))[0].actor_id).toBe(owner)
    expect((await k.events('action_request.failed'))[0].actor_id).toBe(owner)
  }
  for(const value of [await k.events(),e,r,out])for(const secret of ['RUNNER_PRIVATE_CANARY','PROVIDER_SECRET_CANARY','fake-refresh-token','/outbound/'])expect(JSON.stringify(value)).not.toContain(secret)
})
it('runner reaches outcome_unknown at the attempt bound after empty search without repeating an accepted POST',async()=>{
  const r=await k.call(k.owner,'POST','/api/v1/messages/send',{connection_id:connection,mode:'new',subject:'Hello',to:['recipient@example.test'],body:'BOUND_PRIVATE_CANARY',idempotency_key:'unknown-bound'})
  expectedRef=String((await k.rows('action_executions'))[0].client_ref);lose=true;empty=100
  const d={binding:k.binding,registry:k.registry,transports:{gmail:gmailTransport(deps())},clock:k.now,newId:uuidv7}
  for(let n=0;n<MAX_ATTEMPTS;n++){
    const out=await runExecution(d,r.body.id)
    expect(out).toEqual(n===MAX_ATTEMPTS-1?{outcome:'failed',code:'outcome_unknown'}:{outcome:'retry'})
    const e=(await k.rows('action_executions'))[0];k.setNow(new Date(String(e.next_attempt_at)))
  }
  expect(posts).toBe(1);expect(kicks).toBe(0);expect((await k.rows('action_executions'))[0].error_code).toBe('outcome_unknown')
})

it('a missing pinned reply anchor is anchor_missing before POST, not a search for a newer anchor',async()=>{
  const c=await call();c.arguments.mode='reply';c.resolution.anchor={provider_message_id:'missing-anchor',provider_thread_id:'thread',external_id:'anchor@example.test'}
  const d=deps();d.fetch=async(input,init)=>String(input).includes('/messages/missing-anchor')?Response.json({error:{message:'PROVIDER_SECRET_CANARY'}},{status:404}):f(input,init)
  expect(await gmailTransport(d).dispatch(c)).toEqual({kind:'not_sent',code:'anchor_missing'});expect(posts).toBe(0);expect(searches).toBe(0)
})

it('confirmed runner success completes execution/request with fixed-authoriser audit and private descriptors',async()=>{
  const proposer=await k.actor('composer','agent',['messages:request_approval'])
  const p=await k.call(proposer,'POST','/api/v1/action-requests',{operation:'messages.send',arguments:{connection_id:connection,mode:'new',subject:'Hello',to:['recipient@example.test'],body:'SUCCESS_PRIVATE_CANARY'},reason:'review'})
  const a=await k.call(k.owner,'POST',`/api/v1/action-requests/${p.body.id}/approve`,{});expect(a.status).toBe(200)
  expectedRef=String((await k.rows('action_executions'))[0].client_ref)
  expect(await runExecution({binding:k.binding,registry:k.registry,transports:{gmail:gmailTransport(deps())},clock:k.now,newId:uuidv7},a.body.execution_id)).toEqual({outcome:'done'})
  expect((await k.rows('action_executions'))[0]).toMatchObject({status:'done',created_by:proposer.id,authorised_by:owner,result:{connection_id:connection,external_id:expectedRef}})
  expect((await k.rows('action_requests'))[0].status).toBe('executed')
  for(const type of ['action_execution.completed','action_request.executed'])expect((await k.events(type))[0].actor_id).toBe(owner)
  for(const value of [await k.rows('action_executions'),await k.rows('action_requests'),await k.events()]){
    expect(JSON.stringify(value)).not.toContain('SUCCESS_PRIVATE_CANARY');expect(JSON.stringify(value)).not.toContain('/outbound/')
  }
  expect(posts).toBe(1);expect(kicks).toBe(1)
})

it('a slow abort-ignoring refresh is bounded by the rail; lease recovery reconciles and late credentials never POST',async()=>{
  const r=await k.call(k.owner,'POST','/api/v1/messages/send',{connection_id:connection,mode:'new',subject:'Hello',to:['recipient@example.test'],body:'LATE_PRIVATE_CANARY',idempotency_key:'slow-refresh'})
  expectedRef=String((await k.rows('action_executions'))[0].client_ref)
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve});let reached!:()=>void;const started=new Promise<void>(resolve=>{reached=resolve});let calls=0
  refreshHold=async()=>{if(++calls===1){reached();await held}}
  const d={binding:k.binding,registry:k.registry,transports:{gmail:gmailTransport(deps())},clock:k.now,newId:uuidv7,attemptBudgetMs:1500}
  const running=runExecution(d,r.body.id)
  await Promise.race([started,running.then(()=>{throw new Error('attempt expired before reaching refresh')})])
  expect(await running).toEqual({outcome:'retry'})
  expect(posts).toBe(0);expect((seenSignals[0] as AbortSignal).aborted).toBe(true)
  k.setNow(new Date(k.now().getTime()+120000))
  expect(await runExecution(d,r.body.id)).toEqual({outcome:'retry'});expect(searches).toBe(1)
  release();await new Promise(resolve=>setTimeout(resolve,10))
  expect(posts).toBe(0);expect(kicks).toBe(0)
})

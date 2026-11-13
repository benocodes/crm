import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { execute, uuidv7 } from '@vibase/storage'
import { openActionKit, type ActionKit, type Actor } from '../test/action-kit.js'
import { connectOperation } from '../connections/connect.js'
import { memoryObjectStore, type ObjectStore } from '../objects/store.js'
import { ScopeSet } from '../scopes.js'
import { captureMessage,type CaptureOverrides } from '../test/capture-kit.js'
import { expireOverdueRequests } from '../executions/runner.js'
import { createApp } from '../rest/app.js'
import { fakeUserAuthenticator,mintTestUserToken } from '../test/user-auth.js'
import { deriveTools } from '../mcp/tools.js'
import { recordMessagesOperation } from '../messaging/capture.js'

let k: ActionKit, writer: Actor, proposer: Actor, connection: string
const mem = memoryObjectStore()
let puts = 0, gets = 0, failPut = false
const store: ObjectStore = {...mem,put:async(...args)=>{puts++;if(failPut)throw new Error('put failed');await mem.put(...args)},get:async(...args)=>{gets++;return mem.get(...args)}}
const AR='/api/v1/action-requests', SEND='/api/v1/messages/send'
const args = () => ({connection_id:connection,mode:'new',subject:'Hello 世界',to:[' recipient@example.test '],body:'BODY_CANARY hé\r\n世界'})
const direct = (actor=writer,patch={}) => k.call(actor,'POST',SEND,{...args(),idempotency_key:'direct',...patch})
const propose = (actor=proposer,extra={}) => k.call(actor,'POST',AR,{operation:'messages.send',arguments:args(),reason:'review',...extra})
const envOf=()=>({actor:{id:k.owner.id,kind:'user' as const},organizationId:k.organizationId,scopes:ScopeSet.parse(k.owner.scopes),now:k.now(),newId:()=>uuidv7(),randomBytes:(n:number)=>crypto.getRandomValues(new Uint8Array(n))})
const inbound=async(over:CaptureOverrides={})=>{
  const msg=captureMessage(k.organizationId,{provider_thread_id:'anchor-thread',...over})
  const result=await execute(k.binding,{kind:'tenant',actorId:k.owner.id,organizationId:k.organizationId},recordMessagesOperation(envOf(),{connection_id:connection,messages:[msg]}))
  return {...result.value.captured[0]!,provider_message_id:msg.provider_message_id,external_id:msg.external_id}
}
beforeAll(async()=>{k=await openActionKit({objects:store})})
afterAll(()=>k.close())
beforeEach(async()=>{
  await k.reset();k.setNow(new Date('2026-11-06T10:00:00.000Z')); puts=gets=0;failPut=false
  writer=await k.actor('writer','agent',['messages:write','messages:read','action_requests:read'])
  proposer=await k.actor('proposer','agent',['messages:request_approval','messages:read','action_requests:read'])
  const env={actor:{id:k.owner.id,kind:'user' as const},organizationId:k.organizationId,scopes:ScopeSet.parse(k.owner.scopes),now:k.now(),newId:()=>uuidv7(),randomBytes:(n:number)=>crypto.getRandomValues(new Uint8Array(n))}
  const out=await execute(k.binding,{kind:'tenant',actorId:k.owner.id,organizationId:k.organizationId},connectOperation(env,{google_sub:'send-owner',mailbox:'owner@example.test',own_addresses:['owner@example.test'],granted_scopes:['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send'],ciphertext:'fake-encrypted-token',key_version:1,history_id:'1000'}))
  connection=out.value.connection_id
})
it('direct send writes an immutable descriptor and connection FK, no synthetic request/history; authorised get alone hydrates',async()=>{
  const r=await direct();expect(r.status).toBe(202)
  expect(r.body.arguments.body).toEqual({sha256:expect.stringMatching(/^[a-f0-9]{64}$/),size_bytes:23})
  expect((await k.rows('action_executions'))[0]).toMatchObject({connection_id:connection,created_by:writer.id,authorised_by:writer.id,arguments:r.body.arguments,resolution:{connection_id:connection,mailbox:'owner@example.test'}})
  for(const table of ['action_requests','messages','interactions','files'])expect(await k.rows(table)).toEqual([])
  expect(JSON.stringify(await k.events())).not.toContain('BODY_CANARY')
  const get=await k.call(writer,'GET',`/api/v1/action-executions/${r.body.id}`)
  expect(get.body.arguments.body).toBe(args().body)
  expect(JSON.stringify((await k.call(writer,'GET','/api/v1/action-executions')).body)).not.toContain('BODY_CANARY')
  expect((await k.call(k.as(writer,['messages:write']),'GET',`/api/v1/action-executions/${r.body.id}`)).status).toBe(404)
})
it('direct replay precedes object I/O and authorisation; changed bytes conflict and callers do not collide',async()=>{
  const first=await direct();expect(first.status).toBe(202)
  await k.d1.prepare("update channel_connections set status='suspended' where id=?").bind(connection).run()
  const io=[puts,gets];const again=await direct();expect([again.status,again.body.id]).toEqual([202,first.body.id]);expect([puts,gets]).toEqual(io)
  expect((await direct(writer,{body:'changed'})).body.error.code).toBe('idempotency_key_reused')
  expect((await direct(k.owner)).body.error.code).toBe('connection_cannot_send')
})
it('proposal and edited approval preserve original bytes and only descriptors on every audit producer',async()=>{
  const p=await propose();expect(p.status).toBe(201);expect(await k.rows('action_executions')).toEqual([])
  expect(JSON.stringify(p.body)).not.toContain('BODY_CANARY')
  expect((await k.call(proposer,'GET',`${AR}/${p.body.id}`)).body.arguments.body).toBe(args().body)
  expect((await k.call(proposer,'POST',`${AR}/${p.body.id}/approve`,{})).status).toBe(403)
  const a=await k.call(writer,'POST',`${AR}/${p.body.id}/approve`,{edited_arguments:{...args(),body:'EDIT_CANARY'}})
  expect(a.status).toBe(200);expect(a.body.status).toBe('approved')
  for(const table of ['action_requests','action_executions','events']){const json=JSON.stringify(await k.rows(table));expect(json).not.toContain('BODY_CANARY');expect(json).not.toContain('EDIT_CANARY');expect(json).not.toContain('/outbound/')}
  const r=await k.call(proposer,'GET',`${AR}/${p.body.id}`)
  expect(r.body.arguments.body).toBe(args().body);expect(r.body.edited_arguments.body).toBe('EDIT_CANARY')
  const e=(await k.rows('action_executions'))[0];expect(e).toMatchObject({created_by:proposer.id,authorised_by:writer.id,connection_id:connection})
  for(const table of ['action_requests','action_executions','events']){const text=JSON.stringify(await k.rows(table));expect(text).not.toContain('BODY_CANARY');expect(text).not.toContain('EDIT_CANARY');expect(text).not.toContain('/outbound/')}
})
it('failed put leaves no resource writes',async()=>{
  const before=await k.events();failPut=true
  expect((await direct()).status).toBe(503);expect(await k.rows('action_executions')).toEqual([]);expect(await k.events()).toEqual(before)
  expect((await propose()).status).toBe(503);expect(await k.rows('action_requests')).toEqual([]);expect(await k.events()).toEqual(before)
})
it.each([{scopes:[]},{scopes:['messages:read']},{scopes:['messages:request_approval']}])('refuses direct send without write $scopes',async ({scopes})=>{
  const actor=k.as(writer,scopes);expect((await direct(actor)).status).toBe(403);expect(await k.rows('action_executions')).toEqual([])
})
it('reply needs its independent read at both proposal and direct submission',async()=>{
  const reply={...args(),mode:'reply',thread_id:uuidv7(),subject:undefined}
  const d=await direct(k.as(writer,['messages:write']),reply);expect([d.status,d.body.error.code]).toEqual([403,'insufficient_scope'])
  const p=await propose(k.as(proposer,['messages:request_approval']),{arguments:reply});expect([p.status,p.body.error.code]).toEqual([403,'insufficient_scope'])
})
const sendContextState = async () => ({requests:await k.rows('action_requests'),executions:await k.rows('action_executions'),events:await k.events()})
const contextProposer = () => k.as(proposer,[...proposer.scopes,'interactions:read'])
const replyTo = (threadId:string) => ({...args(),mode:'reply',thread_id:threadId,subject:undefined})
it('reply context rejects a mismatched interaction at creation without a top-level thread and writes nothing',async()=>{
  const a=await inbound(), b=await inbound({provider_thread_id:'context-B'})
  expect(a.thread_id).not.toBe(b.thread_id)
  const before=await sendContextState()
  const out=await propose(contextProposer(),{arguments:replyTo(a.thread_id),interaction_id:b.interaction_id})
  expect([out.status,out.body.error?.code]).toEqual([400,'validation_error'])
  expect(await sendContextState()).toEqual(before)
})
it.each([false,true])('reply context accepts matching interaction without a top-level thread through approval (edited=%s)',async edited=>{
  const a=await inbound()
  const p=await propose(contextProposer(),{arguments:replyTo(a.thread_id),interaction_id:a.interaction_id})
  expect(p.status).toBe(201);expect(p.body).toMatchObject({thread_id:null,interaction_id:a.interaction_id})
  const out=await k.call(writer,'POST',`${AR}/${p.body.id}/approve`,edited?{edited_arguments:{...replyTo(a.thread_id),body:'approved context edit'}}:{})
  expect(out.status).toBe(200)
  expect(out.body).toMatchObject({status:'approved',thread_id:null,interaction_id:a.interaction_id})
  const execution=(await k.rows('action_executions'))[0]!
  expect(execution.arguments.thread_id).toBe(a.thread_id)
  expect(execution.resolution.anchor.message_id).toBe(a.message_id)
  expect((await k.call(proposer,'GET',`${AR}/${p.body.id}`)).body).toMatchObject({arguments:{body:args().body},edited_arguments:edited?{body:'approved context edit'}:null})
})
it('reply context rejects an edited reply moving away from its immutable interaction and writes nothing',async()=>{
  const a=await inbound(), b=await inbound({provider_thread_id:'context-B'})
  const p=await propose(contextProposer(),{arguments:replyTo(a.thread_id),interaction_id:a.interaction_id})
  expect(p.status).toBe(201)
  const before=await sendContextState()
  const out=await k.call(writer,'POST',`${AR}/${p.body.id}/approve`,{edited_arguments:replyTo(b.thread_id)})
  expect([out.status,out.body.error?.code]).toEqual([400,'validation_error'])
  expect(await sendContextState()).toEqual(before)
})
it('reply context revalidates a malformed legacy pending row at approval and writes nothing',async()=>{
  const a=await inbound(), b=await inbound({provider_thread_id:'context-B'})
  const p=await propose(contextProposer(),{arguments:replyTo(a.thread_id),interaction_id:a.interaction_id})
  expect(p.status).toBe(201)
  // Reproduce a row accepted before R1: stored immutable context A, reply arguments B, no top-level thread.
  const original=(await k.rows('action_requests'))[0]!
  await k.d1.prepare('update action_requests set arguments=? where id=?').bind(JSON.stringify({...original.arguments,thread_id:b.thread_id}),p.body.id).run()
  const before=await sendContextState()
  const out=await k.call(writer,'POST',`${AR}/${p.body.id}/approve`,{})
  expect([out.status,out.body.error?.code]).toEqual([400,'validation_error'])
  expect(await sendContextState()).toEqual(before)
})
it('reply context retains independent interaction read and reference checks at creation',async()=>{
  const a=await inbound()
  const before=await sendContextState()
  const unread=await propose(proposer,{arguments:replyTo(a.thread_id),interaction_id:a.interaction_id})
  expect([unread.status,unread.body.error?.code]).toEqual([403,'insufficient_scope'])
  expect(await sendContextState()).toEqual(before)
  const missing=await propose(contextProposer(),{arguments:replyTo(a.thread_id),interaction_id:uuidv7()})
  expect([missing.status,missing.body.error?.code]).toEqual([400,'invalid_reference'])
  expect(await sendContextState()).toEqual(before)
})
it('new send needs write alone and infers no read or mailbox ownership requirement',async()=>{
  const r=await direct(k.as(writer,['messages:write']));expect(r.status).toBe(202)
  expect((await k.call(k.as(writer,['messages:write']),'GET',`/api/v1/action-executions/${r.body.id}`)).status).toBe(404)
})
it('authorisation chooses latest eligible sourced message with id tie-break, not draft time; reactions cannot anchor',async()=>{
  const old=await inbound({occurred_at:'2026-11-06T09:00:00.000Z'})
  const reply={...args(),mode:'reply',thread_id:old.thread_id,subject:undefined}
  const p=await propose(proposer,{arguments:reply});expect(p.status).toBe(201)
  const newer=await inbound({occurred_at:'2026-11-06T09:30:00.000Z'})
  const tie=await inbound({occurred_at:'2026-11-06T09:30:00.000Z'})
  await inbound({kind:'reaction',occurred_at:'2026-11-06T09:59:00.000Z',in_reply_to:tie.external_id})
  expect((await k.call(writer,'POST',`${AR}/${p.body.id}/approve`,{})).status).toBe(200)
  expect((await k.rows('action_executions'))[0]!.resolution.anchor).toMatchObject({message_id:tie.message_id,external_id:tie.external_id,provider_message_id:tie.provider_message_id})
  expect((await direct(writer,reply)).status).toBe(202)
  expect((await k.rows('action_executions'))[1]!.resolution.anchor.message_id).toBe(tie.message_id)
  expect(tie.message_id>newer.message_id).toBe(true)
})
it('no anchor, inactive connection and missing send/read grant refuse without decisions/executions',async()=>{
  const p=await propose();expect(p.status).toBe(201)
  const before=(await k.events()).length
  expect((await direct(writer,{mode:'reply',thread_id:uuidv7(),subject:undefined})).body.error.code).toBe('no_sendable_connection')
  await k.d1.prepare('update channel_connections set granted_scopes=? where id=?').bind('[]',connection).run()
  expect((await k.call(writer,'POST',`${AR}/${p.body.id}/approve`,{})).body.error.code).toBe('connection_cannot_send')
  expect((await k.rows('action_requests'))[0]!.status).toBe('pending');expect(await k.rows('action_executions')).toEqual([]);expect((await k.events()).length).toBe(before)
})
it('withdraw/reject/dedup supersession/expiry audit producers retain descriptors',async()=>{
  const a=await propose(proposer,{dedup_key:'canary'});const b=await propose(proposer,{dedup_key:'canary'});expect([a.status,b.status]).toEqual([201,201])
  expect((await k.call(writer,'POST',`${AR}/${b.body.id}/reject`,{})).status).toBe(200)
  const c=await propose();expect((await k.call(proposer,'POST',`${AR}/${c.body.id}/withdraw`,{})).status).toBe(200)
  const d=await propose(proposer,{dedup_key:'expired',expires_at:'2026-11-06T10:01:00.000Z'})
  k.setNow(new Date('2026-11-06T10:02:00.000Z'));const e=await propose(proposer,{dedup_key:'expired'});expect([d.status,e.status]).toEqual([201,201])
  const events=await k.events();for(const type of ['created','superseded','rejected','withdrawn','expired'])expect(events.some(e=>e.type===`action_request.${type}`)).toBe(true)
  for(const table of ['action_requests','events']){const json=JSON.stringify(await k.rows(table));expect(json).not.toContain('BODY_CANARY');expect(json).not.toContain('/outbound/')}
})
const afterAuthorise=(effect:()=>Promise<void>)=>k.beforeCommit(async()=>{k.beforeCommit(effect)})
it('commit guards refuse an independently drifted connection without resource writes',async()=>{
  afterAuthorise(async()=>{await k.d1.prepare("update channel_connections set status='suspended' where id=?").bind(connection).run()})
  const before=await k.events();const out=await direct()
  expect(out.status).toBe(409);expect(out.body.error.code).toBe('connection_cannot_send');expect(await k.rows('action_executions')).toEqual([]);expect(await k.events()).toEqual(before)
})
it('commit guard refuses an independently removed source',async()=>{
  const a=await inbound();const reply={mode:'reply',thread_id:a.thread_id,subject:undefined}
  afterAuthorise(async()=>{await k.d1.prepare('delete from message_sources where message_id=?').bind(a.message_id).run()})
  const out=await direct(writer,reply);expect(out.status).toBe(409);expect(out.body.error.code).toBe('no_sendable_connection')
  expect(await k.rows('action_executions')).toEqual([])
})
it('commit guard replans an independently inserted latest anchor',async()=>{
  const a=await inbound({occurred_at:'2026-11-06T09:00:00.000Z'});let latest=''
  afterAuthorise(async()=>{latest=(await inbound({occurred_at:'2026-11-06T09:59:00.000Z'})).message_id})
  const out=await direct(writer,{mode:'reply',thread_id:a.thread_id,subject:undefined});expect(out.status).toBe(202)
  expect((await k.rows('action_executions'))[0]!.resolution.anchor.message_id).toBe(latest)
})

it('voluntary review admits human and agent writers; wrong-resource and reply-without-read reviewers cannot decide',async()=>{
  const a=await inbound();const reply={...args(),mode:'reply',thread_id:a.thread_id,subject:undefined}
  const p=await propose(writer,{arguments:reply});expect(p.status).toBe(201)
  for(const scopes of [['contacts:write','action_requests:read'],['messages:write','action_requests:read']]){
    const out=await k.call(k.as(writer,scopes),'POST',`${AR}/${p.body.id}/approve`,{})
    expect([out.status,out.body.error.code]).toEqual([403,'insufficient_scope'])
  }
  expect(await k.rows('action_executions')).toEqual([])
  expect((await k.call(k.owner,'POST',`${AR}/${p.body.id}/approve`,{})).status).toBe(200)
  expect((await k.rows('action_executions'))[0]).toMatchObject({created_by:writer.id,authorised_by:k.owner.id})
})
it('retracted and foreign-connection messages cannot replace the authorised anchor; edits resolve their new thread',async()=>{
  const old=await inbound({occurred_at:'2026-11-06T09:00:00.000Z'})
  // Seed a tombstone at insert: captured messages are append-only, so an UPDATE would test the immutability trigger instead.
  const tombstone=uuidv7()
  await k.d1.prepare("insert into messages (id,created_at,organization_id,created_by,thread_id,channel,kind,external_id,in_reply_to,author,occurred_at,preview,content_key,version,retracted_at) select ?,created_at,organization_id,created_by,thread_id,channel,kind,?,in_reply_to,author,?,preview,content_key,version,? from messages where id=?").bind(tombstone,'retracted@example.test','2026-11-06T09:50:00.000Z',k.now().toISOString(),old.message_id).run()
  await k.d1.prepare("insert into message_sources (id,created_at,organization_id,created_by,connection_id,message_id,provider_message_id,provider_thread_id) select ?,created_at,organization_id,created_by,connection_id,?, ?,provider_thread_id from message_sources where message_id=?").bind(uuidv7(),tombstone,'retracted-provider',old.message_id).run()
  const saved=connection
  connection=(await execute(k.binding,{kind:'tenant',actorId:k.owner.id,organizationId:k.organizationId},connectOperation(envOf(),{google_sub:'foreign',mailbox:'foreign@example.test',own_addresses:['foreign@example.test'],granted_scopes:['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send'],ciphertext:'fake',key_version:1,history_id:'1000'}))).value.connection_id
  await inbound({occurred_at:'2026-11-06T09:59:00.000Z',in_reply_to:old.external_id})
  connection=saved
  const r=await direct(writer,{mode:'reply',thread_id:old.thread_id,subject:undefined});expect(r.status).toBe(202)
  expect((await k.rows('action_executions'))[0].resolution.anchor.message_id).toBe(old.message_id)
  const other=await inbound({provider_thread_id:'other-thread'})
  const p=await propose(proposer,{arguments:{...args(),mode:'reply',thread_id:old.thread_id,subject:undefined}})
  const out=await k.call(writer,'POST',`${AR}/${p.body.id}/approve`,{edited_arguments:{...args(),mode:'reply',thread_id:other.thread_id,subject:undefined}})
  expect(out.status).toBe(200);expect((await k.rows('action_executions')).at(-1)!.resolution.anchor.message_id).toBe(other.message_id)
})
it('duplicate direct calls and approvals racing after plan reads commit exactly one execution and event',async()=>{
  let raced:any
  afterAuthorise(async()=>{raced=await direct()})
  const out=await direct();expect(out.status).toBe(202);expect(raced.status).toBe(202);expect(out.body.id).toBe(raced.body.id)
  const p=await propose();k.beforeCommit(async()=>{k.beforeCommit(async()=>{raced=await k.call(k.owner,'POST',`${AR}/${p.body.id}/approve`,{})})})
  const a=await k.call(writer,'POST',`${AR}/${p.body.id}/approve`,{})
  expect(raced.status).toBe(200);expect(a.status).toBe(409);expect(a.body.error.code).toBe('action_request_not_pending')
  expect((await k.rows('action_executions')).at(-1)!.authorised_by).toBe(k.owner.id)
  expect(await k.rows('action_executions')).toHaveLength(2)
  expect(await k.events('action_execution.created')).toHaveLength(2);expect(await k.events('action_request.approved')).toHaveLength(1)
})
it('failed edited-body put leaves a pending request and its original bytes untouched',async()=>{
  const p=await propose();const before=await k.events();failPut=true
  const out=await k.call(writer,'POST',`${AR}/${p.body.id}/approve`,{edited_arguments:{...args(),body:'EDIT_FAILURE_CANARY'}})
  expect(out.status).toBe(503);expect(await k.events()).toEqual(before);expect(await k.rows('action_executions')).toEqual([])
  expect((await k.call(proposer,'GET',`${AR}/${p.body.id}`)).body).toMatchObject({status:'pending',arguments:{body:args().body},edited_arguments:null})
})
it('expiry sweep and contact merge context events preserve private descriptors; request list and refused get never hydrate',async()=>{
  const target=(await k.call(k.owner,'POST','/api/v1/contacts',{name:'Keep'})).body.id
  const source=(await k.call(k.owner,'POST','/api/v1/contacts',{name:'Fold'})).body.id
  const p=await propose(k.owner,{contact_id:source,expires_at:'2026-11-06T10:01:00.000Z'})
  expect(p.status).toBe(201)
  expect((await k.call(k.owner,'POST',`/api/v1/contacts/${target}/merge`,{source_id:source})).status).toBe(200)
  expect((await k.rows('action_requests'))[0].contact_id).toBe(target)
  const io=gets
  expect((await k.call(k.as(proposer,[]),'GET',`${AR}/${p.body.id}`)).status).toBe(403)
  const list=await k.call(k.owner,'GET',AR);expect(list.status).toBe(200);expect(gets).toBe(io)
  k.setNow(new Date('2026-11-06T10:02:00.000Z'))
  expect(await expireOverdueRequests({binding:k.binding,registry:k.registry,transports:{},clock:k.now,newId:uuidv7})).toEqual({expired:1})
  expect(await k.events('action_request.updated')).toHaveLength(1);expect(await k.events('action_request.expired')).toHaveLength(1)
  for(const value of [list.body,await k.rows('action_requests'),await k.events()]){
    expect(JSON.stringify(value)).not.toContain('BODY_CANARY');expect(JSON.stringify(value)).not.toContain('/outbound/')
  }
})
it('generated MCP send schema and calls use the registered 202 execution contract',async()=>{
  const tool=deriveTools(k.registry).find(e=>e.op.name==='messages.send')!.tool
  expect(Object.keys(tool.inputSchema.properties as object).sort()).toEqual(['connection_id','mode','thread_id','subject','to','cc','bcc','body','idempotency_key'].sort())
  expect(tool.description).toContain('messages:request_approval');expect(tool.description).toContain('messages:read')
  const out=await k.call(writer,'POST','/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool.name,arguments:{...args(),idempotency_key:'mcp-send'}}})
  expect(out.status).toBe(200);expect(out.body.result.isError).not.toBe(true)
  expect(out.body.result.structuredContent).toMatchObject({operation:'messages.send',status:'queued',arguments:{body:{sha256:expect.any(String)}}})
  expect(JSON.stringify(out.body)).not.toContain('BODY_CANARY')
})

it('approved reply source drift refuses its pending transition and execution atomically',async()=>{
  const a=await inbound();const p=await propose(proposer,{arguments:{...args(),mode:'reply',thread_id:a.thread_id,subject:undefined}})
  const before=await k.events()
  afterAuthorise(async()=>{await k.d1.prepare('delete from message_sources where message_id=?').bind(a.message_id).run()})
  const out=await k.call(writer,'POST',`${AR}/${p.body.id}/approve`,{})
  expect(out.status).toBe(409);expect(out.body.error.code).toBe('no_sendable_connection')
  expect((await k.rows('action_requests'))[0].status).toBe('pending');expect(await k.rows('action_executions')).toEqual([]);expect(await k.events()).toEqual(before)
})
it('OpenAPI send request and 202 receipt publish the same strict schema as the generated tool',async()=>{
  const doc=(await k.call(writer,'GET','/api/v1/openapi.json')).body
  const op=doc.paths['/api/v1/messages/send'].post
  expect(op.operationId).toBe('messages.send');expect(Object.keys(op.responses)).toEqual(['202'])
  expect(op['x-vault-proposal']).toMatchObject({eligible:true,request_scope:'messages:request_approval'})
  const schema=op.requestBody.content['application/json'].schema
  expect(Object.keys(schema.properties).sort()).toEqual(['connection_id','mode','thread_id','subject','to','cc','bcc','body','idempotency_key'].sort())
  expect(schema.additionalProperties).toBe(false)
  expect(schema.required).toEqual(['connection_id','mode','body','idempotency_key'])
  expect(schema.properties.body).toMatchObject({type:'string',description:expect.stringContaining('65536 UTF-8 bytes')})
  expect(schema.properties.to).toMatchObject({type:'array',maxItems:50,items:{type:'string',format:'email'}})
  expect(schema.properties.mode.enum).toEqual(['new','reply'])
  expect(op.responses['202'].content['application/json'].schema.properties).toMatchObject({id:{type:'string',format:'uuid'},status:{enum:['queued','claimed','done','failed']},arguments:{type:'object'}})
})

it('parked Postgres composition refuses messages.send with 501 before object/provider/storage work',async()=>{
  let units=0
  const app=createApp({registry:k.registry,userAuthenticator:fakeUserAuthenticator(),storage:()=>({kind:'postgres',runtime:{dialect:'postgres',maxSetSize:1000,execute:async()=>{units++;throw new Error('unexpected unit')}}})})
  const res=await app.request(SEND,{method:'POST',headers:{authorization:`Bearer ${mintTestUserToken({userId:writer.id,organizationId:k.organizationId,scopes:writer.scopes,kind:writer.kind})}`,'content-type':'application/json'},body:JSON.stringify({...args(),idempotency_key:'postgres-unsupported'})})
  expect(res.status).toBe(501);expect(await res.json()).toMatchObject({error:{code:'not_implemented'}});expect(units).toBe(0)
})

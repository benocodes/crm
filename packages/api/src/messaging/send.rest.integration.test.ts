import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { execute, uuidv7 } from '@vault/storage'
import { openActionKit, type ActionKit, type Actor } from '../test/action-kit.js'
import { connectOperation } from '../connections/connect.js'
import { memoryObjectStore, type ObjectStore } from '../objects/store.js'
import { ScopeSet } from '../scopes.js'
import { captureMessage,type CaptureOverrides } from '../test/capture-kit.js'
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
  await k.reset(); puts=gets=0;failPut=false
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
  expect([out.status,out.body.error.code]).toEqual([409,'connection_cannot_send']);expect(await k.rows('action_executions')).toEqual([]);expect(await k.events()).toEqual(before)
})
it('commit guard refuses an independently removed source',async()=>{
  const a=await inbound();const reply={mode:'reply',thread_id:a.thread_id,subject:undefined}
  afterAuthorise(async()=>{await k.d1.prepare('delete from message_sources where message_id=?').bind(a.message_id).run()})
  const out=await direct(writer,reply);expect([out.status,out.body.error.code]).toEqual([409,'no_sendable_connection'])
  expect(await k.rows('action_executions')).toEqual([])
})
it('commit guard replans an independently inserted latest anchor',async()=>{
  const a=await inbound({occurred_at:'2026-11-06T09:00:00.000Z'});let latest=''
  afterAuthorise(async()=>{latest=(await inbound({occurred_at:'2026-11-06T09:59:00.000Z'})).message_id})
  const out=await direct(writer,{mode:'reply',thread_id:a.thread_id,subject:undefined});expect(out.status).toBe(202)
  expect((await k.rows('action_executions'))[0]!.resolution.anchor.message_id).toBe(latest)
})

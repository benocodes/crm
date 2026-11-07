import { afterAll,beforeAll,beforeEach,expect,it } from 'vitest'
import { execute,uuidv7 } from '@vault/storage'
import { sealToken,ScopeSet,r2ObjectStore } from '@vault/api'
import { connectOperation } from '../../api/src/connections/connect.js'
import { FakeGmail } from '@vault/api/test/gmail'
import { gmailFixture } from '@vault/api/test/gmail-fixtures'
import { fakeR2Bucket } from '@vault/api/test/objects'
import { rig,SERVER } from '../../cli/src/test/harness.js'
import { mintOAuthToken } from '@vault/api/test/clerk'
import { createMigrationTracker,recordMigrations } from '@vault/storage-d1/test'
import { MIGRATIONS } from '@vault/storage-d1'
import { mintClerkToken } from '@vault/api/test/clerk'
import { composeD1Worker } from './compose.js'
import { bootstrapD1 } from './bootstrap-d1.js'
import { clerkKit,openWorkerD1,meterD1,type WorkerD1,type ClerkKit } from './test/kit.js'
import { d1Binding } from '@vault/storage-d1'
import { runGmailSync } from '@vault/api/test/gmail-sync'
import { nodeStreams } from '@vault/api/test/streams'

let w:WorkerD1,ck:ClerkKit,connection:string,owner:string,org:string,token:string
let spoilFirstConfirmation=false
const confirmedOnce=new Set<string>()
let now=new Date(),mail:FakeGmail,bucket= fakeR2Bucket(),fetches=0,starts=0
const key=new Uint8Array(32).fill(11)
const keyEncoded=btoa(String.fromCharCode(...key))
const f:typeof fetch=async(input,init)=>{
  fetches++;const url=new URL(String(input))
  if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'fake-access',refresh_token:`rotated-fake-refresh-${fetches}`})
  if(url.hostname==='gmail.googleapis.com'){
    const res=await mail.handle(new Request(String(input),init),t=>t==='fake-access')
    if(spoilFirstConfirmation&&url.searchParams.get('format')==='metadata'&&url.pathname.includes('/messages/sent-')){
      const m=await res.json() as any
      if(!confirmedOnce.has(m.id)){confirmedOnce.add(m.id);m.payload.headers=[{name:'Message-ID',value:'<unconfirmed@example.test>'}]}
      return Response.json(m)
    }
    return res
  }
  return ck.fetch(input,init)
}
const env=(db=w.d1)=>({...ck.env,DB:db,BODIES:bucket,GOOGLE_CLIENT_ID:'fake-client',GOOGLE_CLIENT_SECRET:'fake-secret',OAUTH_STATE_SECRET:'fake-state-secret',CREDENTIALS_KEY:keyEncoded,MAIL_SYNC:{create:async()=>{starts++}}})
const worker=(db=w.d1)=>composeD1Worker(env(db),{fetch:f,clock:()=>now})
const req=async(wk:ReturnType<typeof worker>,method:string,path:string,body?:unknown)=>{
  const pending:Promise<unknown>[]=[]
  const res=await wk.fetch(new Request('https://vault.test'+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),{waitUntil:p=>{pending.push(p)}})
  await Promise.all(pending);return {status:res.status,body:await res.json() as any}
}
const direct=(wk:ReturnType<typeof worker>,i=0)=>req(wk,'POST','/api/v1/messages/send',{connection_id:connection,mode:'new',subject:'Outbound',to:['recipient@example.test'],body:`PRIVATE_OUTBOUND_${i}`,idempotency_key:`worker-${i}`})
const sql=async(s:string)=>(await w.d1.prepare(s).all()).results as any[]
beforeAll(async()=>{w=await openWorkerD1();ck=await clerkKit()})
afterAll(()=>w.dispose())
beforeEach(async()=>{
  await w.reset();await w.d1.prepare('drop table if exists d1_migrations').run();now=new Date();fetches=starts=0;spoilFirstConfirmation=false;confirmedOnce.clear();bucket=fakeR2Bucket();mail=new FakeGmail([gmailFixture('plain')],{profile:{emailAddress:'owner@vault.test',historyId:'1000'}})
  const boot=await bootstrapD1(w.d1,{organizationName:'Send test',agentName:'seed-agent',authOrgId:ck.issuer.issuer});org=boot.organizationId
  token=await mintClerkToken(ck.issuer,{sub:'user_send_owner',extra:{vibase_role:'owner'}})
  ck.profiles.set('user_send_owner',{...(await import('@vault/api/test/clerk')).clerkUser({id:'user_send_owner',email:'owner@vault.test',role:'owner'})})
  const me=await req(worker(),'GET','/meta/v1/me');owner=me.body.principal.id
  const binding=d1Binding(w.d1,{organizationId:org,authProvider:'clerk',authOrgId:ck.issuer.issuer})
  const e={actor:{id:owner,kind:'user' as const},organizationId:org,scopes:ScopeSet.parse([]),now,newId:uuidv7,randomBytes:(n:number)=>crypto.getRandomValues(new Uint8Array(n))}
  connection=(await execute(binding,{kind:'tenant',actorId:owner,organizationId:org},connectOperation(e,{google_sub:'send-worker-owner',mailbox:'owner@vault.test',own_addresses:['owner@vault.test'],granted_scopes:['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send'],ciphertext:await sealToken(key,'fake-refresh',crypto.getRandomValues(new Uint8Array(12))),key_version:1,history_id:'1000'}))).value.connection_id
})
it('the real Worker waitUntil and cron both resolve Gmail, without history writes by the sender',async()=>{
  const wk=worker();const first=await direct(wk);expect(first.status).toBe(202)
  expect((await sql('select status from action_executions'))[0].status).toBe('done');expect(mail.sendRequests).toHaveLength(1);expect(starts).toBe(1)
  expect(await sql('select * from messages')).toEqual([])
  const noKick=await wk.fetch(new Request('https://vault.test/api/v1/messages/send',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({connection_id:connection,mode:'new',subject:'Cron',to:['recipient@example.test'],body:'CRON_PRIVATE',idempotency_key:'cron'})}))
  expect(noKick.status).toBe(202);await wk.scheduled({cron:'* * * * *'});expect(mail.sendRequests).toHaveLength(2);expect((await sql("select count(*) as n from action_executions where status='done'"))[0].n).toBe(2)
  expect(JSON.stringify(await sql('select * from events'))).not.toContain('PRIVATE')
})
it('production tick caps real Gmail work at three and the next tick serves the remainder, counting D1, R2, refresh, send and Workflow traffic',async()=>{
  await createMigrationTracker(w.d1);await recordMigrations(w.d1,MIGRATIONS.map(m=>m.name))
  const wk=worker()
  const binding=d1Binding(w.d1,{organizationId:org,authProvider:'clerk',authOrgId:ck.issuer.issuer})
  const captured=await runGmailSync({binding,organizationId:org,objects:r2ObjectStore(bucket),streams:nodeStreams(),config:{clientId:'fake-client',clientSecret:'fake-secret',credentialsKey:key,keyVersion:1,backfillDays:30,attachmentMaxBytes:1024},fetch:f,clock:()=>now,newId:uuidv7,randomBytes:n=>crypto.getRandomValues(new Uint8Array(n))},connection)
  expect(captured.captured).toBe(1)
  const thread=(await sql('select id from threads'))[0].id
  // Drop kicks through the actual API, leaving durable executions for the cron.
  for(let i=0;i<4;i++){
    const r=await wk.fetch(new Request('https://vault.test/api/v1/messages/send',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({connection_id:connection,mode:'reply',thread_id:thread,to:Array.from({length:50},(_,j)=>`recipient${j}@example.test`),body:'x'.repeat(65536),idempotency_key:`cap-${i}`})}));expect(r.status).toBe(202)
  }
  for(let i=0;i<100;i++)await req(wk,'POST','/api/v1/action-requests',{operation:'tasks.create',arguments:{title:`expire-${i}`},reason:'expiry',expires_at:new Date(now.getTime()+1000).toISOString()})
  now=new Date(now.getTime()+2000)
  const meter=meterD1(w.d1),cold=worker(meter.d1);fetches=starts=0;const getBefore=bucket.gets.length
  meter.start();await cold.scheduled({cron:'* * * * *'});const m=meter.take()
  const external=fetches+starts+(bucket.gets.length-getBefore)
  console.log('MEASURE '+JSON.stringify({key:'gmail-tick-100-3',...m,external,total:m.queries+external}))
  expect(mail.sendRequests).toHaveLength(3);expect(m.queries+external).toBeLessThanOrEqual(50)
  expect({queries:m.queries,external,total:m.queries+external}).toEqual({queries:29,external:18,total:47})
  expect(m.maxParameters).toBeLessThanOrEqual(100);expect(m.maxStatementBytes).toBeLessThanOrEqual(100000)
  expect((await sql("select count(*) as n from action_requests where status='expired'"))[0].n).toBe(100)
  await cold.scheduled({cron:'* * * * *'});expect(mail.sendRequests).toHaveLength(4)
})

it('real Worker direct/approved cold paths count D1, object put/get, Gmail, refresh rotation and Workflow starts',async()=>{
  await createMigrationTracker(w.d1);await recordMigrations(w.d1,MIGRATIONS.map(m=>m.name))
  const m=meterD1(w.d1),wk=worker(m.d1)
  m.start();fetches=starts=0;let io=bucket.gets.length+bucket.calls.length
  const r=await direct(wk,77);expect(r.status).toBe(202)
  let measured=m.take(),external=fetches+starts+bucket.gets.length+bucket.calls.length-io
  console.log('MEASURE '+JSON.stringify({key:'gmail-direct',...measured,external,total:measured.queries+external}))
  expect(measured.queries+external).toBeLessThanOrEqual(50)
  expect({queries:measured.queries,external,total:measured.queries+external}).toEqual({queries:15,external:6,total:21})
  const pending=await req(wk,'POST','/api/v1/action-requests',{operation:'messages.send',arguments:{connection_id:connection,mode:'new',subject:'Approved',to:['recipient@example.test'],body:'REVIEW_MEASURE_CANARY'},reason:'review'})
  expect(pending.status).toBe(201)
  const cold=worker(m.d1);m.start();fetches=starts=0;io=bucket.gets.length+bucket.calls.length
  const a=await req(cold,'POST',`/api/v1/action-requests/${pending.body.id}/approve`,{});expect(a.status).toBe(200)
  measured=m.take();external=fetches+starts+bucket.gets.length+bucket.calls.length-io
  console.log('MEASURE '+JSON.stringify({key:'gmail-approved',...measured,external,total:measured.queries+external}))
  expect(measured.queries+external).toBeLessThanOrEqual(50);expect({queries:measured.queries,external,total:measured.queries+external}).toEqual({queries:13,external:7,total:20});expect(mail.sendRequests).toHaveLength(2)
})
it('generated CLI invokes messages send from real OpenAPI; API-key caps and OAuth delegated/CLI token caps bound authority',async()=>{
  const wk=worker()
  const create=async(name:string,scopes:string[])=>{
    const a=await req(wk,'POST','/meta/v1/agents',{name,scopes});expect(a.status).toBe(201)
    const key=await req(wk,'POST','/meta/v1/api-keys',{agent_id:a.body.id});expect(key.status).toBe(201)
    return {id:a.body.id,key:key.body.key}
  }
  const writer=await create('cli-writer',['messages:write']),proposal=await create('key-proposal',['messages:request_approval'])
  const cli=rig({fetch:request=>wk.fetch(request)})
  try{
    expect((await cli.run(['login','--api-key','--server',SERVER],{stdin:writer.key+'\n'})).code).toBe(0)
    const sent=await cli.run(['messages','send','--data',JSON.stringify({connection_id:connection,mode:'new',subject:'CLI',to:['recipient@example.test'],body:'CLI_PRIVATE_CANARY',idempotency_key:'cli-generated'})])
    expect(sent.code,sent.stderr).toBe(0);expect(JSON.parse(sent.stdout)).toMatchObject({operation:'messages.send',status:'queued'})
    expect(sent.stdout).not.toContain('CLI_PRIVATE_CANARY')
  }finally{cli.dispose()}
  const ownerToken=token
  token=proposal.key;expect((await direct(wk,81)).status).toBe(403)
  token=writer.key;expect((await req(wk,'GET','/api/v1/messages')).status).toBe(403)
  const connectRefused=await req(wk,'POST','/meta/v1/connections/authorize',{provider:'google'});expect([connectRefused.status,connectRefused.body.error.code]).toEqual([403,'insufficient_scope'])
  const cliWorker=composeD1Worker({...env(),AUTH_CLI_CLIENT_ID:'client_send_cli'},{fetch:f,clock:()=>now})
  for(const clientId of ['client_send_cli','client_send_dcr']){
    ck.clients.set(clientId,'Send test client')
    for(const [scope,status] of [['messages:request_approval',403],['messages:write',202]] as const){
      token=await mintOAuthToken(ck.issuer,{sub:'user_send_owner',clientId,scope,now})
      const out=await direct(cliWorker,clientId==='client_send_cli'?82:83);expect(out.status).toBe(status)
    }
  }
  // Owner cap narrows the independent key too.
  token=ownerToken;expect((await req(wk,'PATCH',`/meta/v1/agents/${writer.id}`,{scopes:['messages:request_approval']})).status).toBe(200)
  token=writer.key;expect((await direct(wk,84)).status).toBe(403)
  token=ownerToken
})

it('cold scheduled reconciliation counts real refresh/search/confirmation and never repeats the uncertain POST',async()=>{
  await createMigrationTracker(w.d1);await recordMigrations(w.d1,MIGRATIONS.map(m=>m.name))
  mail.loseSendResponses=1;mail.delaySentSearches=1
  const wk=worker();const r=await direct(wk,91);expect(r.status).toBe(202);expect(mail.sendRequests).toHaveLength(1)
  const m=meterD1(w.d1)
  for(const seconds of [31,61]){
    now=new Date(now.getTime()+seconds*1000)
    const cold=worker(m.d1);fetches=starts=0;const io=bucket.gets.length+bucket.calls.length
    m.start();await cold.scheduled({cron:'* * * * *'});const measured=m.take()
    const external=fetches+starts+bucket.gets.length+bucket.calls.length-io
    console.log('MEASURE '+JSON.stringify({key:`gmail-reconcile-${seconds}`,...measured,external,total:measured.queries+external}))
    expect(measured.queries+external).toBeLessThanOrEqual(50);expect(mail.sendRequests).toHaveLength(1)
  }
  expect((await sql('select status from action_executions'))[0].status).toBe('done');expect(starts).toBe(1)
})

it('production cap includes dispatch plus immediate terminal reconciliation, with 100 expiries and rotating refreshes',async()=>{
  await createMigrationTracker(w.d1);await recordMigrations(w.d1,MIGRATIONS.map(m=>m.name))
  const wk=worker()
  const binding=d1Binding(w.d1,{organizationId:org,authProvider:'clerk',authOrgId:ck.issuer.issuer})
  await runGmailSync({binding,organizationId:org,objects:r2ObjectStore(bucket),streams:nodeStreams(),config:{clientId:'fake-client',clientSecret:'fake-secret',credentialsKey:key,keyVersion:1,backfillDays:30,attachmentMaxBytes:1024},fetch:f,clock:()=>now,newId:uuidv7,randomBytes:n=>crypto.getRandomValues(new Uint8Array(n))},connection)
  const thread=(await sql('select id from threads'))[0].id
  for(let i=0;i<3;i++){
    const r=await wk.fetch(new Request('https://vault.test/api/v1/messages/send',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({connection_id:connection,mode:'reply',thread_id:thread,to:Array.from({length:50},(_,j)=>`r${j}@example.test`),body:'x'.repeat(65536),idempotency_key:`terminal-${i}`})}));expect(r.status).toBe(202)
  }
  // Four prior definite refusals: the last allowed POST can still be uncertain, forcing a final reconcile now.
  await w.d1.prepare('update action_executions set attempts=4').run()
  for(let i=0;i<100;i++)await req(wk,'POST','/api/v1/action-requests',{operation:'tasks.create',arguments:{title:`terminal-expire-${i}`},reason:'expiry',expires_at:new Date(now.getTime()+1000).toISOString()})
  now=new Date(now.getTime()+2000);spoilFirstConfirmation=true
  const meter=meterD1(w.d1),cold=worker(meter.d1);fetches=starts=0;const io=bucket.gets.length+bucket.calls.length
  meter.start();await cold.scheduled({cron:'* * * * *'});const measured=meter.take()
  const external=fetches+starts+bucket.gets.length+bucket.calls.length-io
  console.log('MEASURE '+JSON.stringify({key:'gmail-terminal-tick',...measured,external,total:measured.queries+external}))
  expect(measured.queries+external).toBeLessThanOrEqual(50)
  expect(mail.sendRequests).toHaveLength(2);expect(starts).toBe(2)
  expect((await sql("select count(*) n from action_executions where status='done'"))[0].n).toBe(2)
  await cold.scheduled({cron:'* * * * *'});expect(mail.sendRequests).toHaveLength(3)
})

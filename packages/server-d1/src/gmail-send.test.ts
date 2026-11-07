import { afterAll,beforeAll,beforeEach,expect,it } from 'vitest'
import { execute,uuidv7 } from '@vault/storage'
import { sealToken,ScopeSet,r2ObjectStore } from '@vault/api'
import { connectOperation } from '../../api/src/connections/connect.js'
import { FakeGmail } from '@vault/api/test/gmail'
import { gmailFixture } from '@vault/api/test/gmail-fixtures'
import { fakeR2Bucket } from '@vault/api/test/objects'
import { mintClerkToken } from '@vault/api/test/clerk'
import { composeD1Worker } from './compose.js'
import { bootstrapD1 } from './bootstrap-d1.js'
import { clerkKit,openWorkerD1,meterD1,type WorkerD1,type ClerkKit } from './test/kit.js'
import { d1Binding } from '@vault/storage-d1'
import { runGmailSync } from '@vault/api/test/gmail-sync'
import { nodeStreams } from '@vault/api/test/streams'

let w:WorkerD1,ck:ClerkKit,connection:string,owner:string,org:string,token:string
let now=new Date(),mail:FakeGmail,bucket= fakeR2Bucket(),fetches=0,starts=0
const key=new Uint8Array(32).fill(11)
const keyEncoded=btoa(String.fromCharCode(...key))
const f:typeof fetch=async(input,init)=>{
  fetches++;const url=new URL(String(input))
  if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'fake-access',refresh_token:`rotated-fake-refresh-${fetches}`})
  if(url.hostname==='gmail.googleapis.com')return mail.handle(new Request(String(input),init),t=>t==='fake-access')
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
  await w.reset();now=new Date();fetches=starts=0;bucket=fakeR2Bucket();mail=new FakeGmail([gmailFixture('plain')],{profile:{emailAddress:'owner@vault.test',historyId:'1000'}})
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

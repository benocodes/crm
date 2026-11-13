// AGT166: disposable workerd/D1/R2/MAIL_SYNC acceptance. Every outbound hostname is answered locally.
// pnpm -C packages/server-d1 e2e:gmail-send
import assert from 'node:assert/strict'
import { mkdtempSync,readFileSync,readdirSync,rmSync,statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { execute,uuidv7 } from '@vibase/storage'
import { d1Binding,MIGRATIONS,type D1Like } from '@vibase/storage-d1'
import { MIGRATIONS_DIR,splitStatements,createMigrationTracker,recordMigrations } from '@vibase/storage-d1/test'
import { seedAgent } from '@vibase/storage-d1/test/seed'
import { ScopeSet,sealToken,hashApiKey } from '@vibase/api'
import { connectOperation } from '../../api/src/connections/connect.js'
import { FakeGmail } from '@vibase/api/test/gmail'
import { gmailFixture } from '@vibase/api/test/gmail-fixtures'
import { API_URL,SECRET_KEY,clerkUser,fakeClerkFetch,mintClerkToken,testIssuer } from '@vibase/api/test/clerk'
import { bootstrapD1 } from '../src/bootstrap-d1.js'

const dir=mkdtempSync(join(tmpdir(),'vb-gmail-send-e2e-'))
const bundle=join(dir,'worker.mjs'),key=new Uint8Array(32).fill(11)
const issuer=await testIssuer(),clerk=fakeClerkFetch(new Map([['user_send_owner',clerkUser({id:'user_send_owner',email:'owner@vibase.test',role:'owner'})],['user_send_member',clerkUser({id:'user_send_member',email:'member@vibase.test',role:'member'})]]))
const mail=new FakeGmail([gmailFixture('plain')],{profile:{emailAddress:'owner@vibase.test',historyId:'1000'}})
const logs:string[]=[]
let mf:Miniflare|undefined,googleCalls=0,refreshes=0
const options=()=>({
  modules:[{type:'ESModule',path:bundle,contents:readFileSync(bundle,'utf8')}],modulesRoot:dir,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],
  d1Databases:{DB:'gmail-send-e2e'},d1Persist:join(dir,'d1'),r2Buckets:['BODIES'],r2Persist:join(dir,'r2'),
  workflows:{MAIL_SYNC:{name:'gmail-send-e2e-sync',className:'MailSyncWorkflow'}},
  bindings:{AUTH_PROVIDER:'clerk',CLERK_JWT_KEY:issuer.pem,CLERK_ISSUER:issuer.issuer,CLERK_AUTHORIZED_PARTIES:issuer.party,CLERK_SECRET_KEY:SECRET_KEY,CLERK_API_URL:API_URL,CORS_ALLOWED_ORIGINS:'',GOOGLE_CLIENT_ID:'send-e2e-client',GOOGLE_CLIENT_SECRET:'send-e2e-secret',OAUTH_STATE_SECRET:'send-e2e-state',CREDENTIALS_KEY:Buffer.from(key).toString('base64')},
  handleRuntimeStdio:(stdout:NodeJS.ReadableStream,stderr:NodeJS.ReadableStream)=>{for(const stream of [stdout,stderr])stream.on('data',(b:Buffer)=>logs.push(b.toString()))},
  outboundService:async(req:Request)=>{
    const u=new URL(req.url)
    if(u.hostname==='oauth2.googleapis.com'&&u.pathname==='/token'){googleCalls++;refreshes++;return Response.json({access_token:'send-e2e-access',refresh_token:`send-e2e-rotated-${refreshes}`})}
    if(u.hostname==='gmail.googleapis.com'){googleCalls++;return mail.handle(req,t=>t==='send-e2e-access')}
    if(u.origin===API_URL)return clerk(req.url,{method:req.method,headers:req.headers})
    throw new Error(`blocked E2E outbound host ${u.hostname}`)
  },
})
try{
  await build({entryPoints:[fileURLToPath(new URL('../src/worker.ts',import.meta.url))],bundle:true,format:'esm',platform:'browser',conditions:['workerd','worker','browser'],target:'es2022',outfile:bundle,external:['cloudflare:workers','node:*'],logLevel:'warning'})
  console.log(`bundle ${statSync(bundle).size} bytes`)
  mf=new Miniflare(options());await mf.ready
  let d1=await mf.getD1Database('DB') as unknown as D1Like
  for(const f of readdirSync(MIGRATIONS_DIR).filter(f=>f<'0013').sort())await d1.batch(splitStatements(readFileSync(join(MIGRATIONS_DIR,f),'utf8')).map(s=>d1.prepare(s)))
  const boot=await bootstrapD1(d1,{organizationName:'Gmail E2E',agentName:'legacy-seed-agent',authOrgId:issuer.issuer})
  const org=boot.organizationId,oldId=uuidv7(),oldRequest=uuidv7(),at=new Date().toISOString()
  await d1.prepare("insert into action_requests (id,organization_id,created_by,created_at,updated_at,operation,arguments,status,reason,evidence,expires_at,decided_by,decided_at) values (?,?,?,?,?,'legacy.enqueue','{}','approved','legacy request','[]',?,?,?)").bind(oldRequest,org,boot.agentId,at,at,new Date(Date.now()+86400000).toISOString(),boot.agentId,at).run()
  const oldRequestRow=await d1.prepare('select * from action_requests where id=?').bind(oldRequest).first()
  await d1.prepare("insert into action_executions (id,organization_id,created_by,authorised_by,created_at,updated_at,operation,arguments,resolution,status,client_ref,input_hash,deadline_at,next_attempt_at) values (?,?,?,?,?,?,'legacy.enqueue','{}','{}','queued',?,?,?,?)").bind(oldId,org,boot.agentId,boot.agentId,at,at,'legacy@e2e.test','a'.repeat(64),at,at).run()
  await createMigrationTracker(d1);await recordMigrations(d1,MIGRATIONS.map(m=>m.name).filter(n=>n<'0013'))
  assert.equal((await mf.dispatchFetch('https://vibase.test/meta/v1/me')).status,503,'new Worker refuses old schema')
  await d1.batch(splitStatements(readFileSync(join(MIGRATIONS_DIR,'0013_send_connection.sql'),'utf8')).map(s=>d1.prepare(s)));await recordMigrations(d1,['0013_send_connection.sql'])
  assert.deepEqual(await d1.prepare('select * from action_requests where id=?').bind(oldRequest).first(),oldRequestRow)
  const later=readdirSync(MIGRATIONS_DIR).filter(f=>/^\d{4}_.+\.sql$/.test(f)&&f>'0013').sort()
  for(const f of later)await d1.batch(splitStatements(readFileSync(join(MIGRATIONS_DIR,f),'utf8')).map(s=>d1.prepare(s)))
  await recordMigrations(d1,later)
  await mf.dispose();mf=new Miniflare(options());await mf.ready;d1=await mf.getD1Database('DB') as unknown as D1Like
  const rows=async(s:string,...binds:unknown[])=>(await d1.prepare(s).bind(...binds).all()).results as any[]
  assert.equal((await rows('select connection_id from action_executions where id=?',oldId))[0].connection_id,null)
  const ownerToken=await mintClerkToken(issuer,{sub:'user_send_owner',exp:Math.floor(Date.now()/1000)+3600,extra:{vibase_role:'owner'}})
  const humanToken=await mintClerkToken(issuer,{sub:'user_send_member',exp:Math.floor(Date.now()/1000)+3600,extra:{vibase_role:'member'}})
  const call=async(token:string,method:string,path:string,body?:unknown)=>{
    const res=await mf!.dispatchFetch('https://vibase.test'+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
    return {status:res.status,body:await res.json() as any}
  }
  const owner=(await call(ownerToken,'GET','/meta/v1/me')).body.principal.id
  const binding=d1Binding(d1,{organizationId:org,authProvider:'clerk',authOrgId:issuer.issuer})
  const env={actor:{id:owner,kind:'user' as const},organizationId:org,scopes:ScopeSet.parse([]),now:new Date(),newId:uuidv7,randomBytes:(n:number)=>crypto.getRandomValues(new Uint8Array(n))}
  const connection=(await execute(binding,{kind:'tenant',actorId:owner,organizationId:org},connectOperation(env,{google_sub:'e2e-mailbox',mailbox:'owner@vibase.test',own_addresses:['owner@vibase.test'],granted_scopes:['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send'],ciphertext:await sealToken(key,'send-e2e-refresh',crypto.getRandomValues(new Uint8Array(12))),key_version:1,history_id:'1000'}))).value.connection_id
  const actor=async(name:string,scopes:string[])=>{
    const id=uuidv7(),secret='vk_'+Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
    await seedAgent(d1,{id,organizationId:org,createdBy:owner,name,scopes})
    await d1.prepare('insert into api_keys (id,created_at,updated_at,organization_id,created_by,agent_id,prefix,key_hash) values (?,?,?,?,?,?,?,?)').bind(uuidv7(),at,at,org,owner,id,secret.slice(0,11),await hashApiKey(secret)).run()
    return {id,secret}
  }
  const writer=await actor('composer',['messages:read','messages:write','action_requests:read'])
  const reviewer=await actor('reviewer',['messages:read','messages:write','action_requests:read'])
  const proposer=await actor('proposal-only',['messages:read','messages:request_approval','action_requests:read'])
  const scheduled=async()=>{await (await mf!.getWorker() as unknown as {scheduled(o:{cron:string}):Promise<unknown>}).scheduled({cron:'* * * * *'})}
  const poll=async(label:string,check:()=>Promise<boolean>,timeout=60000)=>{
    const stop=Date.now()+timeout
    while(Date.now()<stop){if(await check())return;await new Promise(r=>setTimeout(r,100))}
    throw new Error(`E2E timeout: ${label}`)
  }
  // Capture the real fixture through the real Workflow before the external classifier/composer acts.
  assert.equal((await call(ownerToken,'POST',`/meta/v1/connections/${connection}/sync`,{})).status,202)
  await poll('incoming capture',async()=>(await rows('select id from messages')).length===1)
  const thread=(await rows('select id from threads'))[0].id
  // Existing capture intentionally stores a bounded preview. Put the full-body canary beyond that preview so this checks authored/raw bytes, not removal of capture metadata.
  const authored=(canary:string)=>'Context preview. '.repeat(20)+canary
  const reply=(body:string)=>({connection_id:connection,mode:'reply',thread_id:thread,to:['recipient@example.test'],body:authored(body)})
  const finish=async(id:string)=>{
    await poll('execution finish',async()=>{
      const e=(await rows('select status,next_attempt_at from action_executions where id=?',id))[0]
      if(e.status==='done')return true
      assert.notEqual(e.status,'failed',`execution failed ${id}`)
      if(e.status==='queued'){
        // Test clock device: make only this execution due, then drive the actual scheduled recovery path.
        await d1.prepare('update action_executions set next_attempt_at=? where id=?').bind(new Date(Date.now()-1000).toISOString(),id).run();await scheduled()
      }
      return false
    })
  }
  mail.loseSendResponses=1;mail.delaySentSearches=1
  // This fake classifier/composer belongs to the external caller. Confidence selects the same registered operation's direct or review path.
  const supportReply=(confidence:number,canary:string,key:string)=>confidence>=0.9
    ?call(writer.secret,'POST','/api/v1/messages/send',{...reply(canary),idempotency_key:key})
    :call(proposer.secret,'POST','/api/v1/action-requests',{operation:'messages.send',arguments:reply(canary),reason:'classifier uncertain'})
  const first=await supportReply(0.99,'DIRECT_E2E_BODY','send-e2e-direct')
  assert.equal(first.status,202);await finish(first.body.id)
  assert.equal(mail.sendRequests.length,1,'uncertainty never blindly resends')
  const replay=await call(writer.secret,'POST','/api/v1/messages/send',{...reply('DIRECT_E2E_BODY'),idempotency_key:'send-e2e-direct'});assert.equal(replay.body.id,first.body.id)
  const pending=await supportReply(0.5,'REVIEWED_E2E_BODY','unused-review-key')
  assert.equal(pending.status,201);assert.equal(mail.sendRequests.length,1)
  assert.equal((await call(proposer.secret,'POST',`/api/v1/action-requests/${pending.body.id}/approve`,{})).status,403)
  const approved=await call(reviewer.secret,'POST',`/api/v1/action-requests/${pending.body.id}/approve`,{});assert.equal(approved.status,200);await finish(approved.body.execution_id)
  const fresh=await call(writer.secret,'POST','/api/v1/messages/send',{connection_id:connection,mode:'new',subject:'New E2E thread',to:['recipient@example.test'],body:authored('NEW_E2E_BODY'),idempotency_key:'send-e2e-new'});assert.equal(fresh.status,202);await finish(fresh.body.id)
  const humanProposal=await call(writer.secret,'POST','/api/v1/action-requests',{operation:'messages.send',arguments:reply('HUMAN_E2E_BODY'),reason:'voluntary human review'})
  const human=await call(humanToken,'POST',`/api/v1/action-requests/${humanProposal.body.id}/approve`,{});assert.equal(human.status,200);await finish(human.body.execution_id)
  await poll('all confirmed outbound captures',async()=>(await rows("select id from interactions where direction='outbound'")).length===4)
  assert.equal(mail.sendRequests.length,4)
  for(const [i,canary] of ['DIRECT_E2E_BODY','REVIEWED_E2E_BODY','NEW_E2E_BODY','HUMAN_E2E_BODY'].entries()){
    const sent=mail.sendRequests[i]!
    assert.equal(Buffer.from(sent.raw.split('\r\n\r\n')[1]!.replace(/\s/g,''),'base64').toString('utf8'),authored(canary),'provider receives exact authorised bytes')
  }
  // Repeated and overlapping sync requests reuse the existing capture deduplication.
  await Promise.all([call(ownerToken,'POST',`/meta/v1/connections/${connection}/sync`,{}),call(ownerToken,'POST',`/meta/v1/connections/${connection}/sync`,{})])
  await poll('repeat sync settles',async()=>{
    const s=(await rows('select lease_until,last_success_at,sync_requested_at from mail_sync_state where connection_id=?',connection))[0]
    return s.lease_until===null&&s.last_success_at>=s.sync_requested_at
  })
  assert.equal((await rows("select id from interactions where direction='outbound'")).length,4)
  const executions=await rows("select * from action_executions where operation='messages.send'")
  const captured=await rows("select m.id,m.external_id,m.thread_id,i.id as interaction_id,i.created_by as interaction_actor,i.direction,m.created_by from messages m join interactions i on i.message_id=m.id where i.direction='outbound'")
  for(const e of executions){const m=captured.find(m=>m.external_id===JSON.parse(e.result).external_id);assert(m);assert.equal(m.created_by,owner);assert.equal(m.direction,'outbound');if(JSON.parse(e.arguments).mode==='reply')assert.equal(m.thread_id,thread);else assert.notEqual(m.thread_id,thread)}
  for(const m of captured){
    assert.equal(m.interaction_actor,owner)
    for(const [id,type] of [[m.id,'message.created'],[m.interaction_id,'interaction.created']])assert.equal((await rows('select actor_id from events where resource_id=? and type=?',id,type))[0].actor_id,owner)
    const participants=await rows('select i.value,p.role from interaction_participants p join identities i on i.id=p.identity_id where p.interaction_id=? order by p.role,i.value',m.interaction_id)
    assert.deepEqual(participants,[{value:'owner@vibase.test',role:'from'},{value:'recipient@example.test',role:'to'}])
    assert.equal((await rows('select created_by from message_sources where message_id=?',m.id))[0].created_by,owner)
  }
  const reviewed=executions.find(e=>e.id===approved.body.execution_id)!;assert.equal(reviewed.created_by,proposer.id);assert.equal(reviewed.authorised_by,reviewer.id)
  for(const e of executions){
    for(const type of ['action_execution.created','action_execution.completed']){
      const event=(await rows('select actor_id from events where resource_id=? and type=?',e.id,type))[0]
      assert.equal(event.actor_id,e.authorised_by)
    }
  }
  for(const [id,text] of [[first.body.id,'DIRECT_E2E_BODY'],[approved.body.execution_id,'REVIEWED_E2E_BODY']])assert.equal((await call(writer.secret,'GET',`/api/v1/action-executions/${id}`)).body.arguments.body,authored(text))
  assert.equal((await call(proposer.secret,'GET',`/api/v1/action-requests/${pending.body.id}`)).body.arguments.body,authored('REVIEWED_E2E_BODY'))
  const audit=JSON.stringify({executions:await rows('select * from action_executions'),requests:await rows('select * from action_requests'),events:await rows('select * from events')})
  for(const text of ['DIRECT_E2E_BODY','REVIEWED_E2E_BODY','NEW_E2E_BODY','HUMAN_E2E_BODY'])assert(!audit.includes(text)&&!logs.join('').includes(text))
  assert(!audit.includes('/outbound/')&&!logs.join('').includes('send-e2e-access'))
  assert.equal((await rows('select count(*) as n from message_sources s join messages m on m.id=s.message_id where m.external_id in (select json_extract(result,\'$.external_id\') from action_executions where operation=\'messages.send\')'))[0].n,4)
  console.log(`PASS Gmail send E2E: 4 deliveries, 4 real captures, immutable bodies, reviewed attribution, old-row survival; Google HTTP calls ${googleCalls}`)
}finally{if(mf)await mf.dispose();rmSync(dir,{recursive:true,force:true})}

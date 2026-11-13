// API221: disposable workerd/D1/R2 acceptance of the webhook receiver example ([[API7]] D21). Two workers in one Miniflare: the vault (this package's bundle) and the example receiver
// (`packages/webhook-receiver-example`). A real Gmail fixture is captured through the real MAIL_SYNC Workflow, the per-minute cron dispatches and signs the delivery, the receiver verifies it
// and starts its Workflow, and the Workflow proposes a reply through the vault's REST API. Google's hosts are answered by FakeGmail; every other outbound host is refused. Nothing leaves the machine.
// pnpm -C packages/server-d1 e2e:webhook-example
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

const dir=mkdtempSync(join(tmpdir(),'vb-webhook-example-e2e-'))
const vaultBundle=join(dir,'vibase.mjs'),receiverBundle=join(dir,'receiver.mjs'),key=new Uint8Array(32).fill(13)
const KEY_B64=Buffer.from(key).toString('base64')
const issuer=await testIssuer(),clerk=fakeClerkFetch(new Map([['user_hook_owner',clerkUser({id:'user_hook_owner',email:'owner@vault.test',role:'owner'})]]))
const mail=new FakeGmail([gmailFixture('plain')],{profile:{emailAddress:'owner@vault.test',historyId:'1000'}})
const logs:string[]=[]
let mf:Miniflare|undefined,secret='whsec_not_yet_issued',agentKey=''
// The signed deliveries the receiver was sent, as the vault's sender made them (kept to replay one).
const deliveries:Array<{headers:Record<string,string>,body:string}>=[]
type Worker={fetch(url:string,init?:RequestInit):Promise<Response>}
const worker=async(name:string)=>(await mf!.getWorker(name)) as unknown as Worker
const receiver=()=>worker('receiver')
const options=()=>({
  handleRuntimeStdio:(stdout:NodeJS.ReadableStream,stderr:NodeJS.ReadableStream)=>{for(const stream of [stdout,stderr])stream.on('data',(b:Buffer)=>logs.push(b.toString()))},
  d1Persist:join(dir,'d1'),r2Persist:join(dir,'r2'),workflowsPersist:join(dir,'workflows'),
  workers:[
    {
      name:'vb',modules:[{type:'ESModule',path:vaultBundle,contents:readFileSync(vaultBundle,'utf8')}],modulesRoot:dir,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],
      d1Databases:{DB:'webhook-example-e2e'},r2Buckets:['BODIES'],
      workflows:{MAIL_SYNC:{name:'webhook-example-e2e-sync',className:'MailSyncWorkflow'}},
      bindings:{AUTH_PROVIDER:'clerk',CLERK_JWT_KEY:issuer.pem,CLERK_ISSUER:issuer.issuer,CLERK_AUTHORIZED_PARTIES:issuer.party,CLERK_SECRET_KEY:SECRET_KEY,CLERK_API_URL:API_URL,CORS_ALLOWED_ORIGINS:'',GOOGLE_CLIENT_ID:'hook-e2e-client',GOOGLE_CLIENT_SECRET:'hook-e2e-secret',OAUTH_STATE_SECRET:'hook-e2e-state',CREDENTIALS_KEY:KEY_B64,WEBHOOK_ALLOW_INSECURE_URLS:'true'},
      outboundService:async(req:Request)=>{
        const u=new URL(req.url)
        if(u.hostname==='oauth2.googleapis.com'&&u.pathname==='/token')return Response.json({access_token:'hook-e2e-access',refresh_token:'hook-e2e-refresh'})
        if(u.hostname==='gmail.googleapis.com')return mail.handle(req,t=>t==='hook-e2e-access')
        if(u.origin===API_URL)return clerk(req.url,{method:req.method,headers:req.headers})
        if(u.hostname==='receiver.test'){
          const body=await req.text()
          deliveries.push({headers:Object.fromEntries(req.headers),body})
          return (await receiver()).fetch(req.url,{method:req.method,headers:req.headers,body})
        }
        throw new Error(`blocked E2E outbound host ${u.hostname}`)
      },
    },
    {
      name:'receiver',modules:true,scriptPath:receiverBundle,modulesRoot:dir,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],
      workflows:{REPLY_WORKFLOW:{name:'webhook-example-e2e-reply',className:'ReplyWorkflow'}},
      bindings:{WEBHOOK_SECRET:secret,VIBASE_URL:'http://vault.test',VIBASE_API_KEY:agentKey},
      outboundService:async(req:Request)=>{
        const u=new URL(req.url)
        if(u.hostname==='vault.test')return (await worker('vb')).fetch(req.url,{method:req.method,headers:req.headers,...(req.method==='GET'||req.method==='HEAD'?{}:{body:await req.text()})})
        throw new Error(`blocked E2E outbound host ${u.hostname}`)
      },
    },
  ],
})
try{
  const bundle=(entry:string,outfile:string)=>build({entryPoints:[entry],bundle:true,format:'esm',platform:'browser',conditions:['workerd','worker','browser'],target:'es2022',outfile,external:['cloudflare:workers','cloudflare:workflows','node:*'],logLevel:'warning'})
  await bundle(fileURLToPath(new URL('../src/worker.ts',import.meta.url)),vaultBundle)
  await bundle(fileURLToPath(new URL('../../webhook-receiver-example/src/index.ts',import.meta.url)),receiverBundle)
  console.log(`bundles: vibase ${statSync(vaultBundle).size} bytes, receiver ${statSync(receiverBundle).size} bytes`)
  mf=new Miniflare(options() as never);await mf.ready
  let d1=await mf.getD1Database('DB') as unknown as D1Like
  const migrations=readdirSync(MIGRATIONS_DIR).filter(f=>/^\d{4}_.+\.sql$/.test(f)).sort()
  for(const f of migrations)await d1.batch(splitStatements(readFileSync(join(MIGRATIONS_DIR,f),'utf8')).map(s=>d1.prepare(s)))
  const boot=await bootstrapD1(d1,{organizationName:'Webhook Example E2E',agentName:'bootstrap-agent',authOrgId:issuer.issuer})
  await createMigrationTracker(d1);await recordMigrations(d1,MIGRATIONS.map(m=>m.name).concat(migrations.filter(f=>!MIGRATIONS.some(m=>m.name===f))))
  const org=boot.organizationId,at=new Date().toISOString()
  const rows=async(s:string,...binds:unknown[])=>(await d1.prepare(s).bind(...binds).all()).results as any[]
  const ownerToken=await mintClerkToken(issuer,{sub:'user_hook_owner',exp:Math.floor(Date.now()/1000)+3600,extra:{vibase_role:'owner'}})
  const call=async(token:string,method:string,path:string,body?:unknown)=>{
    const res=await mf!.dispatchFetch('https://vault.test'+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
    return {status:res.status,body:await res.json() as any}
  }
  const owner=(await call(ownerToken,'GET','/meta/v1/me')).body.principal.id
  const binding=d1Binding(d1,{organizationId:org,authProvider:'clerk',authOrgId:issuer.issuer})
  const env={actor:{id:owner,kind:'user' as const},organizationId:org,scopes:ScopeSet.parse([]),now:new Date(),newId:uuidv7,randomBytes:(n:number)=>crypto.getRandomValues(new Uint8Array(n))}
  const connection=(await execute(binding,{kind:'tenant',actorId:owner,organizationId:org},connectOperation(env,{google_sub:'e2e-mailbox',mailbox:'owner@vault.test',own_addresses:['owner@vault.test'],granted_scopes:['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send'],ciphertext:await sealToken(key,'hook-e2e-refresh',crypto.getRandomValues(new Uint8Array(12))),key_version:1,history_id:'1000'}))).value.connection_id
  // One agent: it owns the subscription and is the Workflow's own identity.
  const agentId=uuidv7();agentKey='vk_'+Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  await seedAgent(d1,{id:agentId,organizationId:org,createdBy:owner,name:'hook-agent',scopes:['webhooks:read','webhooks:write','events:read','interactions:read','messages:read','messages:request_approval','action_requests:read','connections:read']})
  await d1.prepare('insert into api_keys (id,created_at,updated_at,organization_id,created_by,agent_id,prefix,key_hash) values (?,?,?,?,?,?,?,?)').bind(uuidv7(),at,at,org,owner,agentId,agentKey.slice(0,11),await hashApiKey(agentKey)).run()
  const poll=async(label:string,check:()=>Promise<boolean>,timeout=60000)=>{
    const stop=Date.now()+timeout
    while(Date.now()<stop){if(await check())return;await new Promise(r=>setTimeout(r,100))}
    throw new Error(`E2E timeout: ${label}`)
  }
  const scheduled=async()=>{await (await mf!.getWorker('vb') as unknown as {scheduled(o:{cron:string}):Promise<unknown>}).scheduled({cron:'* * * * *'})}

  // 1. Subscribe; hand the receiver its secret (a reload: the persisted D1, R2 and Workflow state stay).
  const created=await call(agentKey,'POST','/meta/v1/webhooks',{url:'http://receiver.test/hook'})
  assert.equal(created.status,201,JSON.stringify(created.body));assert.deepEqual(created.body.event_types,['interaction.created'])
  secret=created.body.secret;assert.match(secret,/^whsec_/)
  await mf.setOptions(options() as never);await mf.ready;d1=await mf.getD1Database('DB') as unknown as D1Like
  // 2. Capture one inbound message through the real sync path.
  assert.equal((await call(ownerToken,'POST',`/meta/v1/connections/${connection}/sync`,{})).status,202)
  await poll('incoming capture',async()=>(await rows('select id from interactions')).length===1)
  const events=await call(agentKey,'GET','/api/v1/events?type=interaction.created')
  assert.equal(events.status,200);assert.equal(events.body.data.length,1,'one interaction.created event')
  const event=events.body.data[0]
  // 3. The per-minute cron dispatches and sends; the receiver answers 2xx and its Workflow runs to completion.
  await scheduled()
  const delivered=await call(agentKey,'GET',`/meta/v1/webhooks/${created.body.id}/deliveries`)
  assert.equal(delivered.body.data.length,1);assert.equal(delivered.body.data[0].event_id,event.id);assert.equal(delivered.body.data[0].status,'delivered');assert.equal(delivered.body.data[0].attempts,1)
  assert.equal(deliveries.length,1,'one POST reached the receiver');assert.equal(deliveries[0]!.headers['webhook-id'],event.id)
  const instance=async()=>(await mf!.getBindings<{REPLY_WORKFLOW:{get(id:string):Promise<{status():Promise<{status:string}>}>}}>('receiver')).REPLY_WORKFLOW.get(event.id)
  await poll('workflow complete',async()=>(await (await instance()).status()).status==='complete')
  // 4. Exactly one pending reply proposal, from the agent, on the event's thread.
  const proposals=async()=>(await call(agentKey,'GET',`/api/v1/action-requests?interaction_id=${event.resource_id}`)).body.data as any[]
  const first=await proposals()
  assert.equal(first.length,1);assert.equal(first[0].status,'pending');assert.equal(first[0].operation,'messages.send')
  assert.equal(first[0].arguments.mode,'reply');assert.equal(first[0].arguments.thread_id,event.after.thread_id);assert.equal(first[0].created_by,agentId)
  assert.deepEqual(first[0].arguments.to,['jane@acme.test']);assert.equal(first[0].arguments.connection_id,connection)
  assert.equal(mail.sendRequests.length,0,'proposing sends nothing')
  // 5. Replaying the same signed delivery (same webhook-id) starts nothing new.
  const replay=await (await receiver()).fetch('http://receiver.test/hook',{method:'POST',headers:deliveries[0]!.headers,body:deliveries[0]!.body})
  assert.ok(replay.status>=200&&replay.status<300,`replay answered ${replay.status}`)
  await new Promise(r=>setTimeout(r,1500))
  assert.equal((await proposals()).length,1,'still one request after the replay');assert.equal((await (await instance()).status()).status,'complete')
  // 6. A wrong signature is refused with no instance.
  const forged=await (await receiver()).fetch('http://receiver.test/hook',{method:'POST',headers:{...deliveries[0]!.headers,'webhook-id':'forged-event-id','webhook-signature':'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='},body:deliveries[0]!.body})
  assert.equal(forged.status,401)
  await assert.rejects(async()=>(await mf!.getBindings<{REPLY_WORKFLOW:{get(id:string):Promise<unknown>}}>('receiver')).REPLY_WORKFLOW.get('forged-event-id'),'no instance for the forged event')
  const all=logs.join('')
  for(const [name,value] of [['webhook secret',secret],['agent key',agentKey],['CREDENTIALS_KEY',KEY_B64]])assert(!all.includes(value),`no log line holds the ${name}`)
  console.log(`PASS webhook receiver example E2E: capture, signed delivery (attempts 1), one Workflow instance (id = event id), one pending messages.send proposal, replay and forged delivery handled`)
}finally{if(mf)await mf.dispose();rmSync(dir,{recursive:true,force:true})}

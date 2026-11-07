import { afterAll,beforeAll,expect,it } from 'vitest'
import { openLocalD1,type LocalD1 } from './test/index.js'
import { MIGRATIONS_DIR,splitStatements } from './test/index.js'
import { readFileSync,readdirSync } from 'node:fs'
import { join } from 'node:path'
import { seedDeployment,seedPrincipal } from './test/seed.js'
let local:LocalD1
beforeAll(async()=>{local=await openLocalD1(['G'])})
afterAll(()=>local.dispose())
it('executions have a nullable composite organisation/connection FK',async()=>{
  const d1=local.bindings.G!
  const cols=(await d1.prepare("pragma table_info('action_executions')").all()).results as Array<{name:string,notnull:number}>
  expect(cols.find(c=>c.name==='connection_id')).toMatchObject({notnull:0})
  const fks=(await d1.prepare("pragma foreign_key_list('action_executions')").all()).results as Array<{id:number,table:string,from:string,to:string}>
  const fk=fks.find(f=>f.from==='connection_id');expect(fk).toMatchObject({table:'channel_connections',to:'id'})
  expect(fks.find(f=>f.id===fk!.id&&f.from==='organization_id')).toMatchObject({to:'organization_id'})
})
it('0013 preserves old 0012 executions and every index/check; invalid connection references fail',async()=>{
  const old=await openLocalD1(['OLD'],{migrate:false});const d1=old.bindings.OLD!
  try{
    for(const f of readdirSync(MIGRATIONS_DIR).filter(f=>f<'0013').sort())await d1.batch(splitStatements(readFileSync(join(MIGRATIONS_DIR,f),'utf8')).map(s=>d1.prepare(s)))
    const org='019a0000-0000-7000-8000-000000000001',user='019a0000-0000-7000-8000-000000000002',id='019a0000-0000-7000-8000-000000000003',at='2026-11-07T09:00:00.000Z'
    await seedDeployment(d1,{organizationId:org,externalId:'org_send_migration'});await seedPrincipal(d1,{id:user,kind:'user'})
    await d1.prepare("insert into action_executions (id,organization_id,created_by,authorised_by,created_at,updated_at,operation,arguments,resolution,status,client_ref,input_hash,deadline_at,next_attempt_at) values (?,?,?,?,?,?,'test.enqueue','{}','{}','queued',?,?,?,?)").bind(id,org,user,user,at,at,'migration@example.test','a'.repeat(64),at,at).run()
    const rows=async()=>(await d1.prepare('select * from action_executions').all()).results
    const before=await rows();const indexes=(await d1.prepare("select name,sql from sqlite_master where type='index' and tbl_name='action_executions' order by name").all()).results
    await d1.batch(splitStatements(readFileSync(join(MIGRATIONS_DIR,'0013_send_connection.sql'),'utf8')).map(s=>d1.prepare(s)))
    expect(await rows()).toEqual(before.map(r=>({...r,connection_id:null})))
    expect((await d1.prepare("select name,sql from sqlite_master where type='index' and tbl_name='action_executions' order by name").all()).results).toEqual(indexes)
    await expect(d1.prepare('update action_executions set connection_id=? where id=?').bind('019a0000-0000-7000-8000-000000000099',id).run()).rejects.toThrow(/FOREIGN KEY/)
    await expect(d1.prepare("update action_executions set status='invalid' where id=?").bind(id).run()).rejects.toThrow(/action_executions_status/)
  }finally{await old.dispose()}
})

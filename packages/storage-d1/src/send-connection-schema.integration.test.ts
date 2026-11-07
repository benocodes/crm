import { afterAll,beforeAll,expect,it } from 'vitest'
import { openLocalD1,type LocalD1 } from './test/index.js'
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

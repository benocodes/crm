import { expect, test } from 'vitest'
import { compileOperation } from './compile.js'
import { ctx, task, prep } from './test/data.js'
// Valid immutable descriptions keep compiler reds independent from preparation stubs.
const op:any={context:ctx,operationId:prep().operationId,now:prep().now,input:{id:task,patch:{title:"'; DROP TABLE tasks; --"}},kind:'task',eventId:prep().nextId(),rowId:prep().nextId(),locks:[]}
test.each(['postgres','d1'])('compiles parameterized fixed stages without a connection: %s',dialect=> {
 const p=compileOperation(op,dialect)
 expect(p.statements.length).toBeGreaterThan(4)
 expect(p.statements.map((s:any)=>s.sql).join('\n')).not.toContain('DROP TABLE tasks')
 const labels=p.statements.map((s:any)=>s.label)
 expect(labels.indexOf('snapshot')).toBeLessThan(labels.indexOf('first-mutation'))
 expect(labels.indexOf('first-event')).toBeLessThan(labels.indexOf('result'))
 expect(labels.indexOf('result')).toBeLessThan(labels.lastIndexOf('cleanup'))
})

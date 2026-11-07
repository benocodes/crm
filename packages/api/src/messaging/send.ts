import { enqueuedOperation } from '../executions/enqueue.js'
import { sendInput } from './send-input.js'

export function messageSendOperation() {
  return enqueuedOperation({name:'messages.send',summary:'Send plain-text email',path:'/messages/send',scope:{resource:'messages',action:'write'},readScope:{resource:'messages',action:'read'},transport:'gmail',input:sendInput})
}

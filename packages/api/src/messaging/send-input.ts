import { z } from 'zod'

const bytes = (s: string) => new TextEncoder().encode(s).byteLength
const address = z.string().trim().toLowerCase().pipe(z.email().max(254).regex(/^[\x21-\x7e]+$/))
export const sendInput = z.strictObject({
  connection_id: z.uuid(), mode: z.enum(['new', 'reply']), thread_id: z.uuid().optional(),
  subject: z.string().min(1).refine(s => bytes(s) <= 998 && !/[\x00-\x1f\x7f]/.test(s), 'subject must be a safe single header').optional(),
  to: z.array(address).max(50).optional(), cc: z.array(address).max(50).optional(), bcc: z.array(address).max(50).optional(),
  body: z.string().refine(s => bytes(s) <= 65536, 'body exceeds 65536 UTF-8 bytes'),
}).superRefine((v, ctx) => {
  if (v.mode === 'reply' ? (!v.thread_id || v.subject !== undefined) : (!v.subject || v.thread_id !== undefined)) ctx.addIssue({code:'custom',message:'reply requires thread_id and forbids subject; new requires subject and forbids thread_id'})
  const n = (v.to?.length ?? 0) + (v.cc?.length ?? 0) + (v.bcc?.length ?? 0)
  if (n < 1 || n > 50) ctx.addIssue({code:'custom',message:'one to fifty recipients required'})
}).overwrite(v => {
  const seen = new Set<string>()
  const unique = (a: string[] | undefined) => (a ?? []).filter(s => seen.has(s) ? false : (seen.add(s),true))
  return {...v, connection_id:v.connection_id.toLowerCase(), ...(v.thread_id ? {thread_id:v.thread_id.toLowerCase()}:{}), to:unique(v.to),cc:unique(v.cc),bcc:unique(v.bcc)}
})

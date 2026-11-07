import { z } from 'zod'

// Importable red-phase stub; AGT166's contract tests precede its implementation.
export const sendInput = z.strictObject({
  connection_id: z.uuid(), mode: z.enum(['new', 'reply']), thread_id: z.uuid().optional(),
  subject: z.string().optional(), to: z.array(z.string()).optional(), cc: z.array(z.string()).optional(), bcc: z.array(z.string()).optional(), body: z.string(),
})

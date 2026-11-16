import type { D1Like } from '@vibase/storage-d1'

export async function mintControlKey(
  _control: D1Like,
  _a: { organizationId: string; agentId: string; actorId: string; key: string; now?: Date },
): Promise<{ id: string }> {
  throw new Error('not implemented')
}

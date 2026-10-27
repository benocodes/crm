import type { PreparedOperation } from '@vault/storage'
import type { D1Like } from '@vault/storage-d1'

export type DeploymentLink = { organizationId: string; authProvider: string; authOrgId: string }

export function readDeployment(_d1: D1Like): Promise<DeploymentLink | null> {
  throw new Error('not implemented')
}

export function initDeploymentOperation(_link: DeploymentLink): PreparedOperation<'created' | 'existing'> {
  throw new Error('not implemented')
}

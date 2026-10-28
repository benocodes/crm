import { bootstrap } from '@vault/api'
import { execute, uuidv7 } from '@vault/storage'
import { d1Binding, type D1Like } from '@vault/storage-d1'
import { initDeploymentOperation, readDeployment, type DeploymentLink } from './init-deployment.js'

export interface BootstrapD1Options {
  organizationName: string
  email: string
  userName?: string
  agentName: string
  scopes?: readonly string[]
  /** Defaults to 'clerk'. With an existing marker it must match, when given. */
  authProvider?: string
  authOrgId: string
  authSubject?: string
  /** Defaults to a fresh UUIDv7. With an existing marker it must match, when given. */
  organizationId?: string
}
export interface BootstrapD1Result {
  organizationId: string
  userId: string
  agentId: string
  apiKeyId: string
  key: string
  deployment: 'created' | 'existing'
}

/**
 * The local D1 bootstrap ([[CORE38]] D6, P7): the deployment marker, then the first organisation, owner and agent key, as
 * two units. Resumable: after a crash between them the marker exists, so the second run adopts it and completes. A marker
 * for another link is refused with the same message as `initDeploymentOperation`; an existing organisation is refused by
 * `bootstrap` (nothing is written then).
 */
export async function bootstrapD1(
  d1: D1Like,
  opts: BootstrapD1Options,
  env: { now?: Date; newId?: () => string; randomBytes?: (n: number) => Uint8Array } = {},
): Promise<BootstrapD1Result> {
  const now = env.now ?? new Date()
  const newId = env.newId ?? (() => uuidv7(now))
  let link = await readDeployment(d1)
  let deployment: 'created' | 'existing'
  if (link) {
    const differs =
      link.authOrgId !== opts.authOrgId ||
      (opts.authProvider !== undefined && link.authProvider !== opts.authProvider) ||
      (opts.organizationId !== undefined && link.organizationId !== opts.organizationId)
    if (differs) throw new Error(`deployment is already initialised for organization ${link.organizationId} (${link.authProvider}:${link.authOrgId})`)
    deployment = 'existing'
  } else {
    const wanted: DeploymentLink = { organizationId: opts.organizationId ?? newId(), authProvider: opts.authProvider ?? 'clerk', authOrgId: opts.authOrgId }
    const done = await execute(d1Binding(d1, wanted), { kind: 'internal', organizationId: wanted.organizationId }, initDeploymentOperation(wanted))
    link = wanted
    deployment = done.value
  }
  const r = await bootstrap(
    d1Binding(d1, link),
    {
      organizationName: opts.organizationName,
      email: opts.email,
      userName: opts.userName,
      agentName: opts.agentName,
      scopes: opts.scopes,
      authProvider: link.authProvider,
      authSubject: opts.authSubject,
    },
    { now, newId, randomBytes: env.randomBytes },
  )
  return { organizationId: r.organizationId, userId: r.userId, agentId: r.agentId, apiKeyId: r.apiKeyId, key: r.key, deployment }
}

export async function probeBatchAtomicity(_d1: D1Like, _link: DeploymentLink): Promise<'atomic' | 'not-atomic' | 'skipped'> {
  throw new Error('not implemented')
}

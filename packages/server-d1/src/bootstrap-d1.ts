import { bootstrap, bootstrapWorkspace } from '@vibase/api'
import { execute, uuidv7 } from '@vibase/storage'
import { d1Binding, type D1Like } from '@vibase/storage-d1'
import { initDeploymentOperation, markerInsert, readDeployment, type DeploymentLink } from './init-deployment.js'

export interface BootstrapD1Options {
  organizationName: string
  /** Required for `authProvider: 'none'`; refused on the Clerk path, which creates no human ([[CORE64]] D11). */
  email?: string
  userName?: string
  /** Required for `authProvider: 'none'`; optional on the Clerk path (the operator agent and its key). */
  agentName?: string
  scopes?: readonly string[]
  /** Defaults to 'clerk'. With an existing marker it must match, when given. */
  authProvider?: string
  /** The marker's organisation link: `CLERK_ISSUER` on the Clerk path, a name on the `none` path. */
  authOrgId: string
  authSubject?: string
  /** Defaults to a fresh UUIDv7. With an existing marker it must match, when given. */
  organizationId?: string
}
export interface BootstrapD1Result {
  organizationId: string
  /** Null on the Clerk path: no human is created. */
  userId: string | null
  /** Null when the Clerk path made no operator agent. */
  agentId: string | null
  apiKeyId: string | null
  key: string | null
  deployment: 'created' | 'existing'
}

type BootstrapD1Env = { now?: Date; newId?: () => string; randomBytes?: (n: number) => Uint8Array }

/**
 * The local D1 bootstrap ([[CORE38]] D6, P7): the deployment marker, then the first organisation, owner and agent key, as
 * two units. On the Clerk path ([[CORE64]] D11) there is no owner: the organisation and the optional operator agent are written,
 * attributed to `system`, and the first owner arrives through their Clerk invitation. The `none` path is unchanged. Resumable:
 * after a crash between them the marker exists, so the second run adopts it and completes. A marker
 * for another link is refused with the same message as `initDeploymentOperation`; an existing organisation is refused by
 * `bootstrap` (nothing is written then).
 */
export async function bootstrapD1(
  d1: D1Like,
  opts: BootstrapD1Options & { agentName: string },
  env?: BootstrapD1Env,
): Promise<BootstrapD1Result & { agentId: string; apiKeyId: string; key: string }>
export async function bootstrapD1(d1: D1Like, opts: BootstrapD1Options, env?: BootstrapD1Env): Promise<BootstrapD1Result>
export async function bootstrapD1(d1: D1Like, opts: BootstrapD1Options, env: BootstrapD1Env = {}): Promise<BootstrapD1Result> {
  const clerk = (opts.authProvider ?? 'clerk') === 'clerk'
  if (clerk && (opts.email !== undefined || opts.authSubject !== undefined || opts.userName !== undefined)) {
    throw new Error('a Clerk-backed deployment creates no human: the first owner is invited in Clerk (drop the email, name and auth subject)')
  }
  if (!clerk && (opts.email === undefined || opts.agentName === undefined)) throw new Error(`authProvider ${opts.authProvider} requires an email and an agent name`)
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
  if ((link.authProvider === 'clerk') !== clerk) throw new Error(`the marker's provider is ${link.authProvider}: pass --auth-provider ${link.authProvider}`)
  if (clerk) {
    const w = await bootstrapWorkspace(d1Binding(d1, link), { organizationName: opts.organizationName, agentName: opts.agentName, scopes: opts.scopes }, { now, newId, randomBytes: env.randomBytes })
    return { organizationId: w.organizationId, userId: null, agentId: w.agentId, apiKeyId: w.apiKeyId, key: w.key, deployment }
  }
  const r = await bootstrap(
    d1Binding(d1, link),
    {
      organizationName: opts.organizationName,
      email: opts.email!,
      userName: opts.userName,
      agentName: opts.agentName!,
      scopes: opts.scopes,
      authProvider: link.authProvider,
      authSubject: opts.authSubject,
    },
    { now, newId, randomBytes: env.randomBytes },
  )
  return { organizationId: r.organizationId, userId: r.userId, agentId: r.agentId, apiKeyId: r.apiKeyId, key: r.key, deployment }
}

/**
 * Proves, on the live database, that `D1Like.batch` is one transaction before a remote bootstrap trusts it ([[OPS4]] C8): a
 * batch of the marker insert plus a statement that cannot succeed must reject and leave no marker. `'skipped'` when a marker
 * already exists (the resumable path). A leaked probe row holds exactly the link bootstrap would write, so a resumed
 * bootstrap adopts it. Not a resource write: no event (the marker is machinery).
 */
export async function probeBatchAtomicity(d1: D1Like, link: DeploymentLink): Promise<'atomic' | 'not-atomic' | 'skipped'> {
  if (await readDeployment(d1)) return 'skipped'
  try {
    await d1.batch([markerInsert(d1, link), d1.prepare('select * from __vault_atomicity_probe')])
    return 'not-atomic'
  } catch {
    // expected: the second statement has no such table
  }
  return (await readDeployment(d1)) ? 'not-atomic' : 'atomic'
}

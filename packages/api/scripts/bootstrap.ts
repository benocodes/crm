import { parseArgs } from 'node:util'
import { createDb } from '@vault/db'
import { bootstrap } from '../src/bootstrap.js'

function usage(message: string): never {
  console.error(`bootstrap: ${message}`)
  console.error('usage: pnpm -C packages/api bootstrap -- --org <name> --email <email> --agent <name> [--scopes a:read,b:write] [--name <user name>] [--auth-provider clerk] [--auth-subject <provider user id>]')
  process.exit(1)
}

let values: ReturnType<typeof parseArgs>['values']
try {
  values = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      org: { type: 'string' },
      email: { type: 'string' },
      agent: { type: 'string' },
      scopes: { type: 'string' },
      name: { type: 'string' },
      'auth-provider': { type: 'string' },
      'auth-subject': { type: 'string' },
    },
    strict: true,
  }).values
} catch (err) {
  usage(err instanceof Error ? err.message : 'bad arguments')
}
const { org, email, agent, scopes, name } = values as Record<string, string | undefined>
const authProvider = values['auth-provider'] as string | undefined
const authSubject = values['auth-subject'] as string | undefined
if (!org || !email || !agent) usage('--org, --email and --agent are required')

const db = createDb(process.env.DATABASE_URL ?? 'postgresql://vault_app@localhost/vault_dev', { max: 1 })
try {
  const r = await bootstrap(db, {
    organizationName: org!,
    email: email!,
    userName: name,
    authProvider,
    authSubject,
    agentName: agent!,
    scopes: scopes ? scopes.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  })
  console.log(`organization_id: ${r.organizationId}`)
  console.log(`user_id:         ${r.userId}`)
  console.log(`agent_id:        ${r.agentId}`)
  console.log(`api_key_id:      ${r.apiKeyId}`)
  console.log(`api_key:         ${r.key}   (shown once)`)
} catch (err) {
  console.error('bootstrap failed:', err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  await db.destroy()
}

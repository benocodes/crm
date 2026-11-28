import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildCli } from '../scripts/build.js'
import { type Docs, projectWithTool, TOOL_VERSION, workspaceDocuments } from './test/gen-rig.js'

// DX712 group 6 (DX694 D3, D8): the built dist/vibase.js as a real process, in a project where openapi-typescript 7
// resolves, against a real local HTTP server. This is what proves the computed-specifier load survives esbuild.
const run = promisify(execFile)
let docs: Docs
let dir: string
let bundle: string
let server: ReturnType<typeof createServer>
let origin: string
beforeAll(async () => {
  docs = await workspaceDocuments()
  dir = mkdtempSync(join(tmpdir(), 'vibase-gen-bundle-'))
  bundle = join(dir, 'vibase.js')
  await buildCli({ outfile: bundle })
  server = createServer((req, res) => {
    const send = (body: unknown) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(body))
    }
    if (req.url === '/.well-known/vibase')
      return send({ openapi: { api: `${origin}/api/v1/openapi.json`, meta: `${origin}/meta/v1/openapi.json` } })
    if (req.url === '/api/v1/openapi.json') return send(docs.api)
    if (req.url === '/meta/v1/openapi.json') return send(docs.meta)
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)
afterAll(() => new Promise<void>((ok) => server.close(() => ok())))

const env = () => ({ PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir })

describe('the built bundle, as a child process', () => {
  it('writes the two files, resolving openapi-typescript from its working directory', async () => {
    const project = projectWithTool()
    const { stdout } = await run(
      process.execPath,
      [bundle, 'gen', 'types', '--out', 'src/vibase', '--server', origin],
      {
        cwd: project,
        env: env(),
      },
    )
    const out = JSON.parse(stdout)
    expect(out.server).toBe(origin)
    expect(out.files).toEqual([join(project, 'src/vibase/operations.ts'), join(project, 'src/vibase/types.ts')])
    const types = readFileSync(out.files[1], 'utf8')
    expect(types.split('\n')[2]).toContain(`openapi-typescript ${TOOL_VERSION}`)
    expect(types).toContain('export type WorkspaceOperations = {')
    expect(readFileSync(out.files[0], 'utf8')).toContain(`'projects__c.list'`)
  }, 120_000)

  it('refuses with missing_dependency (exit 2) in a project with no openapi-typescript', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'vibase-gen-empty-'))
    const failed = await run(process.execPath, [bundle, 'gen', 'types', '--out', 'o', '--server', origin], {
      cwd: empty,
      env: env(),
    }).catch((e) => e)
    expect(failed.code).toBe(2)
    expect(JSON.parse(failed.stderr).error.code).toBe('missing_dependency')
  }, 60_000)
})

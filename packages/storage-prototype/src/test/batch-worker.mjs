// Local test transport only. Never deploy this raw-SQL endpoint.
export default {
  async fetch(request, env) {
    const route = new URL(request.url).pathname
    const key = route === '/a' ? 'A' : route === '/b' ? 'B' : null
    if (!key) return Response.json({ error: 'unknown route' }, { status: 404 })
    const program = await request.json()
    if (program.context.organizationId !== env['ORG_' + key])
      return Response.json({ error: 'organization_forbidden', statements: 0 }, { status: 403 })
    try {
      const db = env['DB_' + key]
      const statements = program.statements.map((s) =>
        s.parameters.length ? db.prepare(s.sql).bind(...s.parameters) : db.prepare(s.sql),
      )
      const results = await db.batch(statements)
      return Response.json({ results, statements: statements.length, batches: 1 })
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 })
    }
  },
}

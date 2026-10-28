import { describe, expect, it } from 'vitest'
import { splitStatements } from './index.js'

describe('splitStatements (CORE25 P14)', () => {
  it('keeps a multi-line trigger whole', () => {
    const sql = `CREATE TABLE x (a TEXT) STRICT;

CREATE TRIGGER t BEFORE UPDATE ON x
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;
`
    const out = splitStatements(sql)
    expect(out).toHaveLength(2)
    expect(out[1]).toMatch(/END$/)
    expect(out[1]).toContain("SELECT RAISE(ABORT, 'append_only')")
  })

  it('keeps a one-line trigger as one statement', () => {
    const out = splitStatements("CREATE TRIGGER t BEFORE UPDATE ON x BEGIN SELECT RAISE(ABORT, 'append_only'); END;\nCREATE TABLE y (a TEXT) STRICT;")
    expect(out).toHaveLength(2)
    expect(out[0]).toMatch(/^CREATE TRIGGER t[\s\S]*END$/)
  })

  it('strips comment lines as before', () => {
    const out = splitStatements('-- a comment\nCREATE TABLE x (a TEXT) STRICT;\n-- another\nCREATE TABLE y (b TEXT) STRICT;')
    expect(out).toHaveLength(2)
    expect(out.join('\n')).not.toContain('comment')
  })
})

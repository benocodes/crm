// One private temp root per vitest run, removed when the run ends.
//
// Miniflare puts each instance's D1 and cache under `os.tmpdir()/miniflare-<hex>` and deletes it on `dispose()`
// fire-and-forget, so a test worker that exits right after its file leaves the folder behind: a full gate leaked
// hundreds (3-6 MB each) and filled the disk. Imported for its side effect by vitest.projects.ts, which every
// vitest config loads in vitest's main process before any worker forks: setting TMPDIR here sends every worker's
// `os.tmpdir()` (and Miniflare's) into the run's root, which goes on exit; a run that was killed (no exit handler)
// is swept by the next run, by the pid in its name.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PREFIX = 'vb-vitest-'
const MARK = 'VB_VITEST_TMPDIR'

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// A worker inherits the mark (and the TMPDIR) from the main process: only the first load sets up.
if (!process.env[MARK]) {
  const base = tmpdir()
  for (const name of readdirSync(base)) {
    const pid = Number(name.slice(PREFIX.length).split('-')[0])
    if (name.startsWith(PREFIX) && Number.isInteger(pid) && pid !== process.pid && !alive(pid)) {
      rmSync(join(base, name), { recursive: true, force: true })
    }
  }
  const root = mkdtempSync(join(base, `${PREFIX}${process.pid}-`))
  process.env[MARK] = root
  process.env.TMPDIR = root
  process.on('exit', () => rmSync(root, { recursive: true, force: true }))
}

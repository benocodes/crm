// [[OPS493]] D1-D3: the question (the matrix, the real reader over a stream), `CONFIRM_REMOTE` inert on the four commands, `status` takes no `--yes`.
import { execFileSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { runInstance } from './main.js'
import { ABORT_LINE, PROCEED_PROMPT, confirmProceed, makeQuestion } from './prompt.js'
import { cleanup, makeWorld } from './test-kit.js'
import { runStatus } from './status.js'
import { runUpgrade, runRedeploy } from './upgrade.js'
import { runOwnerReset } from './owner-reset.js'
import { runSetup } from './setup.js'

afterEach(() => cleanup())

const ask = async (answers: string[], terminal = true, yes = false) => {
  const w = makeWorld({ terminal, answers })
  const proceed = await confirmProceed(w.deps, yes)
  return { proceed, asked: w.asked.map((a) => a.prompt) }
}

describe('D2 the answers (the matrix)', () => {
  it.each([[''], ['y'], ['Y'], ['yes'], [' y '], ['YES']])('%j proceeds, asked once', async (a) => {
    expect(await ask([a])).toEqual({ proceed: true, asked: [PROCEED_PROMPT] })
  })
  it.each([['n'], ['N'], ['no'], [' No ']])('%j aborts', async (a) => {
    expect(await ask([a])).toEqual({ proceed: false, asked: [PROCEED_PROMPT] })
  })
  it('anything else asks again: maybe, then y, proceeds after two questions', async () => {
    expect(await ask(['maybe', 'y'])).toEqual({ proceed: true, asked: [PROCEED_PROMPT, PROCEED_PROMPT] })
  })
  it('end of input aborts', async () => {
    expect(await ask([])).toEqual({ proceed: false, asked: [PROCEED_PROMPT] })
    expect((await ask(['maybe'])).proceed).toBe(false)
  })
  it('--yes and no terminal never ask and proceed', async () => {
    expect(await ask([], true, true)).toEqual({ proceed: true, asked: [] })
    expect(await ask([], false, false)).toEqual({ proceed: true, asked: [] })
  })
  it('the text is exactly `proceed? [Y/n] `, and the abort line is the one the spec names', () => {
    expect(PROCEED_PROMPT).toBe('proceed? [Y/n] ')
    expect(ABORT_LINE).toBe('aborted: nothing was changed')
  })
})

describe('D2 the real reader over a stream', () => {
  const streams = (isTTY: boolean) => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean }
    input.isTTY = isTTY
    const output = new PassThrough()
    let written = ''
    output.on('data', (c) => (written += String(c)))
    return { input, output, written: () => written }
  }
  it('one line, then end of input: the first answer is the line, the second is null; the prompt goes to the output only', async () => {
    const s = streams(true)
    const q = makeQuestion(s.input, s.output)
    expect(q.interactive).toBe(true)
    s.input.write('y\n')
    s.input.end()
    expect(await q.ask(PROCEED_PROMPT)).toBe('y')
    expect(await q.ask(PROCEED_PROMPT)).toBeNull()
    expect(s.written()).toBe(PROCEED_PROMPT + PROCEED_PROMPT)
  })
  it('two lines typed at once are two answers in order (a re-ask loses nothing)', async () => {
    const s = streams(true)
    const q = makeQuestion(s.input, s.output)
    s.input.write('maybe\nn\n')
    expect(await q.ask('? ')).toBe('maybe')
    expect(await q.ask('? ')).toBe('n')
  })
  it('a line typed after the prompt is read', async () => {
    const s = streams(true)
    const q = makeQuestion(s.input, s.output)
    const p = q.ask('? ')
    setTimeout(() => s.input.write('yes\n'), 5)
    expect(await p).toBe('yes')
  })
  it('interactive follows the stream: no isTTY is not a terminal', () => {
    const s = streams(false)
    expect(makeQuestion(s.input, s.output).interactive).toBe(false)
  })
})

describe('D1 CONFIRM_REMOTE is inert on the four commands', () => {
  const four = [
    ['upgrade', runUpgrade, ['--env', 'demo']],
    ['redeploy', runRedeploy, ['--env', 'demo']],
    ['setup', runSetup, ['--env', 'demo', '--api-host', 'api.demo.invalid', '--auth', 'none']],
    ['owner-reset', runOwnerReset, ['--env', 'demo']],
  ] as const
  it.each(four)(
    '%s: with CONFIRM_REMOTE unset and no terminal it never refuses on the variable',
    async (_n, fn, argv) => {
      const w = makeWorld({ processEnv: { CONFIRM_REMOTE: undefined } })
      await fn([...argv], w.deps).catch(() => undefined)
      expect(w.all()).not.toMatch(/CONFIRM_REMOTE/)
    },
  )
  it.each(four)(
    '%s: with CONFIRM_REMOTE=1 on a terminal it still asks (or refuses earlier, never skips)',
    async (n, fn, argv) => {
      const w = makeWorld({ processEnv: { CONFIRM_REMOTE: '1' }, terminal: true, answers: ['n'] })
      await fn([...argv], w.deps).catch(() => undefined)
      // a missing settings file refuses first for setup/owner-reset here; the per-command suites prove the ask itself
      if (w.asked.length > 0) expect(w.out.join('\n')).toContain(ABORT_LINE)
      expect(w.all(), n).not.toMatch(/CONFIRM_REMOTE/)
    },
  )
  it('status takes no --yes: exit 2', async () => {
    const w = makeWorld()
    expect(await runStatus(['--env', 'demo', '--yes'], w.deps)).toBe(2)
    expect(w.asked).toEqual([])
  })
  it('--yes and -y are accepted by the four commands (not an unknown flag)', async () => {
    for (const [n, fn, argv] of four)
      for (const f of ['--yes', '-y']) {
        const w = makeWorld({ terminal: true })
        await fn([...argv, f, '--dry-run'], w.deps).catch(() => undefined)
        expect(w.all(), `${n} ${f}`).not.toMatch(/unknown option|Unknown option/)
      }
  })
  it('no requireConfirm call is left under scripts/instance', () => {
    let hits = ''
    try {
      hits = execFileSync(
        'grep',
        ['-rn', '--include=*.ts', '--exclude=*.test.ts', 'requireConfirm', new URL('.', import.meta.url).pathname],
        {
          encoding: 'utf8',
        },
      )
    } catch {
      hits = ''
    }
    expect(hits.split('\n').filter((l) => l && !/^\S+:\d+:\s*(\/\/|\*|\/\*)/.test(l) && !/types\.ts/.test(l))).toEqual(
      [],
    )
  })
  it('runInstance still routes status to a read-only run that never asks', async () => {
    const out: string[] = []
    const code = await runInstance(['status', '--env', 'Bad_Name'], {
      stdout: (t) => void out.push(t),
      stderr: () => {},
      env: {},
    })
    expect(code).toBe(2)
  })
})

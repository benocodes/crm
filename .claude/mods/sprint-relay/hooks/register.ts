import type { Register } from 'claude-code'

const NAME = 'next_cycle'
const TOOL = 'mcp__sprint-relay__next_cycle'

const DESCRIPTION = [
  'Call this as the LAST action of a sprint cycle, after the PR is merged and SPRINT.md is checkpointed and committed.',
  'With outcome "cycle_done" the session ends this turn, the context is cleared, and a fresh orchestrator starts the next cycle.',
  'Put in `handoff` only what the next orchestrator needs that SPRINT.md does not already say (short; omit if nothing).',
  'With outcome "hard_stop" or "sprint_finished" nothing restarts: report to the user instead.',
  'Never call it while a worktree, agent or PR from this cycle is still open.',
].join(' ')

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['cycle_done', 'hard_stop', 'sprint_finished'] },
    handoff: { type: 'string', description: 'Short note to the next orchestrator; only what SPRINT.md lacks.' },
  },
  required: ['outcome'],
}

type Input = { outcome?: string; handoff?: string }

export const register: Register = (on) => {
  let pending: { handoff: string } | undefined

  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: NAME, description: DESCRIPTION, inputSchema: INPUT_SCHEMA, isDeferred: false })
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e, next) => {
    const input = e as unknown as Input
    if (input.outcome !== 'cycle_done') {
      return { result: `Not restarting (${input.outcome}). Stop here and tell the user.` }
    }
    pending = { handoff: (input.handoff ?? '').trim() }
    return { result: 'Restart scheduled. Write nothing more: end your turn now with one line.' }
  })

  // The restart waits for the turn to end: /clear runs once the session is idle.
  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (!pending || e.agentId) return out
    const { handoff } = pending
    pending = undefined
    $.clock.after(500, async () => {
      try {
        await $.command.run({ command: 'clear' })
        await $.tool.register({ name: NAME, description: DESCRIPTION, inputSchema: INPUT_SCHEMA, isDeferred: false })
        await $.prompt.submit({
          asUser: true,
          text: [
            'You are the sprint orchestrator, resuming after a context reset between cycles.',
            'Follow the orchestrator instructions (.claude/agents/orchestrator.md) if they are not already in your system prompt.',
            'Read knowledge/SPRINT.md (Position, Open Questions, Next Action), then run the next cycle.',
            handoff ? `Handoff from your previous self:\n${handoff}` : 'No extra handoff: SPRINT.md is complete.',
            `When that cycle is merged and checkpointed, call ${TOOL} again.`,
          ].join('\n\n'),
        })
      } catch (err) {
        $.ui.toast(`sprint-relay: restart failed: ${String(err).slice(0, 120)}`)
      }
    })
    return out
  })
}

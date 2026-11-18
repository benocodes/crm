import { describe, expect, it } from 'vitest'
import { getStarted } from './first-steps.js'

// [[UI461]] D10, P4 (group 3): the pure view model. Get started renders only while it holds a prompt or an error; an error is never also the prompt.
describe('getStarted', () => {
  it('show: the prompt, no error', () => {
    expect(getStarted({ status: 'show' })).toEqual({ prompt: true, error: null })
  })
  it('error: the one-line message and no prompt', () => {
    expect(getStarted({ status: 'error', message: 'The agents could not be read (500).' })).toEqual({
      prompt: false,
      error: 'The agents could not be read (500).',
    })
  })
  it('hidden: no Get started at all', () => {
    expect(getStarted({ status: 'hidden' })).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { DEFAULT_CAPTURE_LABELS } from '../../connections/capture-settings.js'
import { capturesLabels } from './labels.js'

// [[CHN407]] D2: the label rule over a given list. With the default list it is [[CHN5]] D5/D70's rule, case for case.
const DEFAULT = DEFAULT_CAPTURE_LABELS

describe('the label rule over a given list (CHN407 D2)', () => {
  it('the default list is the old rule: INBOX or SENT admitted, the rest refused', () => {
    expect(capturesLabels(['INBOX'], DEFAULT)).toBe(true)
    expect(capturesLabels(['SENT'], DEFAULT)).toBe(true)
    expect(capturesLabels(['INBOX', 'UNREAD', 'CATEGORY_UPDATES'], DEFAULT)).toBe(true)
    expect(capturesLabels(['IMPORTANT'], DEFAULT)).toBe(false)
    expect(capturesLabels(['Label_1'], DEFAULT)).toBe(false)
    expect(capturesLabels([], DEFAULT)).toBe(false)
    expect(capturesLabels(undefined, DEFAULT)).toBe(false)
  })
  it('one of several listed labels admits', () => {
    expect(capturesLabels(['Label_2'], ['INBOX', 'Label_2', 'Label_3'])).toBe(true)
    expect(capturesLabels(['Label_3', 'STARRED'], ['INBOX', 'Label_2', 'Label_3'])).toBe(true)
  })
  it('a user label admits only when listed', () => {
    expect(capturesLabels(['Label_1'], ['Label_1'])).toBe(true)
    expect(capturesLabels(['Label_1'], ['INBOX', 'SENT'])).toBe(false)
    expect(capturesLabels(['Label_1'], ['Label_2'])).toBe(false)
  })
  it('INBOX mail on a list of SENT alone is refused, and SENT mail on a list of INBOX alone', () => {
    expect(capturesLabels(['INBOX'], ['SENT'])).toBe(false)
    expect(capturesLabels(['SENT'], ['INBOX'])).toBe(false)
  })
  it.each(['DRAFT', 'SPAM', 'TRASH', 'CHAT'])('%s refuses even beside a listed label', (bad) => {
    expect(capturesLabels(['INBOX', bad], DEFAULT)).toBe(false)
    expect(capturesLabels(['Label_1', bad], ['Label_1'])).toBe(false)
  })
  it('an empty labelIds refuses, whatever the list', () => {
    expect(capturesLabels([], ['Label_1'])).toBe(false)
    expect(capturesLabels(undefined, ['INBOX'])).toBe(false)
  })
})

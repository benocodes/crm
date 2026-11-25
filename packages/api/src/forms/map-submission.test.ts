import { describe, expect, it } from 'vitest'
import { stringifyMarkdown } from '../channels/markdown.js'
import { ApiError } from '../errors.js'
import type { FormIngress } from './ingress-read.js'
import {
  formSubmitter,
  mapFormSubmission,
  originalOf,
  type FormAnswer,
  type FormSubmissionInput,
} from './map-submission.js'

// [[CHN428]]: the submitter (D8, a matrix) and the mapper's content (D13, D15), pure.
const FORM: FormIngress = {
  form_id: '0190b2c4-0000-7000-8000-0000000f0001',
  organization_id: '0190b2c4-0000-7000-8000-000000000001',
  name: 'Website contact',
  enabled: true,
  allowed_origins: ['https://site.test'],
  email_field: 'email',
  phone_field: 'phone',
  name_field: 'name',
  consent_text: null,
  challenge: 'turnstile',
  tag_ids: [],
}
const f = (name: string, value: string | string[]): FormAnswer => ({ name, value })
const refusal = (fn: () => unknown): ApiError => {
  try {
    fn()
  } catch (err) {
    if (err instanceof ApiError) return err
    throw err
  }
  throw new Error('expected a refusal')
}

describe('formSubmitter (D8), case to outcome', () => {
  it.each([
    [
      'email mapped and present',
      FORM,
      [f('email', ' Jane@Acme.test '), f('name', 'Jane')],
      { kind: 'email', value: 'jane@acme.test', name: 'Jane' },
    ],
    [
      'email blank after trimming, so the phone is used',
      FORM,
      [f('email', '   '), f('phone', '+1 (415) 555-0100')],
      { kind: 'phone', value: '+14155550100' },
    ],
    [
      'email absent from the answers, so the phone is used',
      FORM,
      [f('phone', '+14155550100')],
      { kind: 'phone', value: '+14155550100' },
    ],
    [
      'both present: the email wins',
      FORM,
      [f('email', 'a@b.test'), f('phone', '+14155550100')],
      { kind: 'email', value: 'a@b.test' },
    ],
    [
      'a name that cleanName blanks is no name',
      FORM,
      [f('email', 'a@b.test'), f('name', '   ')],
      { kind: 'email', value: 'a@b.test' },
    ],
    [
      'a form with no email_field mapped',
      { ...FORM, email_field: null },
      [f('email', 'a@b.test'), f('phone', '+14155550100')],
      { kind: 'phone', value: '+14155550100' },
    ],
    [
      'a name_field that is not mapped gives no name',
      { ...FORM, name_field: null },
      [f('email', 'a@b.test'), f('name', 'Jane')],
      { kind: 'email', value: 'a@b.test' },
    ],
  ])('%s', (_case, form, fields, expected) => {
    expect(formSubmitter(form, fields)).toEqual(expected)
  })

  it('both present: the phone is not resolved, it stays an answer in the message', () => {
    const input = base({ fields: [f('email', 'a@b.test'), f('phone', '+14155550100')] })
    const submitter = formSubmitter(FORM, input.fields)
    expect(submitter.kind).toBe('email')
    expect(JSON.stringify(mapFormSubmission(input, submitter).message.formatted)).toContain('+14155550100')
  })

  it('neither present: validation_error with the spec message', () => {
    for (const fields of [[], [f('email', ' '), f('phone', '')], [f('name', 'Jane')]]) {
      const err = refusal(() => formSubmitter(FORM, fields))
      expect([err.status, err.code, err.message]).toEqual([400, 'validation_error', 'email or phone required'])
    }
  })

  it('an email or phone that does not normalise: validation_error naming the field', () => {
    expect(refusal(() => formSubmitter(FORM, [f('email', 'not-an-email')]))).toMatchObject({
      status: 400,
      code: 'validation_error',
      message: expect.stringMatching(/^email: /),
    })
    expect(refusal(() => formSubmitter({ ...FORM, email_field: null }, [f('phone', 'abc')]))).toMatchObject({
      code: 'validation_error',
      message: expect.stringMatching(/^phone: /),
    })
    expect(refusal(() => formSubmitter(FORM, [f('email', ['a@b.test', 'c@d.test'])]))).toMatchObject({
      code: 'validation_error',
      message: expect.stringMatching(/^email: /),
    })
  })
})

function base(over: Partial<FormSubmissionInput> = {}): FormSubmissionInput {
  return {
    form: FORM,
    public_id: 'frm_aaaaaaaaaaaaaaaaaaaaaaaaaa',
    fields: [f('email', 'jane@acme.test'), f('interests', ['a', 'b']), f('note', 'Hello')],
    consent_given: false,
    anonymous_id: null,
    origin: 'https://site.test',
    content_type: 'application/x-www-form-urlencoded',
    received_at: '2026-11-18T09:00:00.000Z',
    submission_id: '0190b2c4-0000-7000-8000-0000000000aa',
    ...over,
  }
}
const contentOf = (input: FormSubmissionInput) => {
  const cm = mapFormSubmission(input, formSubmitter(input.form, input.fields))
  return { cm, body: stringifyMarkdown(cm.message.formatted), original: originalOf(input) }
}

describe('the mapper (D13, D15): body.md and original.json byte for byte', () => {
  it('no consent text: one paragraph per answer in order, an array joined with ", ", no consent section', () => {
    const { body, original } = contentOf(base({ anonymous_id: 'anon-1' }))
    expect(body).toBe('**email:** jane\\@acme.test\n\n**interests:** a, b\n\n**note:** Hello\n')
    expect(JSON.stringify(original)).toBe(
      '{"form_id":"0190b2c4-0000-7000-8000-0000000f0001","public_id":"frm_aaaaaaaaaaaaaaaaaaaaaaaaaa","received_at":"2026-11-18T09:00:00.000Z","origin":"https://site.test","content_type":"application/x-www-form-urlencoded","fields":[{"name":"email","value":"jane@acme.test"},{"name":"interests","value":["a","b"]},{"name":"note","value":"Hello"}],"consent":{"given":false,"text":null},"anonymous_id":"anon-1"}',
    )
  })

  it.each([
    [true, 'yes'],
    [false, 'no'],
  ])('with a consent text, consent_given %s: the section states it and quotes the text', async (given, word) => {
    const form = { ...FORM, consent_text: 'We store your message.' }
    const { body, original } = contentOf(base({ form, consent_given: given }))
    expect(body).toBe(
      `**email:** jane\\@acme.test\n\n**interests:** a, b\n\n**note:** Hello\n\n**Consent given:** ${word}\n\n> We store your message.\n`,
    )
    expect(original.consent).toEqual({ given, text: 'We store your message.' })
  })

  it('anonymous_id is carried when present and null when not', () => {
    expect(contentOf(base({ anonymous_id: 'a.b:c_d-1' })).original.anonymous_id).toBe('a.b:c_d-1')
    expect(contentOf(base()).original.anonymous_id).toBeNull()
  })

  it('neither file holds a connecting IP, a user agent, a token or a honeypot value passed in alongside', () => {
    const extras = {
      ip: '203.0.113.9',
      user_agent: 'Mozilla/5.0 Secret',
      token: 'TURNSTILE-TOKEN-xyz',
      honeypot: 'HONEY-bot',
    }
    const input = { ...base(), ...extras } as FormSubmissionInput
    const { cm, body, original } = contentOf(input)
    const all = body + JSON.stringify(original) + JSON.stringify(cm.facts)
    for (const secret of Object.values(extras)) expect(all).not.toContain(secret)
  })

  it('the port message: external id and provider ids are the submission id, subject the form name, one from participant, no attachments', () => {
    const input = base({ fields: [f('email', 'Jane@Acme.test'), f('name', 'Jane')] })
    const { cm } = contentOf(input)
    expect(cm.facts).toEqual({
      channel: 'form',
      kind: 'message',
      external_id: input.submission_id,
      in_reply_to: null,
      thread_hints: [],
      provider_message_id: input.submission_id,
      provider_thread_id: 'email:jane@acme.test',
      occurred_at: input.received_at,
      subject: 'Website contact',
      participants: [{ kind: 'email', value: 'jane@acme.test', name: 'Jane', role: 'from' }],
      sent_by_connection: false,
      attachments: [],
    })
    expect(cm.message.author).toEqual({
      userId: 'jane@acme.test',
      userName: 'Jane',
      fullName: 'Jane',
      isBot: false,
      isMe: false,
    })
    expect(cm.raw.ext).toBe('json')
  })
})

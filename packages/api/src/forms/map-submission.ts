import type { Root } from 'mdast'
import { ApiError } from '../errors.js'
import { cleanName } from '../identity/resolve.js'
import { normalizeIdentityValue } from '../identity/normalize.js'
import { toPlainText } from '../channels/markdown.js'
import type { ChannelMessage, VibaseMessage } from '../channels/port.js'
import type { FormIngress } from './ingress-read.js'

// [[CHN421]] D8 (the submitter), D13 and D15 (the mapper and its content): pure functions, no I/O. [[CHN428]].

/** One non-reserved field as parsed, in submission order. A repeated name arrives as one array value ([[CHN421]] D2). */
export interface FormAnswer {
  name: string
  value: string | string[]
}

export interface FormSubmitter {
  kind: 'email' | 'phone'
  /** Normalised with `normalizeIdentityValue`. */
  value: string
  /** `cleanName` of the form's `name_field` value; absent when blank or not mapped. */
  name?: string
}

/** What the capture takes of one submission ([[CHN428]] P1, 428.2): the reserved fields are already extracted ([[CHN421]] D3). */
export interface FormSubmissionInput {
  form: FormIngress
  /** The form's public id: the form as read does not carry it, the route knows it. */
  public_id: string
  fields: readonly FormAnswer[]
  consent_given: boolean
  /** Already validated (D3) or null. */
  anonymous_id: string | null
  origin: string
  content_type: string
  /** ISO instant of receipt. */
  received_at: string
  /** The minted UUIDv7: the message's external id and its provider message id. */
  submission_id: string
}

const asText = (v: string | string[]): string => (Array.isArray(v) ? v.join(', ') : v)
const valueOf = (fields: readonly FormAnswer[], name: string | null): string | string[] | undefined =>
  name === null ? undefined : fields.find((f) => f.name === name)?.value

/**
 * D8: the mapped email when present (non-empty after trimming), else the mapped phone; neither is `400 validation_error`
 * (`email or phone required`); a value that does not normalise (or an array) is `400 validation_error` naming the field. The
 * other identity field stays an answer.
 */
export function formSubmitter(
  form: Pick<FormIngress, 'email_field' | 'phone_field' | 'name_field'>,
  fields: readonly FormAnswer[],
): FormSubmitter {
  const present = (field: string | null): { field: string; raw: string | string[] } | null => {
    const raw = valueOf(fields, field)
    if (field === null || raw === undefined) return null
    return asText(raw).trim() === '' ? null : { field, raw }
  }
  const chosen = [
    { kind: 'email' as const, hit: present(form.email_field) },
    { kind: 'phone' as const, hit: present(form.phone_field) },
  ].find((c) => c.hit !== null)
  if (!chosen?.hit) throw new ApiError(400, 'validation_error', 'email or phone required')
  const { field, raw } = chosen.hit
  if (Array.isArray(raw)) throw new ApiError(400, 'validation_error', `${field}: a single value is required`)
  let value: string
  try {
    value = normalizeIdentityValue(chosen.kind, raw)
  } catch (err) {
    if (err instanceof ApiError) throw new ApiError(400, 'validation_error', `${field}: ${err.message}`)
    throw err
  }
  const nameRaw = valueOf(fields, form.name_field)
  const name = nameRaw === undefined ? undefined : cleanName(asText(nameRaw))
  return { kind: chosen.kind, value, ...(name ? { name } : {}) }
}

/** The submission's body as markdown: one paragraph per answer, then the consent section when the form has a consent text (D13, D15). */
function bodyOf(input: FormSubmissionInput): Root {
  const paragraph = (label: string, text: string) => ({
    type: 'paragraph' as const,
    children: [
      { type: 'strong' as const, children: [{ type: 'text' as const, value: `${label}:` }] },
      { type: 'text' as const, value: ` ${text}` },
    ],
  })
  const children: Root['children'] = input.fields.map((f) => paragraph(f.name, asText(f.value)))
  if (input.form.consent_text !== null) {
    children.push(paragraph('Consent given', input.consent_given ? 'yes' : 'no'))
    children.push({
      type: 'blockquote',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: input.form.consent_text }] }],
    })
  }
  return { type: 'root', children }
}

/** The `v1/original.json` document (D13, D15). `fields` is an array, so submission order survives integer-like names. No IP, user agent, token or honeypot. */
export function originalOf(input: FormSubmissionInput) {
  return {
    form_id: input.form.form_id,
    public_id: input.public_id,
    received_at: input.received_at,
    origin: input.origin,
    content_type: input.content_type,
    fields: input.fields.map((f) => ({ name: f.name, value: f.value })),
    consent: { given: input.consent_given, text: input.form.consent_text },
    anonymous_id: input.anonymous_id,
  }
}

/** D13: the submission as a channel-port message. The submitter comes from `formSubmitter`. */
export function mapFormSubmission(input: FormSubmissionInput, submitter: FormSubmitter): ChannelMessage {
  const formatted = bodyOf(input)
  const display = submitter.name ?? submitter.value
  const message: VibaseMessage = {
    id: `form:${input.form.form_id}:${input.submission_id}`,
    threadId: `form:${input.form.form_id}:${submitter.kind}:${submitter.value}`,
    text: toPlainText(formatted),
    formatted,
    author: { userId: submitter.value, userName: display, fullName: display, isBot: false, isMe: false },
    metadata: { dateSent: new Date(input.received_at), edited: false },
    attachments: [],
  }
  const bytes = new TextEncoder().encode(JSON.stringify(originalOf(input)))
  return {
    message,
    facts: {
      channel: 'form',
      kind: 'message',
      external_id: input.submission_id,
      in_reply_to: null,
      thread_hints: [],
      provider_message_id: input.submission_id,
      provider_thread_id: `${submitter.kind}:${submitter.value}`,
      occurred_at: input.received_at,
      subject: input.form.name,
      participants: [
        {
          kind: submitter.kind,
          value: submitter.value,
          ...(submitter.name ? { name: submitter.name } : {}),
          role: 'from',
        },
      ],
      sent_by_connection: false,
      attachments: [],
    },
    raw: { ext: 'json', content_type: 'application/json', size: bytes.byteLength, open: async () => bytes },
  }
}

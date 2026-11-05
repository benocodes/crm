// The Gmail mapper ([[CHN5]] D35, [[CORE25]] "Channel port"): a `format=full` resource to a `ChannelMessage`. Pure: no I/O; the lazy
// `raw` is the caller's `openRaw`. HTML to mdast is `hast-util-from-html` then `hast-util-to-mdast` (D45), rendered later by the vendored
// `stringifyMarkdown`; the text part is used only when there is no HTML part ([[CORE25]] D36).
import type { Element, Nodes as HastNodes, Root as HastRoot } from 'hast'
import { fromHtml } from 'hast-util-from-html'
import { toMdast } from 'hast-util-to-mdast'
import type { PhrasingContent, Root } from 'mdast'
import { toPlainText } from '../markdown.js'
import type { ChannelFacts, ChannelMessage, ParticipantRole, VaultMessage } from '../port.js'
import { charsetOf, decodeCharset, decodeMimeWords, header, messageIdTokens, parseAddressList } from './mime.js'
import type { GmailMessagePart, GmailMessageResource } from './types.js'

export interface GmailConnection {
  id: string
  /** The mailbox's address; encoded into the adapter-style message ids (`gmail:<base64url mailbox>:<id>`). */
  mailbox: string
}

export interface MapperInput {
  conn: GmailConnection
  resource: GmailMessageResource
  /** Opens the `format=raw` original, decoded. Called only when the pipeline reads `raw`. */
  openRaw: () => Promise<ReadableStream<Uint8Array>>
}

const MAX_HINTS = 20

const base64Url = (text: string): string => {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function bodyBytes(part: GmailMessagePart): Uint8Array {
  const data = part.body?.data ?? ''
  const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

interface Walked {
  bodies: GmailMessagePart[]
  attachments: GmailMessagePart[]
}
/** Depth-first, in order. A part with an attachment id is an attachment (position = its order among them); text parts without one are the body. */
function walk(part: GmailMessagePart, into: Walked = { bodies: [], attachments: [] }): Walked {
  const mime = (part.mimeType ?? '').toLowerCase()
  if (part.body?.attachmentId) {
    into.attachments.push(part)
    return into
  }
  if (mime === 'message/rfc822') return into // an embedded message without an attachment id has nothing to fetch
  if (part.parts) for (const child of part.parts) walk(child, into)
  else if ((mime === 'text/plain' || mime === 'text/html') && !part.filename && part.body?.data !== undefined) into.bodies.push(part)
  return into
}

const DROP = new Set(['head', 'style', 'script', 'title', 'meta', 'link', 'noscript'])
function prune(node: HastNodes): void {
  if (node.type !== 'root' && node.type !== 'element') return
  node.children = node.children.filter((c) => !(c.type === 'element' && DROP.has((c as Element).tagName)))
  for (const c of node.children) prune(c)
}

function htmlToMdast(html: string): PhrasingContent[] | Root['children'] {
  const tree = fromHtml(html, { fragment: false }) as HastRoot
  prune(tree)
  const out = toMdast(tree) as Root
  return out.children
}

function textToMdast(text: string): Root['children'] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((block) => block.replace(/^\n+|\s+$/g, ''))
    .filter((block) => block.trim() !== '')
    .map((block) => ({ type: 'paragraph' as const, children: [{ type: 'text' as const, value: block }] }))
}

function formattedOf(bodies: GmailMessagePart[]): Root {
  const html = bodies.filter((p) => (p.mimeType ?? '').toLowerCase() === 'text/html')
  const chosen = html.length > 0 ? html : bodies
  const children: Root['children'] = []
  for (const part of chosen) {
    const text = decodeCharset(bodyBytes(part), charsetOf(header(part.headers, 'Content-Type')) ?? 'utf-8')
    children.push(...((part.mimeType ?? '').toLowerCase() === 'text/html' ? (htmlToMdast(text) as Root['children']) : textToMdast(text)))
  }
  return { type: 'root', children }
}

const attachmentType = (mime: string): 'image' | 'video' | 'audio' | 'file' => {
  const m = mime.toLowerCase()
  return m.startsWith('image/') ? 'image' : m.startsWith('video/') ? 'video' : m.startsWith('audio/') ? 'audio' : 'file'
}

/** `format=full` resource to a `ChannelMessage`, or a skip reason ([[CHN5]] D35). */
export function mapGmailMessage(input: MapperInput): ChannelMessage | { skip: string } {
  const { conn, resource, openRaw } = input
  const labels = resource.labelIds ?? []
  if (labels.includes('DRAFT')) return { skip: 'draft' }
  const payload = resource.payload
  if (!payload) return { skip: 'no_payload' }
  const headers = payload.headers

  const dateHeader = header(headers, 'Date')
  const instant = resource.internalDate !== undefined && /^\d+$/.test(resource.internalDate) ? Number(resource.internalDate) : dateHeader ? Date.parse(dateHeader) : Number.NaN
  if (Number.isNaN(instant)) return { skip: 'no_date' }
  const occurred = new Date(instant)

  const rawId = header(headers, 'Message-ID')?.trim() ?? ''
  const bare = rawId.startsWith('<') && rawId.endsWith('>') ? rawId.slice(1, -1).trim() : rawId
  const externalId = bare !== '' ? bare : `gmail:${conn.id}:${resource.id}`

  const replyTo = messageIdTokens(header(headers, 'In-Reply-To'))
  const refs = messageIdTokens(header(headers, 'References')).reverse()
  const hints = [...new Set([...replyTo, ...refs])].slice(0, MAX_HINTS)

  const participants: ChannelFacts['participants'] = []
  for (const [name, role] of [['From', 'from'], ['To', 'to'], ['Cc', 'cc'], ['Bcc', 'bcc']] as Array<[string, ParticipantRole]>) {
    for (const a of parseAddressList(header(headers, name))) participants.push({ kind: 'email', value: a.value, ...(a.name === undefined ? {} : { name: a.name }), role })
  }
  const from = participants.find((p) => p.role === 'from')
  const sent = labels.includes('SENT')

  const subjectRaw = header(headers, 'Subject')
  const subject = subjectRaw === null || subjectRaw.trim() === '' ? null : decodeMimeWords(subjectRaw).trim()

  const walked = walk(payload)
  const formatted = formattedOf(walked.bodies)
  const attachments = walked.attachments.map((part, position) => {
    const mime = part.mimeType ?? 'application/octet-stream'
    const size = part.body?.size
    const disposition = header(part.headers, 'Content-Disposition')
    const cid = header(part.headers, 'Content-ID')?.trim().replace(/^<|>$/g, '') ?? ''
    return {
      attachment: {
        type: attachmentType(mime),
        ...(part.filename ? { name: part.filename } : {}),
        mimeType: mime,
        ...(size === undefined ? {} : { size }),
        fetchMetadata: { message_id: resource.id, attachment_id: part.body!.attachmentId!, ...(size === undefined ? {} : { size: String(size) }) },
      },
      fact: { position, inline: /^\s*inline/i.test(disposition ?? '') || cid !== '', content_id: cid === '' ? null : cid },
    }
  })

  const prefix = `gmail:${base64Url(conn.mailbox)}`
  const fullName = from?.name ?? from?.value.split('@')[0] ?? ''
  const message: VaultMessage = {
    id: `${prefix}:${resource.id}`,
    threadId: `${prefix}:${resource.threadId}`,
    text: toPlainText(formatted),
    formatted,
    author: { userId: from?.value ?? '', userName: from?.value ?? '', fullName, isBot: false, isMe: sent },
    metadata: { dateSent: occurred, edited: false },
    attachments: attachments.map((a) => a.attachment),
  }
  return {
    message,
    facts: {
      channel: 'email',
      kind: 'message',
      external_id: externalId,
      in_reply_to: replyTo[0] ?? null,
      thread_hints: hints,
      provider_message_id: resource.id,
      provider_thread_id: resource.threadId,
      occurred_at: occurred.toISOString(),
      subject,
      participants,
      sent_by_connection: sent,
      attachments: attachments.map((a) => a.fact),
    },
    raw: { ext: 'eml', content_type: 'message/rfc822', size: null, open: openRaw },
  }
}

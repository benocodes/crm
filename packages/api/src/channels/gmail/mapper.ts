// The Gmail mapper ([[CHN5]] D35, [[CORE25]] "Channel port"): a `format=full` resource to a `ChannelMessage`. Pure: no I/O; the lazy
// `raw` is the caller's `openRaw`. HTML to mdast is `parse5` (iterative), flattened past a depth bound ([[CORE571]] D1), `hast-util-from-parse5`, then `hast-util-to-mdast` (D45), rendered later by the vendored
// `stringifyMarkdown`; the text part is used only when there is no HTML part ([[CORE25]] D36).
import type { Element, Nodes as HastNodes, Root as HastRoot } from 'hast'
import { fromParse5 } from 'hast-util-from-parse5'
import { toMdast } from 'hast-util-to-mdast'
import type { PhrasingContent, Root } from 'mdast'
import { parse } from 'parse5'
import type { DefaultTreeAdapterMap } from 'parse5'
import { toPlainText } from '../markdown.js'
import type { ChannelFacts, ChannelMessage, ParticipantRole, VibaseMessage } from '../port.js'
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
/** A part with more multipart ancestors than this gives no body and no attachment ([[CORE571]] D4). */
export const MAX_MIME_DEPTH = 32
/** Element depth kept in an HTML body (`html` is 1): deeper elements are flattened into their nearest kept ancestor, text kept ([[CORE571]] D1). */
export const MAX_HTML_DEPTH = 256

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
function walk(root: GmailMessagePart): Walked {
  const into: Walked = { bodies: [], attachments: [] }
  // Iterative, so a resource nested thousands deep cannot overflow the stack; parts under more than `MAX_MIME_DEPTH` multipart levels are ignored ([[CORE571]] D4).
  const stack: Array<{ part: GmailMessagePart; depth: number }> = [{ part: root, depth: 0 }]
  while (stack.length > 0) {
    const { part, depth } = stack.pop()!
    if (depth > MAX_MIME_DEPTH) continue
    const mime = (part.mimeType ?? '').toLowerCase()
    if (part.body?.attachmentId) {
      into.attachments.push(part)
      continue
    }
    if (mime === 'message/rfc822') continue // an embedded message without an attachment id has nothing to fetch
    if (part.parts) {
      for (let i = part.parts.length - 1; i >= 0; i--) stack.push({ part: part.parts[i]!, depth: depth + 1 })
    } else if ((mime === 'text/plain' || mime === 'text/html') && !part.filename && part.body?.data !== undefined)
      into.bodies.push(part)
  }
  return into
}

const DROP = new Set(['head', 'style', 'script', 'title', 'meta', 'link', 'noscript', 'template'])

/** `0`, `0.0`, `.0px`, `0em`, `0%`: a zero number with any unit. */
const ZERO_LENGTH = /^[+-]?(0+\.?0*|\.0+)[a-z%]*$/
const ZERO_NUMBER = /^[+-]?(0+\.?0*|\.0+)%?$/

/** The element's own inline `style` declarations: lowercased, `!important` dropped, the last declaration of a property wins ([[AGT588]] D1). */
function declarations(style: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of style.replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
    const colon = part.indexOf(':')
    if (colon < 0) continue
    const prop = part.slice(0, colon).trim().toLowerCase()
    const value = part
      .slice(colon + 1)
      .replace(/!\s*important/gi, '')
      .trim()
      .toLowerCase()
    if (prop !== '' && value !== '') out.set(prop, value)
  }
  return out
}

/** Whether a mail client would not show this element or anything in it: `hidden`, or an own inline `style` that hides the subtree ([[AGT588]] D1; the inherited `font-size:0` and `visibility:hidden` are carried by `prune`). */
function isHidden(el: Element): boolean {
  const props = el.properties ?? {}
  if (props.hidden !== undefined && props.hidden !== false && props.hidden !== null) return true
  const raw = props.style
  if (typeof raw !== 'string' || raw === '') return false
  const d = declarations(raw)
  if (d.get('display') === 'none') return true
  const opacity = d.get('opacity')
  if (opacity !== undefined && ZERO_NUMBER.test(opacity)) return true
  const clipped = d.get('overflow') === 'hidden' || d.get('overflow-y') === 'hidden'
  if (clipped) {
    const height = d.get('height')
    const maxHeight = d.get('max-height')
    if ((height !== undefined && ZERO_LENGTH.test(height)) || (maxHeight !== undefined && ZERO_LENGTH.test(maxHeight)))
      return true
  }
  return false
}

/** Absolute and root-relative length units, and the absolute-size keywords: a non-zero size in one of them resets an inherited zero font ([[AGT588]] D1). */
const ABSOLUTE_FONT_SIZE = /^[+]?(\d+\.?\d*|\.\d+)(px|pt|pc|in|cm|mm|q|rem|vw|vh|vmin|vmax)$/
const SIZE_KEYWORDS = new Set(['xx-small', 'x-small', 'small', 'medium', 'large', 'x-large', 'xx-large', 'xxx-large'])

/** The two inherited hiding properties as an element's own inline style leaves them, given its parent's state ([[AGT588]] D1). */
function inherited(el: Element, zero: boolean, invisible: boolean): { zero: boolean; invisible: boolean } {
  const raw = el.properties?.style
  if (typeof raw !== 'string' || raw === '') return { zero, invisible }
  const d = declarations(raw)
  const fontSize = d.get('font-size')
  if (fontSize !== undefined) {
    if (ZERO_LENGTH.test(fontSize)) zero = true
    else if (ABSOLUTE_FONT_SIZE.test(fontSize) || SIZE_KEYWORDS.has(fontSize)) zero = false
    // em, ex, ch, %, smaller, larger, and anything unrecognised: relative to the parent, so the parent's state stays.
  }
  const visibility = d.get('visibility')
  if (visibility === 'hidden' || visibility === 'collapse') invisible = true
  else if (visibility === 'visible') invisible = false
  return { zero, invisible }
}

/**
 * One tree pass: drops the seven-tag set, `template`, hidden elements (with their content) and comments (Outlook conditional blocks included), turns an
 * `img` into its alt text, nothing when empty, so no image URL is stored, and carries the two inherited forms (`font-size:0`, `visibility:hidden`) down the
 * walk, dropping the text beneath them until a descendant's own style resets them. An alt is kept under a zero font, dropped while invisible
 * ([[AGT588]] D1 to D3).
 */
function prune(node: HastNodes, zero = false, invisible = false): void {
  if (node.type !== 'root' && node.type !== 'element') return
  const kept: HastNodes[] = []
  const below: Array<[HastNodes, boolean, boolean]> = []
  for (const c of node.children) {
    if (c.type === 'comment') continue
    if (c.type === 'text') {
      if (!zero && !invisible) kept.push(c)
      continue
    }
    if (c.type === 'element') {
      const el = c as Element
      if (DROP.has(el.tagName) || isHidden(el)) continue
      const state = inherited(el, zero, invisible)
      if (el.tagName === 'img') {
        const alt = el.properties?.alt
        if (!state.invisible && typeof alt === 'string' && alt.trim() !== '') kept.push({ type: 'text', value: alt })
        continue
      }
      kept.push(c)
      below.push([c, state.zero, state.invisible])
      continue
    }
    kept.push(c)
  }
  node.children = kept as typeof node.children
  for (const [c, z, i] of below) prune(c, z, i)
}

/** Removes every raw `html` node from the mdast, iteratively ([[AGT588]] D2). */
function dropHtml(root: Root): void {
  const stack: Array<{ children: unknown[] }> = [root]
  while (stack.length > 0) {
    const parent = stack.pop()!
    parent.children = parent.children.filter((c) => (c as { type: string }).type !== 'html')
    for (const c of parent.children)
      if (Array.isArray((c as { children?: unknown[] }).children)) stack.push(c as { children: unknown[] })
  }
}

type P5Parent = DefaultTreeAdapterMap['parentNode']
type P5Node = DefaultTreeAdapterMap['node']

/**
 * Flattens, in place and iteratively, every element deeper than `MAX_HTML_DEPTH`: the element goes, its children (text included) join the nearest kept
 * ancestor in document order. A `<template>`'s content counts as its children. No recursion proportional to the input's depth ([[CORE571]] D1).
 */
function boundDepth(document: P5Parent): void {
  const stack: Array<{ node: P5Node; parent: P5Parent; depth: number }> = []
  const open = (container: P5Parent, depth: number, kept: P5Parent): void => {
    const children = container.childNodes
    container.childNodes = []
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i]!, parent: kept, depth })
  }
  open(document, 1, document)
  while (stack.length > 0) {
    const { node, parent, depth } = stack.pop()!
    const element = 'tagName' in node
    if (element && depth > MAX_HTML_DEPTH) {
      // Dropped: its children go to the same kept parent, one level deeper.
      if ('content' in node) open(node.content, depth + 1, parent)
      open(node, depth + 1, parent)
      continue
    }
    ;(node as { parentNode: P5Parent | null }).parentNode = parent
    parent.childNodes.push(node as never)
    if (element) {
      if ('content' in node) open(node.content, depth + 1, node.content)
      open(node, depth + 1, node)
    }
  }
}

function htmlToMdast(html: string): PhrasingContent[] | Root['children'] {
  const document = parse(html, { sourceCodeLocationInfo: true, scriptingEnabled: false })
  boundDepth(document)
  const tree = fromParse5(document) as HastRoot
  prune(tree)
  const out = toMdast(tree) as Root
  dropHtml(out)
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
    children.push(
      ...((part.mimeType ?? '').toLowerCase() === 'text/html'
        ? (htmlToMdast(text) as Root['children'])
        : textToMdast(text)),
    )
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
  const instant =
    resource.internalDate !== undefined && /^\d+$/.test(resource.internalDate)
      ? Number(resource.internalDate)
      : dateHeader
        ? Date.parse(dateHeader)
        : Number.NaN
  if (Number.isNaN(instant)) return { skip: 'no_date' }
  const occurred = new Date(instant)

  const rawId = header(headers, 'Message-ID')?.trim() ?? ''
  const bare = rawId.startsWith('<') && rawId.endsWith('>') ? rawId.slice(1, -1).trim() : rawId
  const fallbackId = `gmail:${conn.id}:${resource.id}`
  const externalId = bare !== '' ? bare : fallbackId

  const replyTo = messageIdTokens(header(headers, 'In-Reply-To'))
  const refs = messageIdTokens(header(headers, 'References')).reverse()
  const hints = [...new Set([...replyTo, ...refs])].slice(0, MAX_HINTS)

  const participants: ChannelFacts['participants'] = []
  for (const [name, role] of [
    ['From', 'from'],
    ['To', 'to'],
    ['Cc', 'cc'],
    ['Bcc', 'bcc'],
  ] as Array<[string, ParticipantRole]>) {
    for (const a of parseAddressList(header(headers, name)))
      participants.push({ kind: 'email', value: a.value, ...(a.name === undefined ? {} : { name: a.name }), role })
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
        fetchMetadata: {
          message_id: resource.id,
          attachment_id: part.body!.attachmentId!,
          ...(size === undefined ? {} : { size: String(size) }),
        },
      },
      fact: {
        position,
        inline: /^\s*inline/i.test(disposition ?? '') || cid !== '',
        content_id: cid === '' ? null : cid,
      },
    }
  })

  const prefix = `gmail:${base64Url(conn.mailbox)}`
  const fullName = from?.name ?? from?.value.split('@')[0] ?? ''
  const message: VibaseMessage = {
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
      fallback_external_id: fallbackId,
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

// Markdown for message content ([[CORE69]] D25). Vendored from `chat@4.43.0` because that package's single root entry imports
// `crypto` and `async_hooks` at top level, which the Worker could not resolve before `nodejs_compat` ([[CORE243]] D2); vendoring also keeps chat's runtime out of the bundle. `chat` stays a
// type-only devDependency; the contract test (`message-shape.contract.test.ts`) compares these functions with chat's own.
import type { Nodes, Root } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkStringify from 'remark-stringify'
import { unified } from 'unified'

/** Same processor as `chat`'s `stringifyMarkdown(ast)` with default options. */
export function stringifyMarkdown(ast: Root): string {
  return unified().use(remarkStringify).use(remarkGfm).stringify(ast)
}

// `toPlainText` below is copied from chat@4.43.0 (`src/markdown.ts`: nodeValue, childPlainText, plainTextNode, toPlainText),
// distributed under the MIT License, Copyright (c) Vercel, Inc. It is deliberately not `mdast-util-to-string`, whose output
// differs (separators between blocks, table rows, breaks).
function nodeValue(node: Nodes): string | null {
  if ('value' in node && typeof node.value === 'string') {
    return node.value
  }
  if ('alt' in node && typeof node.alt === 'string') {
    return node.alt
  }
  return null
}

function childPlainText(node: Nodes, separator: string, keepEmpty = false): string {
  if (!('children' in node && Array.isArray(node.children))) {
    return ''
  }
  const texts = (node.children as Nodes[]).map((child) => plainTextNode(child))
  return (keepEmpty ? texts : texts.filter((text) => text.length > 0)).join(separator)
}

function plainTextNode(node: Nodes): string {
  const value = nodeValue(node)
  if (value !== null) {
    return value
  }
  switch (node.type) {
    case 'root':
      return childPlainText(node, '\n\n')
    case 'list':
      return childPlainText(node, '\n')
    case 'table': {
      const rows = node.children.map((child) => plainTextNode(child))
      return rows.filter((row) => row.trim().length > 0).join('\n')
    }
    case 'listItem':
    case 'blockquote':
      return childPlainText(node, '\n')
    case 'tableRow':
      return childPlainText(node, '\t', true)
    case 'break':
      return '\n'
    case 'thematicBreak':
      return ''
    case 'tableCell':
      return childPlainText(node, '')
    default:
      return childPlainText(node, '')
  }
}

export function toPlainText(ast: Root): string {
  return plainTextNode(ast)
}

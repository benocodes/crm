// Test-only ([[CORE69]] D25). `parseMarkdown` as `chat` has it, kept out of production code: only fixtures and tests parse markdown.
import type { Root } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

export function parseMarkdown(markdown: string): Root {
  return unified().use(remarkParse).use(remarkGfm).parse(markdown)
}

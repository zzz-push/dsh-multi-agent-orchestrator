/**
 * The small Markdown subset Agent replies actually use — paragraphs, headings,
 * fenced code, lists, quotes, tables, rules, `code` and **bold** — parsed into
 * plain data the window renders as React elements. Nothing is ever turned into
 * HTML, so a reply cannot inject markup; anything unrecognised stays text.
 */

export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: InlineNode[] }

export interface ListItem {
  /** Nesting depth from the item's indentation (0 = top level). */
  depth: number
  /** `•` for bullets, the source number plus `.` for ordered items. */
  marker: string
  children: InlineNode[]
}

export type MarkdownBlock =
  /** Each entry is one source line; the renderer keeps the line breaks. */
  | { type: 'paragraph'; lines: InlineNode[][] }
  | { type: 'heading'; level: 1 | 2 | 3; children: InlineNode[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'list'; ordered: boolean; items: ListItem[] }
  | { type: 'quote'; lines: InlineNode[][] }
  | { type: 'table'; header: InlineNode[][]; rows: InlineNode[][][] }
  | { type: 'rule' }

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/
// Replies are model output, so every pattern here has to stay linear on a
// long hostile line. One-regex forms of the heading and the table separator
// (`(.*?)(?:\s+#+)?\s*$`, `\s*\|?\s*…`) backtracked quadratically: a 40000
// character line froze the window for seconds, on every render. Their
// optional parts are handled in code instead (`headingText`, `isTableSeparator`).
const HEADING = /^ {0,3}(#{1,6})(\s+.*)$/
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const QUOTE = /^ {0,3}>\s?(.*)$/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_SEPARATOR_CELL = /^:?-+:?$/

function isBlank(line: string): boolean {
  return line.trim() === ''
}

/** Does this line open a block other than a paragraph? */
function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || LIST_ITEM.test(line) || QUOTE.test(line) || TABLE_ROW.test(line)
}

/** A heading's text: surrounding whitespace and a closing run of `#`s (after whitespace) removed. */
function headingText(rest: string): string {
  const text = rest.trimEnd()
  let end = text.length
  while (end > 0 && text[end - 1] === '#') end -= 1
  const closed = end < text.length && end > 0 && /\s/.test(text[end - 1]!)
  return (closed ? text.slice(0, end) : text).trim()
}

/** `|---|:--:|`: every cell dashes, optionally colon-aligned. */
function isTableSeparator(line: string): boolean {
  return splitTableRow(line).every((cell) => TABLE_SEPARATOR_CELL.test(cell))
}

function splitTableRow(line: string): string[] {
  const cells: string[] = []
  let current = ''
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!
    if (char === '\\' && body[index + 1] === '|') {
      current += '|'
      index += 1
    } else if (char === '|') {
      cells.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  cells.push(current.trim())
  return cells
}

/** `code` spans and **bold**; everything else is literal text. */
export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer !== '') nodes.push({ type: 'text', text: buffer })
    buffer = ''
  }
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '`') {
      let run = 1
      while (text[index + run] === '`') run += 1
      const fence = '`'.repeat(run)
      const close = text.indexOf(fence, index + run)
      if (close > index + run) {
        flush()
        nodes.push({ type: 'code', text: text.slice(index + run, close).replace(/^ (.*) $/, '$1') })
        index = close + run
        continue
      }
      buffer += fence
      index += run
      continue
    }
    if (char === '*' && text[index + 1] === '*') {
      const close = text.indexOf('**', index + 2)
      const inner = close === -1 ? '' : text.slice(index + 2, close)
      if (inner.trim() !== '' && inner === inner.trim()) {
        flush()
        nodes.push({ type: 'strong', children: parseInline(inner) })
        index = close + 2
        continue
      }
      buffer += '**'
      index += 2
      continue
    }
    buffer += char
    index += 1
  }
  flush()
  return nodes
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (isBlank(line)) {
      index += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence !== null) {
      const marker = fence[1]!
      const body: string[] = []
      index += 1
      // An unclosed fence runs to the end, as in CommonMark.
      while (index < lines.length && !lines[index]!.trimStart().startsWith(marker)) {
        body.push(lines[index]!)
        index += 1
      }
      index += 1
      blocks.push({ type: 'code', lang: fence[2] ?? '', text: body.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      const level = Math.min(3, heading[1]!.length) as 1 | 2 | 3
      blocks.push({ type: 'heading', level, children: parseInline(headingText(heading[2]!)) })
      index += 1
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'rule' })
      index += 1
      continue
    }

    if (TABLE_ROW.test(line) && index + 1 < lines.length && isTableSeparator(lines[index + 1]!)) {
      const header = splitTableRow(line).map(parseInline)
      const rows: InlineNode[][][] = []
      index += 2
      while (index < lines.length && TABLE_ROW.test(lines[index]!)) {
        rows.push(splitTableRow(lines[index]!).map(parseInline))
        index += 1
      }
      blocks.push({ type: 'table', header, rows })
      continue
    }

    if (QUOTE.test(line)) {
      const quoted: InlineNode[][] = []
      while (index < lines.length && QUOTE.test(lines[index]!)) {
        quoted.push(parseInline(QUOTE.exec(lines[index]!)![1]!))
        index += 1
      }
      blocks.push({ type: 'quote', lines: quoted })
      continue
    }

    const first = LIST_ITEM.exec(line)
    if (first !== null) {
      const ordered = /\d/.test(first[2]!)
      const baseIndent = first[1]!.length
      const items: ListItem[] = []
      while (index < lines.length) {
        const current = lines[index]!
        const item = LIST_ITEM.exec(current)
        if (item !== null) {
          const indent = Math.max(0, item[1]!.replace(/\t/g, '    ').length - baseIndent)
          const marker = /\d/.test(item[2]!) ? `${item[2]!.slice(0, -1)}.` : '•'
          items.push({ depth: Math.min(4, Math.floor(indent / 2)), marker, children: parseInline(item[3]!) })
          index += 1
          continue
        }
        if (isBlank(current)) {
          // A blank line inside a list only continues it when another item follows.
          let next = index + 1
          while (next < lines.length && isBlank(lines[next]!)) next += 1
          if (next < lines.length && LIST_ITEM.test(lines[next]!)) {
            index = next
            continue
          }
          break
        }
        // A wrapped line belongs to the item above it.
        if (/^\s+/.test(current) && items.length > 0 && !startsBlock(current.trimStart())) {
          const last = items[items.length - 1]!
          last.children = [...last.children, { type: 'text', text: ' ' }, ...parseInline(current.trim())]
          index += 1
          continue
        }
        break
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    const paragraph: InlineNode[][] = []
    while (index < lines.length && !isBlank(lines[index]!) && (paragraph.length === 0 || !startsBlock(lines[index]!))) {
      paragraph.push(parseInline(lines[index]!))
      index += 1
    }
    blocks.push({ type: 'paragraph', lines: paragraph })
  }
  return blocks
}

import { describe, expect, it } from 'vitest'

import { parseInline, parseMarkdown } from '../src/client/markdown.js'

const text = (value: string) => ({ type: 'text', text: value })

describe('Agent reply Markdown', () => {
  it('parses `code` and **bold**, leaving unmatched markers as text', () => {
    expect(parseInline('run `pnpm test` then **check `out`**')).toEqual([
      text('run '),
      { type: 'code', text: 'pnpm test' },
      text(' then '),
      { type: 'strong', children: [text('check '), { type: 'code', text: 'out' }] },
    ])
    expect(parseInline('a ``x ` y`` b')).toEqual([text('a '), { type: 'code', text: 'x ` y' }, text(' b')])
    expect(parseInline('2 ** 3 and `open')).toEqual([text('2 ** 3 and `open')])
    expect(parseInline('** spaced** **')).toEqual([text('** spaced** **')])
  })

  it('keeps line breaks inside a paragraph and splits paragraphs on blank lines', () => {
    expect(parseMarkdown('one\ntwo\n\nthree')).toEqual([
      { type: 'paragraph', lines: [[text('one')], [text('two')]] },
      { type: 'paragraph', lines: [[text('three')]] },
    ])
  })

  it('reads headings, rules and fenced code (an unclosed fence runs to the end)', () => {
    expect(parseMarkdown('## Plan ##\n---\n```ts\nconst a = 1\n\nconst b = 2\n```\nafter\n~~~\nopen')).toEqual([
      { type: 'heading', level: 2, children: [text('Plan')] },
      { type: 'rule' },
      { type: 'code', lang: 'ts', text: 'const a = 1\n\nconst b = 2' },
      { type: 'paragraph', lines: [[text('after')]] },
      { type: 'code', lang: '', text: 'open' },
    ])
    expect(parseMarkdown('##### deep')).toEqual([{ type: 'heading', level: 3, children: [text('deep')] }])
  })

  it('reads bullet and numbered lists with nesting, wrapped lines and loose items', () => {
    expect(parseMarkdown('- a\n  - b\n    wrapped\n\n- c\n\nafter')).toEqual([
      {
        type: 'list',
        ordered: false,
        items: [
          { depth: 0, marker: '•', children: [text('a')] },
          { depth: 1, marker: '•', children: [text('b'), text(' '), text('wrapped')] },
          { depth: 0, marker: '•', children: [text('c')] },
        ],
      },
      { type: 'paragraph', lines: [[text('after')]] },
    ])
    expect(parseMarkdown('3. x\n4) **y**')).toEqual([{
      type: 'list',
      ordered: true,
      items: [
        { depth: 0, marker: '3.', children: [text('x')] },
        { depth: 0, marker: '4.', children: [{ type: 'strong', children: [text('y')] }] },
      ],
    }])
  })

  it('ends a paragraph where a list or quote starts', () => {
    expect(parseMarkdown('intro\n- item\n> said\n> twice')).toEqual([
      { type: 'paragraph', lines: [[text('intro')]] },
      { type: 'list', ordered: false, items: [{ depth: 0, marker: '•', children: [text('item')] }] },
      { type: 'quote', lines: [[text('said')], [text('twice')]] },
    ])
  })

  it('reads a table only when it has a separator row, honouring escaped pipes', () => {
    expect(parseMarkdown('| a | b |\n|---|:-:|\n| `x\\|y` | 2 |\nnext')).toEqual([
      { type: 'table', header: [[text('a')], [text('b')]], rows: [[[{ type: 'code', text: 'x|y' }], [text('2')]]] },
      { type: 'paragraph', lines: [[text('next')]] },
    ])
    expect(parseMarkdown('| not a table |')).toEqual([{ type: 'paragraph', lines: [[text('| not a table |')]] }])
    expect(parseMarkdown('| a |\n| - - |').some((block) => block.type === 'table')).toBe(false)
    expect(parseMarkdown('| a | b |\n| :-- | --: |')[0]).toMatchObject({ type: 'table', rows: [] })
  })

  it('strips a closing run of #s only when whitespace precedes it', () => {
    const heading = (source: string) => (parseMarkdown(source)[0] as { children: unknown }).children
    expect(heading('# C#')).toEqual([text('C#')])
    expect(heading('#   spaced out   ##   ')).toEqual([text('spaced out')])
    expect(heading('### ###')).toEqual([])
    expect(parseMarkdown('#nospace')).toEqual([{ type: 'paragraph', lines: [[text('#nospace')]] }])
  })

  it('parses a long hostile line in linear time', () => {
    // Each of these took seconds with the earlier one-regex heading and table
    // separator patterns; the time grew with the square of the line length.
    const spaces = ' '.repeat(200_000)
    const started = performance.now()
    parseMarkdown(`# a${spaces}x`)
    parseMarkdown(`| a |\n${spaces}|${spaces}-${spaces}x`)
    parseMarkdown(`paragraph\n# a${spaces}x`)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

const DROP_ELEMENTS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
  'form',
  'nav',
  'footer',
  'header',
  'aside'
]

const BLOCK_ELEMENTS = new Set([
  'address',
  'article',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'main',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul'
])

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  divide: '÷',
  laquo: '«',
  raquo: '»',
  deg: '°'
}

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

function stripMarkup(html: string): string {
  let text = html
  for (const tag of DROP_ELEMENTS) {
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ')
    text = text.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), ' ')
  }
  text = text.replace(/<!--[\s\S]*?-->/g, ' ')
  // 块级标签换成换行,其余标签直接删除,避免把相邻单词粘在一起。
  text = text.replace(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi, (whole, tag: string) =>
    BLOCK_ELEMENTS.has(tag.toLowerCase()) ? '\n' : whole.includes(' ') ? ' ' : ''
  )
  return decodeEntities(text)
}

function tidy(text: string, options: { keepLines: boolean }): string {
  if (!options.keepLines) return text.replace(/\s+/g, ' ').trim()
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, ' ').trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1]?.length))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function extractTitle(html: string): string {
  const og = /<meta[^>]+property\s*=\s*["']og:title["'][^>]*>/i.exec(html)
  const ogContent = og ? /content\s*=\s*["']([^"']*)["']/i.exec(og[0])?.[1] : undefined
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  const chosen = (title ?? ogContent ?? '').trim()
  return tidy(stripMarkup(chosen), { keepLines: false })
}

export function htmlToText(html: string, maxChars = 40_000): string {
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html
  const primary = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(body)?.[1] ?? body
  const text = tidy(stripMarkup(primary), { keepLines: true })
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}\n\n[正文已截断]` : text
}

/** JSON/纯文本响应不做 HTML 清洗,但仍需要限制长度。 */
export function plainText(body: string, maxChars: number): string {
  const text = body.trim()
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[正文已截断]` : text
}

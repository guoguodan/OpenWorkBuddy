import { inflateRawSync } from 'node:zlib'

/**
 * Office 预览的结构化提取。
 *
 * 这里不追求像素级还原版式,目标是在应用内安全地看到文档内容:
 * - 只读取 OOXML 里的 XML 部件,不执行宏、不跟随外部关系;
 * - 自研最小 ZIP 解析,限制条目数/单条解压体积/总解压体积,拒绝加密与 ZIP64;
 * - XML 不处理 DTD/实体,文本统一转义后再拼 HTML。
 *
 * 复杂版式(浮动图片、艺术字、图表)会退化成文本/表格,这是刻意保留的边界。
 */

export const MAX_OFFICE_BYTES = 30 * 1024 * 1024
export const MAX_PDF_BYTES = 60 * 1024 * 1024

const MAX_ZIP_ENTRIES = 4000
const MAX_ENTRY_BYTES = 40 * 1024 * 1024
const MAX_TOTAL_BYTES = 120 * 1024 * 1024
const MAX_XML_BYTES = 24 * 1024 * 1024
const MAX_XML_NODES = 200_000
const MAX_XML_DEPTH = 128

export type OfficeKind = 'docx' | 'xlsx' | 'pptx'

export function officeKind(ext: string): OfficeKind | null {
  const lower = ext.toLowerCase()
  if (lower === '.docx') return 'docx'
  if (lower === '.xlsx') return 'xlsx'
  if (lower === '.pptx') return 'pptx'
  return null
}

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
  flags: number
}

function normalizeZipPath(raw: string): string {
  const name = raw.replace(/\\/g, '/')
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new Error(`压缩包包含绝对路径: ${raw}`)
  }
  const parts: string[] = []
  for (const part of name.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') throw new Error(`压缩包包含越界路径: ${raw}`)
    parts.push(part)
  }
  return parts.join('/')
}

function findEndOfCentralDirectory(buf: Buffer): number {
  const min = Math.max(0, buf.length - 65_557)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  throw new Error('不是有效的 OOXML 压缩包')
}

/** 只读取中央目录,按需解压单个部件。 */
export class ZipArchive {
  private readonly entries = new Map<string, ZipEntry>()
  private inflatedBytes = 0

  constructor(private readonly buf: Buffer) {
    const eocd = findEndOfCentralDirectory(buf)
    const totalEntries = buf.readUInt16LE(eocd + 10)
    const cdOffset = buf.readUInt32LE(eocd + 16)
    if (totalEntries === 0xffff || cdOffset === 0xffffffff) {
      throw new Error('暂不支持 ZIP64 格式的 Office 文档')
    }
    if (totalEntries > MAX_ZIP_ENTRIES) throw new Error('Office 文档包含过多部件')
    if (cdOffset >= buf.length) throw new Error('Office 压缩包目录损坏')

    let offset = cdOffset
    for (let index = 0; index < totalEntries; index++) {
      if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) {
        throw new Error('Office 压缩包目录损坏')
      }
      const flags = buf.readUInt16LE(offset + 8)
      const method = buf.readUInt16LE(offset + 10)
      const compressedSize = buf.readUInt32LE(offset + 20)
      const uncompressedSize = buf.readUInt32LE(offset + 24)
      const nameLength = buf.readUInt16LE(offset + 28)
      const extraLength = buf.readUInt16LE(offset + 30)
      const commentLength = buf.readUInt16LE(offset + 32)
      const localOffset = buf.readUInt32LE(offset + 42)
      const end = offset + 46 + nameLength + extraLength + commentLength
      if (end > buf.length) throw new Error('Office 压缩包目录损坏')
      const rawName = buf.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
      if (flags & 0x1) throw new Error('暂不支持加密的 Office 文档')
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
        throw new Error('暂不支持 ZIP64 格式的 Office 文档')
      }
      const name = normalizeZipPath(rawName)
      if (name) this.entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset, flags })
      offset = end
    }
  }

  names(): string[] {
    return [...this.entries.keys()]
  }

  has(name: string): boolean {
    return this.entries.has(normalizeZipPath(name))
  }

  read(name: string): Buffer {
    const key = normalizeZipPath(name)
    const entry = this.entries.get(key)
    if (!entry) throw new Error(`Office 文档缺少部件: ${key}`)
    if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`Office 部件过大: ${key}`)
    if (this.inflatedBytes + entry.uncompressedSize > MAX_TOTAL_BYTES) {
      throw new Error('Office 文档解压后体积超过限制')
    }
    if (entry.method !== 0 && entry.method !== 8) {
      throw new Error(`不支持的 Office 压缩方式: ${entry.method}`)
    }
    if (entry.localOffset + 30 > this.buf.length) throw new Error('Office 压缩包数据损坏')
    if (this.buf.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new Error('Office 压缩包数据损坏')
    const nameLength = this.buf.readUInt16LE(entry.localOffset + 26)
    const extraLength = this.buf.readUInt16LE(entry.localOffset + 28)
    const start = entry.localOffset + 30 + nameLength + extraLength
    const end = start + entry.compressedSize
    if (end > this.buf.length) throw new Error('Office 压缩包数据损坏')
    const raw = this.buf.subarray(start, end)
    let data: Buffer
    if (entry.method === 0) {
      data = Buffer.from(raw)
    } else {
      try {
        data = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES })
      } catch (err) {
        throw new Error(`Office 部件解压失败: ${(err as Error).message}`)
      }
    }
    if (data.length > MAX_ENTRY_BYTES) throw new Error(`Office 部件过大: ${key}`)
    this.inflatedBytes += data.length
    return data
  }

  readText(name: string): string {
    const data = this.read(name)
    if (data.length > MAX_XML_BYTES) throw new Error(`Office XML 部件过大: ${name}`)
    return data.toString('utf8')
  }
}

export interface XmlNode {
  name: string
  attrs: Record<string, string>
  rawAttrs: Record<string, string>
  children: XmlNode[]
  text: string
}

function localName(name: string): string {
  const index = name.indexOf(':')
  return index >= 0 ? name.slice(index + 1) : name
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, body: string) => {
    if (body === 'amp') return '&'
    if (body === 'lt') return '<'
    if (body === 'gt') return '>'
    if (body === 'quot') return '"'
    if (body === 'apos') return "'"
    const hex = body.startsWith('#x') || body.startsWith('#X')
    const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole
    try {
      return String.fromCodePoint(code)
    } catch {
      return whole
    }
  })
}

function parseAttributes(source: string): { attrs: Record<string, string>; rawAttrs: Record<string, string> } {
  const attrs: Record<string, string> = {}
  const rawAttrs: Record<string, string> = {}
  const pattern = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  for (const match of source.matchAll(pattern)) {
    const key = match[1]
    if (!key) continue
    const value = decodeEntities(match[2] ?? match[3] ?? '')
    rawAttrs[key] = value
    const local = localName(key)
    if (attrs[local] === undefined) attrs[local] = value
  }
  return { attrs, rawAttrs }
}

function findTagEnd(xml: string, from: number): number {
  let quote = ''
  for (let i = from; i < xml.length; i++) {
    const char = xml[i]
    if (quote) {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      return i
    }
  }
  throw new Error('Office XML 标签未闭合')
}

/** 最小 XML 解析器:只服务于 OOXML 的只读提取,不实现 DTD/实体/命名空间语义。 */
export function parseXml(xml: string): XmlNode {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Office 文档包含不支持的 XML 声明')
  const root: XmlNode = { name: '#root', attrs: {}, rawAttrs: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  let nodes = 0
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0

  const appendText = (raw: string) => {
    if (!raw) return
    const current = stack[stack.length - 1]!
    current.text += decodeEntities(raw)
  }

  while (i < xml.length) {
    const next = xml.indexOf('<', i)
    if (next < 0) {
      appendText(xml.slice(i))
      break
    }
    if (next > i) {
      const raw = xml.slice(i, next)
      // 缩进/换行不是内容;真正的空白只在 w:t/a:t 内部,由文本节点保留。
      if (raw.trim()) appendText(raw)
      i = next
      continue
    }
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4)
      if (end < 0) throw new Error('Office XML 注释未闭合')
      i = end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i + 9)
      if (end < 0) throw new Error('Office XML CDATA 未闭合')
      appendText(xml.slice(i + 9, end))
      i = end + 3
      continue
    }
    if (xml.startsWith('<?', i)) {
      const end = xml.indexOf('?>', i + 2)
      if (end < 0) throw new Error('Office XML 处理指令未闭合')
      i = end + 2
      continue
    }
    const end = findTagEnd(xml, i + 1)
    const raw = xml.slice(i + 1, end).trim()
    i = end + 1
    if (!raw || raw.startsWith('!')) continue
    if (raw.startsWith('/')) {
      const closing = localName(raw.slice(1).trim())
      if (stack.length <= 1) throw new Error('Office XML 标签不匹配')
      const current = stack.pop()!
      if (current.name !== closing) throw new Error('Office XML 标签不匹配')
      continue
    }
    const selfClosing = raw.endsWith('/')
    const body = selfClosing ? raw.slice(0, -1).trimEnd() : raw
    const nameMatch = /^([A-Za-z_][\w:.-]*)/.exec(body)
    if (!nameMatch?.[1]) continue
    const attrs = parseAttributes(body.slice(nameMatch[1].length))
    const node: XmlNode = { name: localName(nameMatch[1]), attrs: attrs.attrs, rawAttrs: attrs.rawAttrs, children: [], text: '' }
    nodes += 1
    if (nodes > MAX_XML_NODES) throw new Error('Office XML 节点过多')
    if (stack.length > MAX_XML_DEPTH) throw new Error('Office XML 嵌套过深')
    stack[stack.length - 1]!.children.push(node)
    if (!selfClosing) stack.push(node)
  }
  if (stack.length !== 1) throw new Error('Office XML 标签未闭合')
  return root
}

function getAttr(node: XmlNode, name: string): string | undefined {
  return node.rawAttrs[name] ?? node.attrs[name] ?? node.attrs[localName(name)]
}

function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((item) => item.name === name)
}

function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((item) => item.name === name)
}

function descendants(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const item of node.children) {
    if (item.name === name) out.push(item)
    descendants(item, name, out)
  }
  return out
}

function textOf(node: XmlNode, skip: Set<string> = new Set()): string {
  if (skip.has(node.name)) return ''
  let out = node.text
  for (const item of node.children) {
    if (item.name === 'tab') out += '\t'
    else if (item.name === 'br' || item.name === 'cr') out += '\n'
    else out += textOf(item, skip)
  }
  return out
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderRun(run: XmlNode): string {
  const props = child(run, 'rPr')
  let html = ''
  for (const item of run.children) {
    if (item.name === 't') html += escapeHtml(item.text)
    else if (item.name === 'tab') html += '&nbsp;&nbsp;&nbsp;&nbsp;'
    else if (item.name === 'br' || item.name === 'cr') html += '<br />'
  }
  if (!html) return ''
  if (props && child(props, 'b')) html = `<strong>${html}</strong>`
  if (props && child(props, 'i')) html = `<em>${html}</em>`
  if (props && child(props, 'u')) html = `<u>${html}</u>`
  if (props && (child(props, 'strike') || child(props, 'dstrike'))) html = `<s>${html}</s>`
  const align = props ? child(props, 'vertAlign') : undefined
  if (align && getAttr(align, 'val') === 'superscript') html = `<sup>${html}</sup>`
  return html
}

function renderDocxParagraph(node: XmlNode): string {
  const props = child(node, 'pPr')
  const style = props ? child(props, 'pStyle') : undefined
  const styleName = style ? (getAttr(style, 'val') ?? '') : ''
  const headingMatch = /(?:heading|标题)\s*([1-6])/i.exec(styleName)
  const heading = headingMatch ? `h${headingMatch[1]}` : styleName.toLowerCase() === 'title' ? 'h1' : null
  const isList = Boolean(props && child(props, 'numPr'))
  const justify = props ? child(props, 'jc') : undefined
  const align = justify ? (getAttr(justify, 'val') ?? '') : ''
  const styleAttr = align === 'center' ? ' style="text-align:center"'
    : align === 'right' ? ' style="text-align:right"'
      : align === 'both' ? ' style="text-align:justify"' : ''

  let html = ''
  for (const item of node.children) {
    if (item.name === 'r') html += renderRun(item)
    else if (item.name === 'hyperlink' || item.name === 'ins' || item.name === 'smartTag') {
      for (const run of descendants(item, 'r')) html += renderRun(run)
    } else if (item.name === 'fldSimple') {
      html += escapeHtml(textOf(item))
    }
  }
  const prefix = isList ? '<span class="office-bullet">• </span>' : ''
  const cls = isList ? ' class="office-li"' : ''
  if (heading) return `<${heading}${styleAttr}>${prefix}${html || '&nbsp;'}</${heading}>`
  return `<p${cls}${styleAttr}>${prefix}${html || '&nbsp;'}</p>`
}

function renderDocxTable(node: XmlNode): string {
  const rows = children(node, 'tr')
  const body: string[] = []
  rows.forEach((row, rowIndex) => {
    const cells = children(row, 'tc')
    const rendered: string[] = []
    for (const cell of cells) {
      const props = child(cell, 'tcPr')
      const span = props ? child(props, 'gridSpan') : undefined
      const width = span ? Number(getAttr(span, 'val')) : 1
      const colspan = Number.isFinite(width) && width > 1 ? ` colspan="${Math.min(20, width)}"` : ''
      const content = renderDocxBlocks(cell)
      const header = rowIndex === 0 || Boolean(props && child(props, 'tblHeader'))
      const tag = header ? 'th' : 'td'
      rendered.push(`<${tag}${colspan}>${content || '&nbsp;'}</${tag}>`)
    }
    body.push(`<tr>${rendered.join('')}</tr>`)
  })
  return `<table>${body.join('')}</table>`
}

function renderDocxBlocks(node: XmlNode): string {
  const out: string[] = []
  for (const item of node.children) {
    if (item.name === 'p') out.push(renderDocxParagraph(item))
    else if (item.name === 'tbl') out.push(renderDocxTable(item))
    else if (item.name === 'sdt') {
      const content = child(item, 'sdtContent')
      if (content) out.push(renderDocxBlocks(content))
    } else if (item.name === 'ins' || item.name === 'customXml' || item.name === 'smartTag') {
      out.push(renderDocxBlocks(item))
    }
  }
  return out.join('\n')
}

function renderDocx(zip: ZipArchive): string {
  const document = parseXml(zip.readText('word/document.xml'))
  const body = descendants(document, 'body')[0] ?? document
  return `<div class="office">${renderDocxBlocks(body) || '<p>(文档没有正文)</p>'}</div>`
}

function resolveZipTarget(baseDir: string, target: string): string {
  const raw = target.replace(/\\/g, '/')
  const combined = raw.startsWith('/') ? raw.slice(1) : `${baseDir}/${raw}`
  return normalizeZipPath(combined)
}

function relationshipMap(xml: string | null): Map<string, string> {
  const map = new Map<string, string>()
  if (!xml) return map
  const root = parseXml(xml)
  for (const rel of descendants(root, 'Relationship')) {
    const id = getAttr(rel, 'Id')
    const target = getAttr(rel, 'Target')
    if (id && target) map.set(id, target)
  }
  return map
}

function readSharedStrings(zip: ZipArchive): string[] {
  if (!zip.has('xl/sharedStrings.xml')) return []
  const root = parseXml(zip.readText('xl/sharedStrings.xml'))
  return descendants(root, 'si').map((item) => textOf(item, new Set(['rPh', 'phoneticPr'])))
}

function columnIndex(ref: string): number {
  const match = /^([A-Z]+)/i.exec(ref)
  if (!match?.[1]) return 0
  let value = 0
  for (const char of match[1].toUpperCase()) value = value * 26 + (char.charCodeAt(0) - 64)
  return Math.max(0, value - 1)
}

function cellValue(cell: XmlNode, shared: string[]): string {
  const type = getAttr(cell, 't') ?? ''
  if (type === 'inlineStr') {
    const inline = child(cell, 'is')
    return inline ? textOf(inline) : ''
  }
  const value = child(cell, 'v')
  const raw = value ? textOf(value) : ''
  if (type === 's') {
    const index = Number(raw)
    return Number.isInteger(index) ? (shared[index] ?? '') : ''
  }
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE'
  if (type === 'e') return raw ? `#${raw}` : '#错误'
  if (!raw) {
    const formula = child(cell, 'f')
    return formula ? `=${textOf(formula)}` : ''
  }
  return raw
}

function renderXlsxSheet(sheet: XmlNode, shared: string[], name: string): string {
  const sheetData = descendants(sheet, 'sheetData')[0]
  const rows = sheetData ? children(sheetData, 'row') : []
  const cells = new Map<string, string>()
  let maxRow = 0
  let maxCol = 0
  for (const [rowIndex, row] of rows.entries()) {
    for (const cell of children(row, 'c')) {
      const ref = getAttr(cell, 'r') ?? ''
      const rowNumber = Number(/\d+/.exec(ref)?.[0] ?? rowIndex + 1) - 1
      const colNumber = columnIndex(ref || `${String.fromCharCode(65 + maxCol)}1`)
      maxRow = Math.max(maxRow, rowNumber + 1)
      maxCol = Math.max(maxCol, colNumber + 1)
      cells.set(`${rowNumber}:${colNumber}`, cellValue(cell, shared))
    }
  }
  const rowLimit = Math.min(Math.max(maxRow, 1), 200)
  const colLimit = Math.min(Math.max(maxCol, 1), 40)
  const truncated = maxRow > rowLimit || maxCol > colLimit
  const body: string[] = []
  for (let row = 0; row < rowLimit; row++) {
    const tag = row === 0 ? 'th' : 'td'
    const cols: string[] = []
    for (let col = 0; col < colLimit; col++) {
      cols.push(`<${tag}>${escapeHtml(cells.get(`${row}:${col}`) ?? '')}</${tag}>`)
    }
    body.push(`<tr>${cols.join('')}</tr>`)
  }
  const table = maxRow === 0 ? '<p class="office-note">(空工作表)</p>' : `<table>${body.join('')}</table>`
  const note = truncated
    ? `<p class="office-note">仅展示前 ${rowLimit} 行 / ${colLimit} 列,完整内容请用系统程序打开。</p>`
    : ''
  return `<section class="office-sheet"><h2>${escapeHtml(name || '工作表')}</h2>${table}${note}</section>`
}

function renderXlsx(zip: ZipArchive): string {
  const workbook = parseXml(zip.readText('xl/workbook.xml'))
  const rels = zip.has('xl/_rels/workbook.xml.rels')
    ? relationshipMap(zip.readText('xl/_rels/workbook.xml.rels'))
    : new Map<string, string>()
  const shared = readSharedStrings(zip)
  const sections: string[] = []
  for (const sheet of descendants(workbook, 'sheet')) {
    const name = getAttr(sheet, 'name') ?? '工作表'
    const relId = getAttr(sheet, 'r:id') ?? getAttr(sheet, 'id')
    if (!relId) continue
    const target = rels.get(relId)
    if (!target) continue
    const path = resolveZipTarget('xl', target)
    if (!zip.has(path)) continue
    sections.push(renderXlsxSheet(parseXml(zip.readText(path)), shared, name))
  }
  return `<div class="office">${sections.join('\n') || '<p>(工作簿没有可预览的工作表)</p>'}</div>`
}

function renderPptParagraph(node: XmlNode): string {
  let html = ''
  for (const item of node.children) {
    if (item.name === 'r' || item.name === 'fld') {
      const text = child(item, 't')
      if (!text) continue
      const props = child(item, 'rPr')
      let run = escapeHtml(text.text)
      if (props && (getAttr(props, 'b') === '1' || getAttr(props, 'b') === 'true')) run = `<strong>${run}</strong>`
      if (props && (getAttr(props, 'i') === '1' || getAttr(props, 'i') === 'true')) run = `<em>${run}</em>`
      html += run
    } else if (item.name === 'br') {
      html += '<br />'
    }
  }
  const props = child(node, 'pPr')
  const bullet = props && (child(props, 'buChar') || child(props, 'buAutoNum'))
  return `<p class="${bullet ? 'office-li' : ''}">${bullet ? '<span class="office-bullet">• </span>' : ''}${html || '&nbsp;'}</p>`
}

function renderPptTable(node: XmlNode): string {
  const rows = descendants(node, 'tr')
  const body: string[] = []
  for (const row of rows) {
    const cells = children(row, 'tc')
    const rendered: string[] = []
    for (const cell of cells) {
      const paragraphs = descendants(cell, 'p').map(renderPptParagraph).join('')
      rendered.push(`<td>${paragraphs || '&nbsp;'}</td>`)
    }
    body.push(`<tr>${rendered.join('')}</tr>`)
  }
  return `<table>${body.join('')}</table>`
}

function renderPptShape(node: XmlNode): string {
  const out: string[] = []
  for (const item of node.children) {
    if (item.name === 'txBody') {
      out.push(...children(item, 'p').map(renderPptParagraph))
    } else if (item.name === 'tbl') {
      out.push(renderPptTable(item))
    } else if (item.name === 'graphicFrame' || item.name === 'grpSp') {
      for (const table of descendants(item, 'tbl')) out.push(renderPptTable(table))
      if (item.name === 'grpSp') {
        for (const shape of item.children) {
          if (shape.name === 'sp' || shape.name === 'graphicFrame') out.push(renderPptShape(shape))
        }
      }
    }
  }
  return out.join('')
}

function renderPptSlide(slide: XmlNode, index: number): string {
  const tree = descendants(slide, 'spTree')[0]
  const content: string[] = []
  if (tree) {
    for (const shape of tree.children) {
      if (shape.name === 'sp' || shape.name === 'graphicFrame' || shape.name === 'grpSp') {
        content.push(renderPptShape(shape))
      }
    }
  }
  return `<section class="office-slide"><h3>第 ${index} 页</h3>${content.join('') || '<p class="office-note">(空白页)</p>'}</section>`
}

function renderPptx(zip: ZipArchive): string {
  const presentation = parseXml(zip.readText('ppt/presentation.xml'))
  const rels = zip.has('ppt/_rels/presentation.xml.rels')
    ? relationshipMap(zip.readText('ppt/_rels/presentation.xml.rels'))
    : new Map<string, string>()
  const slides: string[] = []
  for (const ref of descendants(presentation, 'sldId')) {
    const relId = getAttr(ref, 'r:id')
    if (!relId) continue
    const target = rels.get(relId)
    if (!target) continue
    const path = resolveZipTarget('ppt', target)
    if (!zip.has(path)) continue
    slides.push(renderPptSlide(parseXml(zip.readText(path)), slides.length + 1))
    if (slides.length >= 100) break
  }
  return `<div class="office">${slides.join('\n') || '<p>(演示文稿没有可预览的幻灯片)</p>'}</div>`
}

export function renderOfficeDocument(buffer: Buffer, ext: string): string {
  if (buffer.length > MAX_OFFICE_BYTES) throw new Error('Office 文档超过 30MB,请用系统程序打开')
  const kind = officeKind(ext)
  if (!kind) throw new Error(`不是支持的 Office 格式: ${ext}`)
  const zip = new ZipArchive(buffer)
  if (kind === 'docx') return renderDocx(zip)
  if (kind === 'xlsx') return renderXlsx(zip)
  return renderPptx(zip)
}

export function officeErrorDocument(message: string): string {
  return `<div class="office"><div class="office-error"><strong>无法解析此文档</strong><p>${escapeHtml(message)}</p><p class="office-note">可以改用“用系统程序打开”查看原文。</p></div></div>`
}

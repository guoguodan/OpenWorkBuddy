import { createHash } from 'node:crypto'
import { open, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

/** 不可信 HTML 预览的 CSP:禁脚本、禁网、只允许内联样式与 data/blob 图片 */
export const PREVIEW_CSP = [
  "default-src 'none'",
  "img-src data: blob:",
  "style-src 'unsafe-inline'",
  "script-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

export interface PreviewTarget {
  kind: 'file' | 'html' | 'url' | 'image'
  path?: string
  url?: string
  title?: string
}

export interface ResolvedPreview {
  mode: 'system' | 'html-window' | 'browser' | 'image-window'
  csp?: string
  absolutePath?: string
  url?: string
  size?: number
  sha256?: string
}

/**
 * 把"预览"拆成纯决策 + 执行两步:
 * 决策不碰 Electron,可在 Node 测试里直接断言;
 * 执行只做已经通过校验的动作。
 */
export async function resolvePreview(
  workspaceRoot: string,
  target: PreviewTarget,
  options: { confirmedUrl?: boolean } = {}
): Promise<ResolvedPreview> {
  if (target.kind === 'url') {
    if (!target.url) throw new Error('缺少 url')
    const parsed = new URL(target.url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`只允许 http/https 外链,拒绝: ${parsed.protocol}`)
    }
    if (!options.confirmedUrl) throw new Error('URL_NEEDS_CONFIRM:打开外部链接需要二次确认')
    return { mode: 'browser', url: parsed.toString() }
  }

  if (!target.path) throw new Error('缺少 path')
  const workspace = path.resolve(workspaceRoot)
  const abs = path.resolve(workspace, target.path)
  if (abs !== workspace && !abs.startsWith(workspace + path.sep)) {
    throw new Error(`路径越界: ${target.path}`)
  }
  const info = await stat(abs)
  if (!info.isFile()) throw new Error(`不是文件: ${target.path}`)

  if (target.kind === 'image' && info.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片超过 20MB(${info.size} 字节),不允许在应用内渲染`)
  }
  const buf = await readFile(abs)
  const sha256 = createHash('sha256').update(buf).digest('hex')

  if (target.kind === 'html') {
    return { mode: 'html-window', csp: PREVIEW_CSP, absolutePath: abs, size: info.size, sha256 }
  }
  if (target.kind === 'image') {
    return { mode: 'image-window', absolutePath: abs, size: info.size, sha256 }
  }
  return { mode: 'system', absolutePath: abs, size: info.size, sha256 }
}

/** 应用内文本预览上限:超过后只提示外部打开,避免把百 MB 文件读进渲染进程。 */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024

const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.log', '.json', '.jsonl', '.yaml', '.yml',
  '.csv', '.tsv', '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.cjs',
  '.ts', '.tsx', '.jsx', '.py', '.java', '.go', '.rs', '.c', '.h', '.cpp',
  '.sh', '.ps1', '.bat', '.ini', '.toml', '.sql'
])

export interface TextPreview {
  path: string
  text: string
  size: number
  truncated: boolean
  format: 'markdown' | 'code' | 'text' | 'html'
}

function textFormat(ext: string): TextPreview['format'] {
  if (ext === '.md' || ext === '.markdown') return 'markdown'
  if (ext === '.html' || ext === '.htm') return 'html'
  if (
    ['.json', '.jsonl', '.yaml', '.yml', '.csv', '.tsv', '.xml', '.css', '.js', '.mjs', '.cjs',
      '.ts', '.tsx', '.jsx', '.py', '.java', '.go', '.rs', '.c', '.h', '.cpp', '.sh', '.ps1',
      '.bat', '.ini', '.toml', '.sql'].includes(ext)
  ) {
    return 'code'
  }
  return 'text'
}

/**
 * 应用内只读预览:与预览策略共用同一套工作区解析,不允许越界。
 *
 * 只返回文本;图片走图片预览,二进制文件返回 null 让调用方回退到系统打开。
 * 截断而不是拒绝,是因为超大日志仍然有"看一眼开头"的合理需求。
 */
export async function readTextPreview(
  workspaceRoot: string,
  target: { path?: string }
): Promise<TextPreview | null> {
  if (!target.path) throw new Error('缺少 path')
  const workspace = path.resolve(workspaceRoot)
  const abs = path.resolve(workspace, target.path)
  if (abs !== workspace && !abs.startsWith(workspace + path.sep)) {
    throw new Error(`路径越界: ${target.path}`)
  }
  const info = await stat(abs)
  if (!info.isFile()) throw new Error(`不是文件: ${target.path}`)
  const ext = path.extname(abs).toLowerCase()
  if (!TEXT_EXTENSIONS.has(ext)) return null

  // 只读取上限以内的字节。先 readFile 再截断会把整份大日志读进内存,
  // 主进程需要预览多个文件时很容易被拖垮。
  const handle = await open(abs, 'r')
  try {
    const buffer = Buffer.allocUnsafe(Math.min(info.size, MAX_TEXT_BYTES))
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const bytes = buffer.subarray(0, offset)
    return {
      path: target.path,
      // 截断可能切在多字节字符中间;去掉不完整的尾序列,避免展示乱码。
      text: bytes.subarray(0, completeUtf8PrefixLength(bytes)).toString('utf8'),
      size: info.size,
      truncated: info.size > offset,
      format: textFormat(ext)
    }
  } finally {
    await handle.close()
  }
}

/** 返回可安全按 UTF-8 解码的前缀长度(只处理末尾不完整序列)。 */
function completeUtf8PrefixLength(buffer: Buffer): number {
  const end = buffer.length
  if (end === 0) return 0
  let lead = end - 1
  let continuation = 0
  while (lead >= 0 && continuation < 3 && (buffer[lead]! & 0xc0) === 0x80) {
    lead--
    continuation++
  }
  if (lead < 0) return end
  const first = buffer[lead]!
  const expected =
    (first & 0x80) === 0 ? 1 :
    (first & 0xe0) === 0xc0 ? 2 :
    (first & 0xf0) === 0xe0 ? 3 :
    (first & 0xf8) === 0xf0 ? 4 : 0
  // 非法起始字节交给解码器替换,不擅自吞掉内容。
  if (expected === 0) return end
  return end - lead < expected ? lead : end
}
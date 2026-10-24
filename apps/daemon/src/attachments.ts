import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveInsideWorkspace } from './tools/builtin.js'

export interface RunAttachment {
  path: string
  name: string
  size?: number
  kind?: 'file' | 'image'
}

export interface TurnImage {
  name: string
  mimeType: string
  data: Uint8Array
}

export interface LoadedAttachments {
  system: string
  images: TurnImage[]
  injected: number
  bytes: number
  rejected: Array<{ name: string; reason: string }>
}

export const MAX_RUN_ATTACHMENTS = 50
export const MAX_ATTACHMENT_FILE_BYTES = 20 * 1024 * 1024
const MAX_TEXT_PER_FILE = 64 * 1024
const MAX_TEXT_TOTAL = 256 * 1024
const MAX_IMAGE_TOTAL = 30 * 1024 * 1024
const STORAGE_PREFIX = '.openwb/attachments/'

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}

const IMAGE_EXTENSIONS = new Set(Object.keys(IMAGE_MIME))
const BINARY_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'zip',
  'bmp'
])
const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'json',
  'jsonl',
  'xml',
  'yaml',
  'yml',
  'csv',
  'tsv',
  'log',
  'js',
  'ts',
  'jsx',
  'tsx',
  'py',
  'go',
  'java',
  'cpp',
  'c',
  'h',
  'css',
  'scss',
  'html',
  'svg'
])

function extOf(name: string): string {
  return path.extname(name).slice(1).toLowerCase()
}

function safeRelative(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** 只接受附件目录下的普通相对路径;daemon 不信任渲染进程传来的字符串。 */
export function isAttachmentStoragePath(value: string): boolean {
  const rel = safeRelative(value)
  if (!rel.startsWith(STORAGE_PREFIX)) return false
  if (rel.includes('\0') || rel.includes('..')) return false
  if (path.isAbsolute(value)) return false
  return rel.length > STORAGE_PREFIX.length
}

/**
 * 把帧里的附件元数据收敛成安全列表。
 * 结构不完整的项直接丢弃,不把未知对象写进消息历史。
 */
export function normalizeRunAttachments(raw: unknown): RunAttachment[] {
  if (!Array.isArray(raw)) return []
  const out: RunAttachment[] = []
  const seen = new Set<string>()
  for (const item of raw.slice(0, MAX_RUN_ATTACHMENTS)) {
    if (!item || typeof item !== 'object') continue
    const rel = (item as { path?: unknown }).path
    const name = (item as { name?: unknown }).name
    const size = (item as { size?: unknown }).size
    const kind = (item as { kind?: unknown }).kind
    if (typeof rel !== 'string' || !isAttachmentStoragePath(rel)) continue
    if (typeof name !== 'string' || !name.trim()) continue
    const normalized = safeRelative(rel)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push({
      path: normalized,
      name: path.basename(name.replace(/\\/g, '/')).slice(0, 200) || 'attachment',
      ...(typeof size === 'number' && Number.isFinite(size) && size >= 0 ? { size } : {}),
      kind: kind === 'image' || IMAGE_EXTENSIONS.has(extOf(name)) ? 'image' : 'file'
    })
  }
  return out
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function isTextCandidate(name: string, buf: Buffer): boolean {
  const ext = extOf(name)
  if (BINARY_EXTENSIONS.has(ext) || (IMAGE_EXTENSIONS.has(ext) && ext !== 'svg')) return false
  if (TEXT_EXTENSIONS.has(ext)) return true
  // 未知类型按内容判断:出现 NUL 字节就当作二进制,避免把图片/压缩包变成乱码。
  return !buf.subarray(0, 4096).includes(0)
}

function describeKind(name: string): string {
  const ext = extOf(name)
  if (IMAGE_EXTENSIONS.has(ext)) return '图片'
  if (['pdf'].includes(ext)) return 'PDF 文档'
  if (['doc', 'docx'].includes(ext)) return 'Word 文档'
  if (['xls', 'xlsx'].includes(ext)) return 'Excel 表格'
  if (['ppt', 'pptx'].includes(ext)) return '演示文稿'
  if (['zip'].includes(ext)) return '压缩包'
  return '文本文件'
}

/**
 * 读取本轮附件并生成两部分上下文:
 *   - 文本/代码:按预算注入 system,保持现有 @ 文件体验;
 *   - 图片:返回二进制,由调用方作为当前轮 ImagePart 发送;
 *   - PDF/Office 等二进制:只列清单与路径,绝不把字节当 UTF-8 注入。
 */
export async function loadRunAttachments(
  root: string,
  attachments: RunAttachment[]
): Promise<LoadedAttachments> {
  const accepted = attachments.slice(0, MAX_RUN_ATTACHMENTS)
  const manifest: string[] = []
  const chunks: string[] = []
  const images: TurnImage[] = []
  const rejected: Array<{ name: string; reason: string }> = []
  let textBytes = 0
  let imageBytes = 0
  let injected = 0

  for (const item of accepted) {
    if (!isAttachmentStoragePath(item.path)) {
      rejected.push({ name: item.name, reason: '附件路径不在附件目录内' })
      continue
    }
    try {
      const abs = await resolveInsideWorkspace(root, item.path)
      const info = await lstat(abs)
      if (info.isSymbolicLink()) {
        rejected.push({ name: item.name, reason: '不支持符号链接' })
        continue
      }
      if (!info.isFile()) {
        rejected.push({ name: item.name, reason: '附件已不是普通文件' })
        continue
      }
      if (info.size <= 0) {
        rejected.push({ name: item.name, reason: '附件为空' })
        continue
      }
      if (info.size > MAX_ATTACHMENT_FILE_BYTES) {
        rejected.push({ name: item.name, reason: '附件超过 20MB' })
        continue
      }

      const ext = extOf(item.name)
      if (item.kind === 'image' && IMAGE_MIME[ext]) {
        if (imageBytes + info.size > MAX_IMAGE_TOTAL) {
          rejected.push({ name: item.name, reason: '本轮图片总大小超过 30MB' })
          continue
        }
        const data = await readFile(abs)
        images.push({ name: item.name, mimeType: IMAGE_MIME[ext]!, data: new Uint8Array(data) })
        imageBytes += data.byteLength
        manifest.push(
          `- ${item.name}（${describeKind(item.name)}，${formatSize(info.size)}）：\`${item.path}\`，已作为图片输入发送。`
        )
        injected++
        continue
      }

      const buf = await readFile(abs)
      if (!isTextCandidate(item.name, buf)) {
        manifest.push(
          `- ${item.name}（${describeKind(item.name)}，${formatSize(info.size)}）：\`${item.path}\`。二进制内容未注入正文；需要时请用工作区工具读取，无法解析时如实告诉用户。`
        )
        injected++
        continue
      }

      const budget = Math.max(0, MAX_TEXT_TOTAL - textBytes)
      const limit = Math.min(MAX_TEXT_PER_FILE, budget, buf.length)
      const body = buf.subarray(0, limit).toString('utf8')
      const used = Buffer.byteLength(body, 'utf8')
      textBytes += used
      if (budget <= 0) {
        manifest.push(
          `- ${item.name}（${formatSize(info.size)}）：\`${item.path}\`。本轮文本预算已用完，请用工作区工具按需读取。`
        )
        injected++
        continue
      }
      chunks.push(
        `### ${item.name}（\`${item.path}\`）${
          buf.length > limit ? `（已截断，原文件 ${buf.length} 字节）` : ''
        }\n\`\`\`\n${body}\n\`\`\``
      )
      injected++
    } catch (err) {
      rejected.push({ name: item.name, reason: (err as Error).message })
    }
  }

  if (manifest.length === 0 && chunks.length === 0 && images.length === 0) {
    return { system: '', images, injected, bytes: textBytes + imageBytes, rejected }
  }

  const sections = [
    '',
    '# 用户添加的附件',
    '这些文件由用户通过输入框添加，已保存到工作区；回答时优先参考。',
    ...manifest,
    chunks.length > 0 ? `## 附件正文\n${chunks.join('\n\n')}` : '',
    rejected.length > 0
      ? `## 未能读取的附件\n${rejected.map((item) => `- ${item.name}：${item.reason}`).join('\n')}`
      : ''
  ].filter(Boolean)

  return {
    system: sections.join('\n'),
    images,
    injected,
    bytes: textBytes + imageBytes,
    rejected
  }
}

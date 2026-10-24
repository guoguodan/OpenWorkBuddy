import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface ImportedAttachment {
  path: string
  name: string
  size: number
  kind: 'file' | 'image'
}

export interface RejectedAttachment {
  name: string
  reason: string
}

export interface ImportAttachmentResult {
  attachments: ImportedAttachment[]
  rejected: RejectedAttachment[]
}

export interface AttachmentImportData {
  name: string
  data: Uint8Array | ArrayBuffer
}

export interface AttachmentImportOptions {
  maxFiles?: number
  maxFileBytes?: number
  maxTotalBytes?: number
}

export const MAX_ATTACHMENTS = 50
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_ATTACHMENT_TOTAL_BYTES = 100 * 1024 * 1024

const ATTACHMENT_DIR = path.join('.openwb', 'attachments')
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])
const ALLOWED_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  'pdf',
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
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'bmp',
  'svg',
  'zip',
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
  'html'
])

export const ATTACHMENT_ACCEPT = Array.from(ALLOWED_EXTENSIONS)
  .map((ext) => `.${ext}`)
  .join(',')

function extensionOf(name: string): string {
  return path.extname(name).slice(1).toLowerCase()
}

/** 只保留一个安全的文件名;哈希前缀保证同名不同内容不会互相覆盖。 */
function safeFileName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'))
  const withoutControl = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  const fallback = withoutControl || 'attachment'
  if (fallback.length <= 140) return fallback
  const ext = path.extname(fallback)
  return `${fallback.slice(0, Math.max(1, 140 - ext.length))}${ext}`
}

/** 展示名与落盘名保持一致:跨平台非法字符不能在 chip 里原样回显。 */
function displayName(name: string): string {
  return safeFileName(path.basename(name.replace(/\\/g, '/')))
}

function hashBytes(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 16)
}

function inside(root: string, target: string): boolean {
  const workspace = path.resolve(root)
  const abs = path.resolve(target)
  return abs === workspace || abs.startsWith(workspace + path.sep)
}

function validateMeta(name: string, size: number, options: Required<AttachmentImportOptions>): string | null {
  const ext = extensionOf(name)
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return ext ? `不支持的文件类型: .${ext}` : '无法识别文件类型'
  }
  if (size <= 0) return '文件为空'
  if (size > options.maxFileBytes) {
    return `文件超过 ${Math.floor(options.maxFileBytes / 1024 / 1024)}MB`
  }
  return null
}

function normalizeOptions(options: AttachmentImportOptions): Required<AttachmentImportOptions> {
  return {
    maxFiles: Math.max(1, Math.min(options.maxFiles ?? MAX_ATTACHMENTS, MAX_ATTACHMENTS)),
    maxFileBytes: Math.max(1, Math.min(options.maxFileBytes ?? MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES)),
    maxTotalBytes: Math.max(
      1,
      Math.min(options.maxTotalBytes ?? MAX_ATTACHMENT_TOTAL_BYTES, MAX_ATTACHMENT_TOTAL_BYTES)
    )
  }
}

async function persist(
  root: string,
  name: string,
  data: Uint8Array,
  options: Required<AttachmentImportOptions>
): Promise<ImportedAttachment | string> {
  const reason = validateMeta(name, data.byteLength, options)
  if (reason) return reason
  const safe = safeFileName(name)
  const digest = hashBytes(data)
  const dir = path.join(root, ATTACHMENT_DIR)
  const fileName = `${digest}-${safe}`
  const abs = path.join(dir, fileName)
  if (!inside(root, abs)) return '文件路径越界'

  await mkdir(dir, { recursive: true })
  let exists = false
  try {
    const current = await stat(abs)
    exists = current.isFile() && current.size === data.byteLength
  } catch {
    exists = false
  }
  if (!exists) {
    // 先写临时文件再改名:进程中断时不会留下一个半截附件被后续请求读到。
    const temp = `${abs}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, data, { flag: 'wx' })
    await rename(temp, abs)
  }
  return {
    path: path.relative(root, abs).split(path.sep).join('/'),
    name: displayName(name),
    size: data.byteLength,
    kind: IMAGE_EXTENSIONS.has(extensionOf(name)) ? 'image' : 'file'
  }
}

/**
 * 把用户选择的系统文件复制进工作区。
 *
 * 工作区外路径不会直接交给 daemon:复制后 daemon 仍只读取工作区内文件,
 * 附件生命周期也随工作区一起可迁移。符号链接、目录和非普通文件直接拒绝。
 */
export async function importAttachmentPaths(
  root: string,
  sources: string[],
  options: AttachmentImportOptions = {}
): Promise<ImportAttachmentResult> {
  const limits = normalizeOptions(options)
  const attachments: ImportedAttachment[] = []
  const rejected: RejectedAttachment[] = []
  const seen = new Set<string>()
  let total = 0

  for (const source of sources.slice(0, limits.maxFiles)) {
    const name = path.basename(source)
    try {
      const info = await lstat(source)
      if (info.isSymbolicLink()) {
        rejected.push({ name, reason: '不支持符号链接' })
        continue
      }
      if (!info.isFile()) {
        rejected.push({ name, reason: '只能添加文件' })
        continue
      }
      if (info.size > limits.maxFileBytes) {
        rejected.push({ name, reason: `文件超过 ${Math.floor(limits.maxFileBytes / 1024 / 1024)}MB` })
        continue
      }
      if (total + info.size > limits.maxTotalBytes) {
        rejected.push({ name, reason: '附件总大小超过限制' })
        break
      }
      const data = await readFile(source)
      const stored = await persist(root, name, data, limits)
      if (typeof stored === 'string') {
        rejected.push({ name, reason: stored })
        continue
      }
      total += stored.size
      if (!seen.has(stored.path)) {
        seen.add(stored.path)
        attachments.push(stored)
      }
    } catch (err) {
      rejected.push({ name, reason: (err as Error).message })
    }
  }

  if (sources.length > limits.maxFiles) {
    rejected.push({ name: '...', reason: `最多引用 ${limits.maxFiles} 个文件` })
  }
  return { attachments, rejected }
}

/** 浏览器删除路径时(例如从压缩包拖出)拿不到源路径,退化为直接传字节。 */
export async function importAttachmentData(
  root: string,
  sources: AttachmentImportData[],
  options: AttachmentImportOptions = {}
): Promise<ImportAttachmentResult> {
  const limits = normalizeOptions(options)
  const attachments: ImportedAttachment[] = []
  const rejected: RejectedAttachment[] = []
  const seen = new Set<string>()
  let total = 0

  for (const source of sources.slice(0, limits.maxFiles)) {
    const name = path.basename(source.name)
    try {
      const bytes = source.data instanceof Uint8Array ? source.data : new Uint8Array(source.data)
      if (bytes.byteLength > limits.maxFileBytes) {
        rejected.push({ name, reason: `文件超过 ${Math.floor(limits.maxFileBytes / 1024 / 1024)}MB` })
        continue
      }
      if (total + bytes.byteLength > limits.maxTotalBytes) {
        rejected.push({ name, reason: '附件总大小超过限制' })
        break
      }
      const stored = await persist(root, name, bytes, limits)
      if (typeof stored === 'string') {
        rejected.push({ name, reason: stored })
        continue
      }
      total += stored.size
      if (!seen.has(stored.path)) {
        seen.add(stored.path)
        attachments.push(stored)
      }
    } catch (err) {
      rejected.push({ name, reason: (err as Error).message })
    }
  }

  if (sources.length > limits.maxFiles) {
    rejected.push({ name: '...', reason: `最多引用 ${limits.maxFiles} 个文件` })
  }
  return { attachments, rejected }
}

/** 选择器路径兜底:仅用于测试/兼容旧调用,正常流程用 importAttachmentPaths。 */
export async function copyAttachmentPath(
  root: string,
  source: string,
  options: AttachmentImportOptions = {}
): Promise<ImportedAttachment> {
  const { attachments, rejected } = await importAttachmentPaths(root, [source], options)
  const first = attachments[0]
  if (!first) throw new Error(rejected[0]?.reason ?? '无法添加附件')
  return first
}


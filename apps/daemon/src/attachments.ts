import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveInsideWorkspace } from './tools/builtin.js'

export type AttachmentKind = 'file' | 'image' | 'folder'
export type AttachmentSource = 'upload' | 'workspace'

export interface RunAttachment {
  path: string
  name: string
  size?: number
  kind?: AttachmentKind
  source?: AttachmentSource
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

/** 文件夹引用的展开上限:目录再大也不能把一轮请求撑爆。 */
const FOLDER_MAX_DEPTH = 4
const FOLDER_MAX_FILES = 200
const FOLDER_SKIPPED_DIRS = new Set([
  '.git',
  '.openwb',
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  'target',
  'vendor'
])

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
 * 工作区引用必须是工作区内的相对路径。
 *
 * 这里只是第一道收敛:绝对路径、盘符、上跳、NUL 一律拒绝;真正的边界
 * 校验仍由 resolveInsideWorkspace 在读取时完成。内部目录 .openwb 不接受,
 * 避免用户把数据库或附件副本当作普通上下文注入。
 */
export function isWorkspaceReferencePath(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) return false
  if (value.includes('\0')) return false
  if (safeRelative(value) !== value.replace(/^\.\//, '')) return false
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) return false
  if (/^[a-zA-Z]:/.test(value)) return false
  const segments = safeRelative(value).split('/')
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) return false
  const rel = safeRelative(value)
  if (rel === '.openwb' || rel.startsWith('.openwb/')) return false
  return true
}

function detectKind(name: string, kind: unknown): AttachmentKind {
  if (kind === 'folder') return 'folder'
  if (kind === 'image' || IMAGE_EXTENSIONS.has(extOf(name))) return 'image'
  return 'file'
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
    const rawKind = (item as { kind?: unknown }).kind
    const rawSource = (item as { source?: unknown }).source
    if (typeof rel !== 'string' || !rel) continue
    if (typeof name !== 'string' || !name.trim()) continue

    const uploadPath = isAttachmentStoragePath(rel)
    const workspacePath = isWorkspaceReferencePath(rel)
    const source: AttachmentSource =
      rawSource === 'upload' || rawSource === 'workspace'
        ? rawSource
        : uploadPath
          ? 'upload'
          : 'workspace'
    // 声明与路径必须自洽,不让"上传"标记绕过工作区边界,反之亦然。
    if (source === 'upload' && !uploadPath) continue
    if (source === 'workspace' && !workspacePath) continue

    const normalized = safeRelative(rel)
    const key = `${source}:${normalized}`
    if (seen.has(key)) continue
    seen.add(key)
    const kind = detectKind(name, rawKind)
    out.push({
      path: normalized,
      name: path.basename(name.replace(/\\/g, '/')).slice(0, 200) || 'attachment',
      ...(typeof size === 'number' && Number.isFinite(size) && size >= 0 ? { size } : {}),
      kind,
      source
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

interface Budget {
  textBytes: number
  imageBytes: number
}

interface Collector {
  manifest: string[]
  chunks: string[]
  images: TurnImage[]
  rejected: Array<{ name: string; reason: string }>
  injected: number
}

/**
 * 读取单个普通文件并写入上下文。
 *
 * 文本按预算注入正文,图片作为多模态输入,其余二进制只列清单。
 * 返回是否计入 injected。
 */
async function collectFile(
  root: string,
  rel: string,
  name: string,
  options: { allowImage: boolean; note?: string },
  collector: Collector,
  budget: Budget
): Promise<boolean> {
  const abs = await resolveInsideWorkspace(root, rel)
  const info = await lstat(abs)
  if (info.isSymbolicLink()) {
    collector.rejected.push({ name, reason: '不支持符号链接' })
    return false
  }
  if (!info.isFile()) {
    collector.rejected.push({ name, reason: '不是普通文件' })
    return false
  }
  if (info.size <= 0) {
    collector.rejected.push({ name, reason: '文件为空' })
    return false
  }
  if (info.size > MAX_ATTACHMENT_FILE_BYTES) {
    collector.rejected.push({ name, reason: '文件超过 20MB' })
    return false
  }

  const suffix = options.note ? `（${options.note}）` : ''
  const ext = extOf(name)
  if (options.allowImage && IMAGE_EXTENSIONS.has(ext)) {
    if (budget.imageBytes + info.size > MAX_IMAGE_TOTAL) {
      collector.rejected.push({ name, reason: '本轮图片总大小超过 30MB' })
      return false
    }
    const data = await readFile(abs)
    collector.images.push({
      name,
      mimeType: IMAGE_MIME[ext]!,
      data: new Uint8Array(data)
    })
    budget.imageBytes += data.byteLength
    collector.manifest.push(
      `- ${name}（${describeKind(name)}，${formatSize(info.size)}）：\`${rel}\`${suffix}，已作为图片输入发送。`
    )
    collector.injected++
    return true
  }

  const buf = await readFile(abs)
  if (!isTextCandidate(name, buf)) {
    collector.manifest.push(
      `- ${name}（${describeKind(name)}，${formatSize(info.size)}）：\`${rel}\`${suffix}。二进制内容未注入正文；需要时请用工作区工具读取，无法解析时如实告诉用户。`
    )
    collector.injected++
    return true
  }

  const budgetLeft = Math.max(0, MAX_TEXT_TOTAL - budget.textBytes)
  if (budgetLeft <= 0) {
    collector.manifest.push(
      `- ${name}（${formatSize(info.size)}）：\`${rel}\`${suffix}。本轮文本预算已用完，请用工作区工具按需读取。`
    )
    collector.injected++
    return true
  }
  const limit = Math.min(MAX_TEXT_PER_FILE, budgetLeft, buf.length)
  const body = buf.subarray(0, limit).toString('utf8')
  budget.textBytes += Buffer.byteLength(body, 'utf8')
  collector.chunks.push(
    `### ${name}（\`${rel}\`）${suffix}${
      buf.length > limit ? `（已截断，原文件 ${buf.length} 字节）` : ''
    }\n\`\`\`\n${body}\n\`\`\``
  )
  collector.injected++
  return true
}

interface ExpandedEntry {
  rel: string
  name: string
}

interface ExpandedFolder {
  entries: ExpandedEntry[]
  skippedDirs: number
  skippedSymlinks: number
  truncated: boolean
}

/**
 * 有界展开用户引用的文件夹。
 *
 * 只做一层受控遍历:限深、限量、跳过依赖/构建/隐藏目录,符号链接一律不跟随。
 * 返回的相对路径交给 collectFile 再次做工作区边界校验。
 */
async function expandFolder(root: string, rel: string): Promise<ExpandedFolder> {
  const absRoot = await resolveInsideWorkspace(root, rel)
  const rootInfo = await lstat(absRoot)
  if (rootInfo.isSymbolicLink()) throw new Error('不支持符号链接')
  if (!rootInfo.isDirectory()) throw new Error('不是文件夹')

  const entries: ExpandedEntry[] = []
  let skippedDirs = 0
  let skippedSymlinks = 0
  let truncated = false

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated) return
    let list
    try {
      list = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    list.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? 1 : -1
      return a.name.localeCompare(b.name, 'zh-Hans-CN')
    })
    for (const entry of list) {
      if (entries.length >= FOLDER_MAX_FILES) {
        truncated = true
        return
      }
      if (entry.isSymbolicLink()) {
        skippedSymlinks++
        continue
      }
      if (entry.name.startsWith('.')) continue
      const childAbs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth >= FOLDER_MAX_DEPTH) {
          truncated = true
          continue
        }
        if (FOLDER_SKIPPED_DIRS.has(entry.name) || /^release([-_].*)?$/i.test(entry.name)) {
          skippedDirs++
          continue
        }
        await walk(childAbs, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      entries.push({
        rel: path.relative(path.resolve(root), childAbs).split(path.sep).join('/'),
        name: entry.name
      })
    }
  }

  await walk(absRoot, 0)
  return { entries, skippedDirs, skippedSymlinks, truncated }
}

/**
 * 读取本轮附件并生成两部分上下文:
 *   - 文本/代码:按预算注入 system,保持 @ 文件体验;
 *   - 图片:返回二进制,由调用方作为当前轮 ImagePart 发送;
 *   - 工作区文件夹:有界展开,文本进入正文,其余只列清单;
 *   - PDF/Office 等二进制:只列清单与路径,绝不把字节当 UTF-8 注入。
 */
export async function loadRunAttachments(
  root: string,
  attachments: RunAttachment[]
): Promise<LoadedAttachments> {
  const accepted = attachments.slice(0, MAX_RUN_ATTACHMENTS)
  const collector: Collector = {
    manifest: [],
    chunks: [],
    images: [],
    rejected: [],
    injected: 0
  }
  const budget: Budget = { textBytes: 0, imageBytes: 0 }
  let workspaceRefs = 0

  for (const item of accepted) {
    const source: AttachmentSource = item.source ?? 'upload'
    if (source === 'upload' && !isAttachmentStoragePath(item.path)) {
      collector.rejected.push({ name: item.name, reason: '附件路径不在附件目录内' })
      continue
    }
    if (source === 'workspace') {
      if (!isWorkspaceReferencePath(item.path)) {
        collector.rejected.push({ name: item.name, reason: '引用路径不在工作区内' })
        continue
      }
      workspaceRefs++
    }

    try {
      if (item.kind === 'folder') {
        if (source !== 'workspace') {
          collector.rejected.push({ name: item.name, reason: '只支持引用工作区文件夹' })
          continue
        }
        const folder = await expandFolder(root, item.path)
        if (folder.entries.length === 0) {
          collector.rejected.push({ name: item.name, reason: '文件夹为空或没有可读取的文件' })
          continue
        }
        const notes = [
          folder.skippedDirs > 0 ? `跳过 ${folder.skippedDirs} 个依赖/构建目录` : '',
          folder.skippedSymlinks > 0 ? `跳过 ${folder.skippedSymlinks} 个符号链接` : '',
          folder.truncated ? `仅展开前 ${FOLDER_MAX_FILES} 个文件` : ''
        ].filter(Boolean)
        collector.manifest.push(
          `- ${item.name}/（文件夹，共 ${folder.entries.length} 个文件）：\`${item.path}\`${
            notes.length > 0 ? `（${notes.join('，')}）` : ''
          }`
        )
        collector.chunks.push(
          `## 文件夹 ${item.path} 的内容清单\n${folder.entries
            .map((entry) => `- \`${entry.rel}\``)
            .join('\n')}`
        )
        for (const entry of folder.entries) {
          try {
            await collectFile(
              root,
              entry.rel,
              entry.name,
              { allowImage: false, note: '来自文件夹引用' },
              collector,
              budget
            )
          } catch (err) {
            collector.rejected.push({ name: entry.name, reason: (err as Error).message })
          }
        }
        continue
      }

      await collectFile(root, item.path, item.name, { allowImage: true }, collector, budget)
    } catch (err) {
      collector.rejected.push({ name: item.name, reason: (err as Error).message })
    }
  }

  if (collector.manifest.length === 0 && collector.chunks.length === 0 && collector.images.length === 0) {
    return {
      system: '',
      images: collector.images,
      injected: collector.injected,
      bytes: budget.textBytes + budget.imageBytes,
      rejected: collector.rejected
    }
  }

  const intro =
    workspaceRefs > 0
      ? '这些内容由用户通过输入框引用；上传附件已复制到工作区，工作区文件与文件夹为原地引用，回答时优先参考。'
      : '这些文件由用户通过输入框添加，已保存到工作区；回答时优先参考。'

  const sections = [
    '',
    '# 用户添加的附件与引用',
    intro,
    ...collector.manifest,
    collector.chunks.length > 0 ? `## 附件正文\n${collector.chunks.join('\n\n')}` : '',
    collector.rejected.length > 0
      ? `## 未能读取的附件\n${collector.rejected
          .map((item) => `- ${item.name}：${item.reason}`)
          .join('\n')}`
      : ''
  ].filter(Boolean)

  return {
    system: sections.join('\n'),
    images: collector.images,
    injected: collector.injected,
    bytes: budget.textBytes + budget.imageBytes,
    rejected: collector.rejected
  }
}

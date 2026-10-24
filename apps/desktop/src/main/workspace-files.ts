import { lstat, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

export interface WorkspaceFileEntry {
  path: string
  name: string
  size: number
  kind: 'file' | 'folder'
}

export interface ListWorkspaceFilesOptions {
  limit?: number
  maxDepth?: number
}

const DEFAULT_LIMIT = 400
const DEFAULT_MAX_DEPTH = 4
const SKIPPED_DIRS = new Set([
  '.git',
  '.openwb',
  '.OpenWorkBuddy',
  'node_modules',
  'dist',
  'out',
  'release',
  'release-old-p8-3',
  'release-old-p8-3b',
  'release-old-p8-3c',
  'release-old-p8-3d'
])

export interface ResolvedWorkspaceEntry {
  absolutePath: string
  relativePath: string
  kind: 'file' | 'folder'
}

/**
 * 校验一个用户给出的工作区相对路径,并说明它是文件还是文件夹。
 *
 * 定位/预览入口必须走这里:只接受相对路径,拒绝上跳、绝对路径与符号链接,
 * 并且用 lstat 复核真实类型,避免渲染进程伪造 kind 打开任意位置。
 */
export async function resolveWorkspaceEntry(
  root: string,
  value: string
): Promise<ResolvedWorkspaceEntry> {
  if (typeof value !== 'string' || value.length === 0) throw new Error('路径不能为空')
  if (value.includes('\0')) throw new Error('路径含非法字符')
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) throw new Error('只接受工作区相对路径')
  const rel = value.replace(/\\/g, '/').replace(/^\.\//, '')
  const segments = rel.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('路径越界')
  }
  if (rel === '.openwb' || rel.startsWith('.openwb/')) throw new Error('不能引用内部目录')

  const workspace = path.resolve(root)
  const absolutePath = path.resolve(workspace, rel)
  if (absolutePath !== workspace && !absolutePath.startsWith(workspace + path.sep)) {
    throw new Error('路径越界')
  }
  const info = await lstat(absolutePath)
  if (info.isSymbolicLink()) throw new Error('不支持符号链接')
  if (!info.isFile() && !info.isDirectory()) throw new Error('不是普通文件或文件夹')
  return {
    absolutePath,
    relativePath: path.relative(workspace, absolutePath).split(path.sep).join('/'),
    kind: info.isDirectory() ? 'folder' : 'file'
  }
}

/**
 * 给 @ 选择器提供工作区内的文件清单。
 *
 * 只读、限深、限量;跳过隐藏目录、依赖与构建产物,避免把几十万文件或
 * .git 内部对象甩到渲染进程。符号链接一律跳过,否则选择器可能跨出工作区。
 * daemon 在真正注入时仍会再次校验路径,这里不是信任边界。
 */
export async function listWorkspaceFiles(
  root: string,
  options: ListWorkspaceFilesOptions = {}
): Promise<WorkspaceFileEntry[]> {
  const workspace = path.resolve(root)
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, 2000))
  const maxDepth = Math.max(0, Math.min(options.maxDepth ?? DEFAULT_MAX_DEPTH, 8))
  const files: WorkspaceFileEntry[] = []

  const pushFolder = (abs: string): void => {
    files.push({
      path: path.relative(workspace, abs).split(path.sep).join('/'),
      name: path.basename(abs),
      size: 0,
      kind: 'folder'
    })
  }

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (files.length >= limit) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? 1 : -1
      return a.name.localeCompare(b.name, 'zh-Hans-CN')
    })
    for (const entry of entries) {
      if (files.length >= limit) return
      if (entry.isSymbolicLink()) continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        // 文件夹本身始终可选:即使它太深、不再继续展开,用户仍可整体引用。
        pushFolder(abs)
        if (depth >= maxDepth) continue
        await walk(abs, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (entry.name.startsWith('.')) continue
      let size = 0
      try {
        size = (await stat(abs)).size
      } catch {
        continue
      }
      files.push({
        path: path.relative(workspace, abs).split(path.sep).join('/'),
        name: entry.name,
        size,
        kind: 'file'
      })
    }
  }

  await walk(workspace, 0)
  return files
}

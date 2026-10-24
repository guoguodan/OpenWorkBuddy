import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

export interface WorkspaceFileEntry {
  path: string
  name: string
  size: number
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
        if (depth >= maxDepth) continue
        if (SKIPPED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
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
        size
      })
    }
  }

  await walk(workspace, 0)
  return files
}

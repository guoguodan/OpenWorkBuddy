import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  rmdir,
  unlink
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'

/**
 * 文件检查点。
 *
 * 快照保存"路径 -> 内容哈希",内容按哈希存进 blob 目录。这样同一文件在多轮里
 * 只占一份空间,又能恢复任意一轮的完整工作区。恢复时只触碰被截断轮次实际
 * 改过的路径,用户手工创建且与这些轮次无关的文件不会被删除。
 */
export interface SnapshotFile {
  path: string
  sha256: string
  size: number
}

export interface WorkspaceManifest {
  version: 1
  complete: boolean
  reason?: string
  files: SnapshotFile[]
}

export interface SnapshotLimits {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
}

const DEFAULT_LIMITS: SnapshotLimits = {
  maxFiles: 50_000,
  maxFileBytes: 256 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024
}

/** 这些目录不属于用户成果,也不应该被"回退版本"改动。 */
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.openwb', '.openwb-data'])

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`))
}

async function hashFile(abs: string): Promise<{ sha256: string; size: number }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256')
    let size = 0
    const stream = createReadStream(abs)
    stream.on('data', (chunk) => {
      size += chunk.length
      hash.update(chunk)
    })
    stream.on('error', rejectPromise)
    stream.on('end', () => resolvePromise({ sha256: hash.digest('hex'), size }))
  })
}

async function pathExists(abs: string): Promise<boolean> {
  try {
    await lstat(abs)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

export async function snapshotWorkspace(
  root: string,
  blobDir: string,
  options: { excluded?: string[]; limits?: SnapshotLimits } = {}
): Promise<WorkspaceManifest> {
  const workspace = resolve(root)
  const blobs = resolve(blobDir)
  await mkdir(blobs, { recursive: true })
  const excluded = (options.excluded ?? []).map((item) => resolve(item))
  const limits = options.limits ?? DEFAULT_LIMITS
  const files: SnapshotFile[] = []
  let totalBytes = 0
  let incompleteReason: string | undefined

  const visit = async (dir: string): Promise<void> => {
    if (incompleteReason) return
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (incompleteReason) return
      if (SKIPPED_DIRS.has(entry.name)) continue
      const abs = resolve(dir, entry.name)
      if (abs === blobs || abs.startsWith(blobs + sep)) continue
      if (excluded.some((item) => abs === item || abs.startsWith(item + sep))) continue
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await visit(abs)
        continue
      }
      if (!entry.isFile()) continue
      if (files.length >= limits.maxFiles) {
        incompleteReason = `文件数超过上限 ${limits.maxFiles}`
        return
      }
      const info = await lstat(abs)
      if (info.size > limits.maxFileBytes) {
        incompleteReason = `文件过大: ${relative(workspace, abs)} (${info.size} 字节)`
        return
      }
      if (totalBytes + info.size > limits.maxTotalBytes) {
        incompleteReason = `工作区总大小超过上限 ${limits.maxTotalBytes} 字节`
        return
      }
      const { sha256, size } = await hashFile(abs)
      if (size !== info.size) {
        incompleteReason = `快照期间文件发生变化: ${relative(workspace, abs)}`
        return
      }
      totalBytes += size
      const rel = relative(workspace, abs).split(sep).join('/')
      files.push({ path: rel, sha256, size })
      const blob = join(blobs, sha256)
      if (!(await pathExists(blob))) {
        // 先写临时文件再改名:并发或中断时不会留下"存在但内容不全"的 blob。
        const temp = join(blobs, `.tmp-${randomUUID()}`)
        await copyFile(abs, temp)
        await rename(temp, blob)
      }
    }
  }

  try {
    await visit(workspace)
  } catch (err) {
    return {
      version: 1,
      complete: false,
      reason: (err as Error).message,
      files: []
    }
  }
  return {
    version: 1,
    complete: !incompleteReason,
    ...(incompleteReason ? { reason: incompleteReason } : {}),
    files: incompleteReason ? [] : files
  }
}

export function parseManifest(raw: string): WorkspaceManifest {
  const parsed = JSON.parse(raw) as WorkspaceManifest
  if (parsed.version !== 1 || !Array.isArray(parsed.files)) {
    throw new Error('检查点清单格式不正确')
  }
  return parsed
}

/** 比较两个完整清单,返回新增、修改或删除的路径。 */
export function changedPaths(before: WorkspaceManifest, after: WorkspaceManifest): string[] {
  if (!before.complete || !after.complete) return []
  const left = new Map(before.files.map((f) => [f.path, f]))
  const right = new Map(after.files.map((f) => [f.path, f]))
  const changed = new Set<string>()
  for (const [path, file] of left) {
    const next = right.get(path)
    if (!next || next.sha256 !== file.sha256 || next.size !== file.size) changed.add(path)
  }
  for (const path of right.keys()) if (!left.has(path)) changed.add(path)
  return [...changed].sort()
}

function safePath(root: string, rel: string): string {
  if (!rel || rel.includes('\0') || rel.includes('\\0')) throw new Error(`非法路径: ${rel}`)
  const abs = resolve(root, rel)
  if (!inside(root, abs) || abs === root) throw new Error(`路径越界: ${rel}`)
  return abs
}

async function verifyBlob(blob: string, expected: SnapshotFile): Promise<void> {
  const info = await lstat(blob).catch(() => null)
  if (!info?.isFile()) throw new Error(`检查点内容缺失: ${expected.path}`)
  if (info.size !== expected.size) throw new Error(`检查点内容大小不符: ${expected.path}`)
  const { sha256 } = await hashFile(blob)
  if (sha256 !== expected.sha256) throw new Error(`检查点内容校验失败: ${expected.path}`)
}

async function pruneEmptyParents(root: string, start: string): Promise<void> {
  let dir = dirname(start)
  while (dir !== root && inside(root, dir)) {
    try {
      await rmdir(dir)
    } catch {
      return
    }
    dir = dirname(dir)
  }
}

export interface RestoreResult {
  status: 'restored' | 'none'
  restored: number
  deleted: number
  touched: number
}

/**
 * 把 touched 中的路径恢复到 manifest 描述的状态。
 * 期望状态里没有的路径 = 删除;有 = 从 blob 还原。
 */
export async function restoreWorkspacePaths(input: {
  root: string
  blobDir: string
  manifest: WorkspaceManifest
  touched: string[]
}): Promise<RestoreResult> {
  if (!input.manifest.complete) {
    throw new Error(`检查点不完整,无法安全恢复${input.manifest.reason ? `: ${input.manifest.reason}` : ''}`)
  }
  const root = resolve(input.root)
  const desired = new Map(input.manifest.files.map((f) => [f.path, f]))
  const paths = [...new Set(input.touched)].sort()
  if (paths.length === 0) return { status: 'none', restored: 0, deleted: 0, touched: 0 }

  // 先做完全部校验再动磁盘:任何一个 blob 缺失都不能执行"半个恢复"。
  for (const rel of paths) {
    safePath(root, rel)
    const target = desired.get(rel)
    if (target) await verifyBlob(join(resolve(input.blobDir), target.sha256), target)
  }

  const backupRoot = await mkdtemp(join(tmpdir(), 'owb-restore-'))
  const backups: Array<{ rel: string; file: string | null }> = []
  const currentAbs = new Map<string, string>()
  try {
    for (const [index, rel] of paths.entries()) {
      const abs = safePath(root, rel)
      currentAbs.set(rel, abs)
      const info = await lstat(abs).catch(() => null)
      if (!info) {
        backups.push({ rel, file: null })
        continue
      }
      if (!info.isFile()) throw new Error(`路径被目录或链接占用,未执行恢复: ${rel}`)
      const copy = join(backupRoot, String(index))
      await copyFile(abs, copy)
      backups.push({ rel, file: copy })
    }

    let restored = 0
    let deleted = 0
    for (const rel of paths) {
      const abs = currentAbs.get(rel)!
      const target = desired.get(rel)
      if (!target) {
        if (await pathExists(abs)) {
          await unlink(abs)
          deleted++
        }
        await pruneEmptyParents(root, abs)
        continue
      }
      await mkdir(dirname(abs), { recursive: true })
      const temp = join(dirname(abs), `.owb-restore-${randomUUID()}`)
      await copyFile(join(resolve(input.blobDir), target.sha256), temp)
      await rename(temp, abs)
      restored++
    }
    return { status: 'restored', restored, deleted, touched: paths.length }
  } catch (err) {
    // 回滚本次已经改动的路径,避免工作区停在半恢复状态。
    for (const item of backups) {
      const abs = currentAbs.get(item.rel)
      if (!abs) continue
      try {
        if (item.file) {
          await mkdir(dirname(abs), { recursive: true })
          await copyFile(item.file, abs)
        } else {
          await unlink(abs).catch(() => undefined)
        }
      } catch {
        // 继续尝试其余路径;原始错误更有诊断价值。
      }
    }
    throw err
  } finally {
    await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

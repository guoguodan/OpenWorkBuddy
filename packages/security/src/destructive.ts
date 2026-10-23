import { createHash, randomBytes } from 'node:crypto'
import { copyFile, cp, lstat, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import {
  classifyPath,
  defaultSystemRoots,
  normalizePathForCompare,
  resolveTargetPath,
  type PathCategory
} from './paths.js'
import type { TrashAdapter, TrashItem } from './trash.js'

export const MAX_DESTRUCTIVE_BATCH = 10
export const MAX_BACKUP_ENTRIES = 2000
export const MAX_BACKUP_BYTES = 256 * 1024 * 1024

export type DestructiveOperation = 'delete' | 'move'
export type DestructiveKind = 'file' | 'directory'

export class SecurityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'SecurityError'
  }
}

export interface DestructiveRequestItem {
  from: string
  to?: string
}

export interface DestructiveRequest {
  operation: DestructiveOperation
  items: DestructiveRequestItem[]
}

export interface ApprovedPlanItem {
  path: string
  kind: DestructiveKind
  size: number
  destPath?: string
}

export interface DestructivePlanItem extends ApprovedPlanItem {
  mtimeMs: number
  entryCount: number
  treeDigest: string
}

export interface DestructivePlan {
  operation: DestructiveOperation
  items: DestructivePlanItem[]
  totalBytes: number
  fingerprint: string
}

export interface DestructiveInspectOptions {
  workspaceRoot: string
  classifyPath?: (target: string, workspaceRoot: string) => PathCategory
  platform?: NodeJS.Platform
  home?: string
}

export interface BackupManifestItem {
  originalPath: string
  backupPath: string
  kind: DestructiveKind
  size: number
  mtimeMs: number
  entryCount: number
  treeDigest: string
  sha256?: string
  destPath?: string
}

export interface BackupManifest {
  version: 1
  operation: DestructiveOperation
  createdAt: string
  planFingerprint: string
  items: BackupManifestItem[]
}

export interface BackupResult {
  dir: string
  manifestPath: string
  manifest: BackupManifest
}

export interface DestructiveExecutionResult {
  operation: DestructiveOperation
  completed: Array<{ from: string; to?: string; kind: DestructiveKind }>
  backupDir: string
  manifestPath: string
  trashKind: string
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeForHash(target: string, platform: NodeJS.Platform): string {
  return normalizePathForCompare(target, platform)
}

function containsPath(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const p = normalizeForHash(parent, platform)
  const c = normalizeForHash(child, platform)
  if (p === c) return true
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SecurityError('INVALID_TARGETS', `${field} 必须是非空字符串数组`)
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new SecurityError('INVALID_TARGETS', `${field}[${index}] 必须是非空字符串`)
    }
    return item
  })
}

/** 把模型给出的 delete_files / move_files 参数解析成不可歧义的请求结构。 */
export function destructiveRequestFromTool(
  toolName: string,
  args: Record<string, unknown>
): DestructiveRequest {
  if (toolName === 'delete_files') {
    const paths = asStringArray(args.paths, 'paths')
    if (paths.length > MAX_DESTRUCTIVE_BATCH) {
      throw new SecurityError(
        'BATCH_TOO_LARGE',
        `一次最多处理 ${MAX_DESTRUCTIVE_BATCH} 项,本次 ${paths.length} 项。请拆分后重试。`
      )
    }
    return { operation: 'delete', items: paths.map((from) => ({ from })) }
  }
  if (toolName === 'move_files') {
    if (!Array.isArray(args.items) || args.items.length === 0) {
      throw new SecurityError('INVALID_TARGETS', 'items 必须是非空数组')
    }
    if (args.items.length > MAX_DESTRUCTIVE_BATCH) {
      throw new SecurityError(
        'BATCH_TOO_LARGE',
        `一次最多移动 ${MAX_DESTRUCTIVE_BATCH} 项,本次 ${args.items.length} 项。请拆分后重试。`
      )
    }
    const items = args.items.map((raw, index) => {
      if (!raw || typeof raw !== 'object') {
        throw new SecurityError('INVALID_TARGETS', `items[${index}] 必须是对象`)
      }
      const record = raw as Record<string, unknown>
      if (typeof record.from !== 'string' || record.from.trim().length === 0) {
        throw new SecurityError('INVALID_TARGETS', `items[${index}].from 必须是非空字符串`)
      }
      if (typeof record.to !== 'string' || record.to.trim().length === 0) {
        throw new SecurityError('INVALID_TARGETS', `items[${index}].to 必须是非空字符串`)
      }
      return { from: record.from, to: record.to }
    })
    return { operation: 'move', items }
  }
  throw new SecurityError('INVALID_OPERATION', `不支持的破坏性工具: ${toolName}`)
}

async function lstatOptional(target: string) {
  try {
    return await lstat(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

function protectedRoots(workspaceRoot: string, home: string, platform: NodeJS.Platform): string[] {
  const roots = [
    workspaceRoot,
    home,
    ...defaultSystemRoots(platform),
    ...['Desktop', 'Downloads', 'Documents', 'Pictures', 'Music', 'Videos'].map((name) =>
      resolve(home, name)
    )
  ]
  const oneDrive = process.env.OneDrive ? resolve(process.env.OneDrive) : null
  if (oneDrive) roots.push(oneDrive)
  // 盘符/文件系统根目录永远不能作为删除目标
  const parsed = resolve(workspaceRoot)
  const driveRoot = parsed.slice(0, parsed.indexOf(sep) + 1) || sep
  roots.push(driveRoot)
  return roots
}

interface TreeScan {
  entryCount: number
  size: number
  lines: string[]
}

async function scanTree(root: string, platform: NodeJS.Platform): Promise<TreeScan> {
  const lines: string[] = []
  let entryCount = 0
  let size = 0

  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      throw new SecurityError('SCAN_FAILED', `无法读取目录 ${dir}: ${(err as Error).message}`)
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const child = join(dir, entry.name)
      const info = await lstat(child)
      if (entry.isSymbolicLink() || info.isSymbolicLink()) {
        throw new SecurityError('SYMLINK_DENIED', `拒绝跟随符号链接: ${child}`)
      }
      entryCount++
      if (entryCount > MAX_BACKUP_ENTRIES) {
        throw new SecurityError(
          'TREE_TOO_LARGE',
          `目录条目超过 ${MAX_BACKUP_ENTRIES} 个,请缩小范围后重试: ${root}`
        )
      }
      const rel = relative(root, child).split(sep).join('/')
      if (info.isDirectory()) {
        lines.push(`${rel}|d|${info.mtimeMs}`)
        await walk(child)
      } else if (info.isFile()) {
        size += info.size
        if (size > MAX_BACKUP_BYTES) {
          throw new SecurityError(
            'TREE_TOO_LARGE',
            `待备份内容超过 ${Math.floor(MAX_BACKUP_BYTES / 1024 / 1024)}MB,请缩小范围后重试: ${root}`
          )
        }
        lines.push(`${rel}|f|${info.size}|${info.mtimeMs}`)
      } else {
        throw new SecurityError('UNSUPPORTED_ENTRY', `不支持的文件类型: ${child}`)
      }
    }
  }

  await walk(root)
  return { entryCount, size, lines }
}

function assertNotProtected(
  target: string,
  workspaceRoot: string,
  home: string,
  platform: NodeJS.Platform
): void {
  for (const root of protectedRoots(workspaceRoot, home, platform)) {
    if (normalizeForHash(target, platform) === normalizeForHash(root, platform)) {
      throw new SecurityError('PATH_PROTECTED_ROOT', `不能对受保护的根目录执行破坏性操作: ${target}`)
    }
    if (containsPath(target, root, platform)) {
      throw new SecurityError(
        'PATH_PROTECTED_ROOT',
        `目标包含受保护的目录(${root}),为避免连带删除已拒绝: ${target}`
      )
    }
  }
}

/**
 * 生成不可跳过的执行计划:
 * - 批上限在触碰磁盘前判定;
 * - 系统/受保护根目录直接拒绝;
 * - 符号链接、重叠目标、移动覆盖一律拒绝;
 * - 指纹包含完整路径、大小、mtime 与目录树摘要,执行前必须重新比对。
 */
export async function inspectDestructiveRequest(
  request: DestructiveRequest,
  options: DestructiveInspectOptions
): Promise<DestructivePlan> {
  if (request.items.length > MAX_DESTRUCTIVE_BATCH) {
    throw new SecurityError('BATCH_TOO_LARGE', `一次最多处理 ${MAX_DESTRUCTIVE_BATCH} 项`)
  }
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const classify =
    options.classifyPath ??
    ((target, root) =>
      classifyPath(target, root, {
        ...(options.platform ? { platform: options.platform } : {}),
        ...(options.home ? { home: options.home } : {})
      }))
  const items: DestructivePlanItem[] = []
  const normalizedSources: string[] = []
  const normalizedDests: string[] = []

  for (const requested of request.items) {
    const abs = resolveTargetPath(requested.from, options.workspaceRoot, platform)
    const normalized = normalizeForHash(abs, platform)
    if (normalizedSources.includes(normalized)) {
      throw new SecurityError('DUPLICATE_TARGET', `重复的目标路径: ${abs}`)
    }

    let category: PathCategory
    try {
      category = classify(abs, options.workspaceRoot)
    } catch (err) {
      throw new SecurityError('PATH_CLASSIFY_FAILED', `无法判定路径类别 ${abs}: ${(err as Error).message}`)
    }
    if (category === 'system') {
      throw new SecurityError('PATH_SYSTEM_DENIED', `路径位于受保护的系统目录: ${abs}`)
    }
    assertNotProtected(abs, options.workspaceRoot, home, platform)

    const info = await lstatOptional(abs)
    if (!info) throw new SecurityError('TARGET_MISSING', `目标不存在: ${abs}`)
    if (info.isSymbolicLink()) throw new SecurityError('SYMLINK_DENIED', `拒绝删除或移动符号链接: ${abs}`)
    if (!info.isFile() && !info.isDirectory()) {
      throw new SecurityError('UNSUPPORTED_ENTRY', `只支持普通文件或目录: ${abs}`)
    }

    let entryCount = 0
    let size = info.size
    let treeDigest: string
    if (info.isDirectory()) {
      const scan = await scanTree(abs, platform)
      entryCount = scan.entryCount
      size = scan.size
      treeDigest = hash(scan.lines.sort().join('\n'))
    } else {
      treeDigest = hash(`f|${info.size}|${info.mtimeMs}`)
    }

    let destPath: string | undefined
    if (request.operation === 'move') {
      if (!requested.to) throw new SecurityError('INVALID_TARGETS', '移动操作缺少目标路径')
      destPath = resolveTargetPath(requested.to, options.workspaceRoot, platform)
      const normalizedDest = normalizeForHash(destPath, platform)
      if (normalizedSources.includes(normalizedDest) || normalizedDests.includes(normalizedDest)) {
        throw new SecurityError('INVALID_DESTINATION', `目标路径重复或与原路径相同: ${destPath}`)
      }
      let destCategory: PathCategory
      try {
        destCategory = classify(destPath, options.workspaceRoot)
      } catch (err) {
        throw new SecurityError(
          'PATH_CLASSIFY_FAILED',
          `无法判定目标位置 ${destPath}: ${(err as Error).message}`
        )
      }
      if (destCategory === 'system') {
        throw new SecurityError('PATH_SYSTEM_DENIED', `目标位于受保护的系统目录: ${destPath}`)
      }
      if (containsPath(destPath, abs, platform) || containsPath(abs, destPath, platform)) {
        throw new SecurityError('INVALID_DESTINATION', `不能把目录移动到自身内部: ${destPath}`)
      }
      if (await lstatOptional(destPath)) {
        throw new SecurityError('DESTINATION_EXISTS', `目标已存在,拒绝覆盖: ${destPath}`)
      }
      const parent = await lstatOptional(dirname(destPath))
      if (!parent || !parent.isDirectory()) {
        throw new SecurityError('DEST_PARENT_MISSING', `目标父目录不存在: ${dirname(destPath)}`)
      }
      normalizedDests.push(normalizedDest)
    }

    normalizedSources.push(normalized)
    items.push({
      path: abs,
      kind: info.isDirectory() ? 'directory' : 'file',
      size,
      mtimeMs: info.mtimeMs,
      entryCount,
      treeDigest,
      ...(destPath ? { destPath } : {})
    })
  }

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!
      const b = items[j]!
      if (containsPath(a.path, b.path, platform) || containsPath(b.path, a.path, platform)) {
        throw new SecurityError(
          'OVERLAPPING_TARGETS',
          `目标存在父子关系,请只保留最上层路径: ${a.path} / ${b.path}`
        )
      }
    }
  }

  const totalBytes = items.reduce((sum, item) => sum + item.size, 0)
  const fingerprint = hash(
    JSON.stringify({
      operation: request.operation,
      items: items.map((item) => ({
        path: normalizeForHash(item.path, platform),
        kind: item.kind,
        size: item.size,
        mtimeMs: item.mtimeMs,
        treeDigest: item.treeDigest,
        destPath: item.destPath ? normalizeForHash(item.destPath, platform) : null
      }))
    })
  )
  return { operation: request.operation, items, totalBytes, fingerprint }
}

function safeName(input: string): string {
  const cleaned = input.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60)
  return cleaned.length > 0 ? cleaned : 'item'
}

async function hashFile(target: string): Promise<string> {
  return hash((await readFile(target)).toString('base64'))
}

/**
 * 备份必须在删除/移动之前完成。任何一项复制失败都会抛出,调用方不得继续执行。
 * manifest 与备份文件放在同一目录,便于用户直接定位与还原。
 */
export async function backupDestructivePlan(
  plan: DestructivePlan,
  backupRoot: string,
  options: { now?: () => Date; id?: () => string } = {}
): Promise<BackupResult> {
  const now = options.now?.() ?? new Date()
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const id = options.id?.() ?? randomBytes(4).toString('hex')
  const dir = join(backupRoot, `${stamp}-${id}`)
  const itemsDir = join(dir, 'items')
  try {
    await mkdir(itemsDir, { recursive: true })
  } catch (err) {
    throw new SecurityError('BACKUP_FAILED', `无法创建备份目录 ${itemsDir}: ${(err as Error).message}`)
  }

  const manifestItems: BackupManifestItem[] = []
  try {
    for (let index = 0; index < plan.items.length; index++) {
      const item = plan.items[index]!
      const target = join(itemsDir, `${String(index).padStart(2, '0')}-${safeName(basename(item.path))}`)
      await cp(item.path, target, {
        recursive: item.kind === 'directory',
        force: false,
        errorOnExist: true,
        preserveTimestamps: true
      })
      const copied = await stat(target)
      if (!copied) throw new Error('备份文件不存在')
      if (item.kind === 'file' && copied.size !== item.size) {
        throw new Error(`备份大小不一致: ${copied.size} != ${item.size}`)
      }
      manifestItems.push({
        originalPath: item.path,
        backupPath: target,
        kind: item.kind,
        size: item.size,
        mtimeMs: item.mtimeMs,
        entryCount: item.entryCount,
        treeDigest: item.treeDigest,
        ...(item.kind === 'file' ? { sha256: await hashFile(target) } : {}),
        ...(item.destPath ? { destPath: item.destPath } : {})
      })
    }
  } catch (err) {
    throw new SecurityError(
      'BACKUP_FAILED',
      `备份失败,未执行任何删除/移动。备份目录: ${dir}。原因: ${(err as Error).message}`,
      { backupDir: dir }
    )
  }

  const manifest: BackupManifest = {
    version: 1,
    operation: plan.operation,
    createdAt: now.toISOString(),
    planFingerprint: plan.fingerprint,
    items: manifestItems
  }
  const manifestPath = join(dir, 'manifest.json')
  try {
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  } catch (err) {
    throw new SecurityError(
      'BACKUP_FAILED',
      `备份清单写入失败,未执行任何删除/移动。备份目录: ${dir}。原因: ${(err as Error).message}`,
      { backupDir: dir }
    )
  }
  return { dir, manifestPath, manifest }
}

/** 还原备份;默认不覆盖已存在文件,避免恢复动作反过来破坏新数据。 */
export async function restoreDestructiveBackup(
  manifestPath: string,
  options: { overwrite?: boolean } = {}
): Promise<{ restored: string[]; skipped: string[] }> {
  const raw = await readFile(manifestPath, 'utf8')
  const manifest = JSON.parse(raw) as BackupManifest
  if (manifest.version !== 1 || !Array.isArray(manifest.items)) {
    throw new SecurityError('BAD_MANIFEST', `无法识别的备份清单: ${manifestPath}`)
  }
  const restored: string[] = []
  const skipped: string[] = []
  for (const item of manifest.items) {
    const existing = await lstatOptional(item.originalPath)
    if (existing && !options.overwrite) {
      skipped.push(item.originalPath)
      continue
    }
    await mkdir(dirname(item.originalPath), { recursive: true })
    await cp(item.backupPath, item.originalPath, {
      recursive: item.kind === 'directory',
      force: options.overwrite === true,
      errorOnExist: options.overwrite !== true,
      preserveTimestamps: true
    })
    if (!(await lstatOptional(item.originalPath))) {
      throw new SecurityError('RESTORE_FAILED', `还原后目标仍不存在: ${item.originalPath}`)
    }
    restored.push(item.originalPath)
  }
  return { restored, skipped }
}

function assertPlanUnchanged(expected: DestructivePlan, actual: DestructivePlan): void {
  if (expected.fingerprint !== actual.fingerprint) {
    throw new SecurityError(
      'PLAN_CHANGED',
      '文件在确认后发生了变化,本次没有执行。请重新发起操作并确认最新清单。'
    )
  }
}

async function removeSourceWithTrash(
  adapter: TrashAdapter,
  item: DestructivePlanItem
): Promise<void> {
  const trashItem: TrashItem = { path: item.path, kind: item.kind }
  const outcomes = await adapter.trash([trashItem])
  const outcome = outcomes[0]
  if (!outcome || !outcome.ok) {
    throw new SecurityError(
      'TRASH_FAILED',
      `送入回收站失败: ${item.path}${outcome?.error ? ` (${outcome.error})` : ''}`
    )
  }
}

/**
 * 删除/移动执行器。调用方必须传入与审批时一致的 plan 指纹;
 * 备份失败、任一回收站失败或校验失败都会立即停止并保留备份路径。
 */
export async function executeDestructivePlan(
  expectedPlan: DestructivePlan,
  freshPlan: DestructivePlan,
  options: { backupRoot: string; trash: TrashAdapter; now?: () => Date }
): Promise<DestructiveExecutionResult> {
  assertPlanUnchanged(expectedPlan, freshPlan)
  const backup = await backupDestructivePlan(expectedPlan, options.backupRoot, {
    ...(options.now ? { now: options.now } : {})
  })
  const completed: Array<{ from: string; to?: string; kind: DestructiveKind }> = []

  try {
    for (const item of freshPlan.items) {
      if (freshPlan.operation === 'delete') {
        await removeSourceWithTrash(options.trash, item)
        if (await lstatOptional(item.path)) {
          throw new SecurityError('VERIFY_FAILED', `删除后原路径仍存在: ${item.path}`)
        }
        completed.push({ from: item.path, kind: item.kind })
        continue
      }

      if (!item.destPath) throw new SecurityError('INVALID_DESTINATION', `缺少目标路径: ${item.path}`)
      let moved = false
      try {
        await rename(item.path, item.destPath)
        moved = true
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      }
      if (!moved) {
        // 跨卷移动无法原子 rename:先复制,再把源送入回收站(仍可恢复)。
        await cp(item.path, item.destPath, {
          recursive: item.kind === 'directory',
          force: false,
          errorOnExist: true,
          preserveTimestamps: true
        })
        await removeSourceWithTrash(options.trash, item)
      }
      if (await lstatOptional(item.path)) {
        throw new SecurityError('VERIFY_FAILED', `移动后原路径仍存在: ${item.path}`)
      }
      if (!(await lstatOptional(item.destPath))) {
        throw new SecurityError('VERIFY_FAILED', `移动后目标不存在: ${item.destPath}`)
      }
      completed.push({ from: item.path, to: item.destPath, kind: item.kind })
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new SecurityError(
      'DESTRUCTIVE_FAILED',
      `操作中途失败,已停止。备份目录: ${backup.dir}。原因: ${reason}`,
      { backupDir: backup.dir, manifestPath: backup.manifestPath, completed }
    )
  }

  // 执行后再确认备份仍在:备份目录被外部删掉时,不能假装"可还原"。
  for (const item of backup.manifest.items) {
    if (!(await lstatOptional(item.backupPath))) {
      throw new SecurityError(
        'BACKUP_MISSING_AFTER_EXECUTE',
        `操作已执行但备份文件缺失,请立即停止后续操作并检查: ${item.backupPath}`,
        { backupDir: backup.dir }
      )
    }
  }

  return {
    operation: freshPlan.operation,
    completed,
    backupDir: backup.dir,
    manifestPath: backup.manifestPath,
    trashKind: options.trash.kind
  }
}

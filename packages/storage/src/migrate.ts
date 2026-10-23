import type Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MIGRATIONS, TARGET_VERSION } from './migrations.js'

export interface MigrateOptions {
  /** 数据库文件路径;内存库传 ':memory:' */
  dbPath: string
  /** 备份目录,默认 <dbDir>/backups */
  backupDir?: string
  /** 保留备份份数 */
  keepBackups?: number
}

export interface MigrateResult {
  from: number
  to: number
  backupPath?: string
}

export function currentVersion(raw: Database.Database): number {
  return raw.pragma('user_version', { simple: true }) as number
}

/**
 * 四条硬规则:
 * 1. 迁移在 daemon 接收请求之前完成,失败即抛。
 * 2. 已有数据才备份,最多保留 3 份。
 * 3. 库版本高于应用时拒绝启动,绝不做"向下兼容"。
 * 4. 每个迁移在单事务内执行,失败整体回滚。
 */
export function migrateOrThrow(raw: Database.Database, options: MigrateOptions): MigrateResult {
  const from = currentVersion(raw)
  // 运行时计算,而不是读取模块加载时的快照,便于测试注入临时迁移
  const target = MIGRATIONS.length

  if (from > target) {
    throw new Error(
      `数据库版本 ${from} 高于应用支持的 ${target}。请升级应用,不要降级运行。`
    )
  }
  if (from === target) return { from, to: target }

  const backupPath = backupIfNeeded(raw, options, from)

  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue
    raw.exec('BEGIN')
    try {
      raw.exec(migration.sql)
      raw.pragma(`user_version = ${migration.version}`)
      raw.exec('COMMIT')
    } catch (err) {
      raw.exec('ROLLBACK')
      throw new Error(`迁移 ${migration.name}(v${migration.version}) 失败: ${(err as Error).message}`)
    }
  }

  const to = currentVersion(raw)
  if (to !== target) throw new Error(`迁移后版本为 ${to},期望 ${target}`)
  return { from, to, ...(backupPath ? { backupPath } : {}) }
}

function backupIfNeeded(
  raw: Database.Database,
  options: MigrateOptions,
  from: number
): string | undefined {
  if (from === 0) return undefined
  if (options.dbPath === ':memory:') return undefined
  if (!existsSync(options.dbPath)) return undefined

  const dir = options.backupDir ?? join(dirname(options.dbPath), 'backups')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = join(dir, `openwb-v${from}-${stamp}.db`)

  // 用 SQLite 自己在线的备份 API,避免直接拷贝 WAL 状态下的不一致文件
  raw.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)

  pruneBackups(dir, options.keepBackups ?? 3)
  return dest
}

function pruneBackups(dir: string, keep: number): void {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('openwb-v') && f.endsWith('.db'))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const extra of files.slice(keep)) {
    try {
      unlinkSync(join(dir, extra.f))
    } catch {
      // 备份清理失败不应阻断迁移
    }
  }
}

export { TARGET_VERSION }
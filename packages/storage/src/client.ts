import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { schema } from './schema.js'

export type AppDatabase = BetterSQLite3Database<typeof schema>

export interface OpenDbResult {
  db: AppDatabase
  raw: Database.Database
  path: string
}

/**
 * 连接初始化:五条 pragma 缺一不可。
 * foreign_keys 是每连接生效的,漏设会让删会话后留下孤儿消息。
 */
export function openDatabase(dbPath: string): OpenDbResult {
  mkdirSync(dirname(dbPath), { recursive: true })
  const raw = new Database(dbPath)
  raw.pragma('journal_mode = WAL')
  raw.pragma('synchronous = NORMAL')
  raw.pragma('foreign_keys = ON')
  raw.pragma('busy_timeout = 5000')
  raw.pragma('temp_store = MEMORY')
  const db = drizzle(raw, { schema })
  return { db, raw, path: dbPath }
}

/** 外键是否真的在工作 —— 用于启动自检,避免配置失误静默通过 */
export function assertForeignKeysOn(raw: Database.Database): void {
  const enabled = raw.pragma('foreign_keys', { simple: true }) as number
  if (enabled !== 1) throw new Error('SQLite foreign_keys 未开启,级联删除会失效')
}
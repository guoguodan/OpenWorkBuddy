import { and, desc, eq } from 'drizzle-orm'
import type { AppDatabase } from './client.js'
import { nowIso, ulid } from './ids.js'
import { plugin } from './schema.js'

/**
 * 插件仓储。
 *
 * 表在 P4 已经是权威结构,这里只做映射与 upsert,不新增迁移。
 * enabled 以 INTEGER 存储;对外仍暴露 boolean,避免调用方到处写 `=== 1`。
 */

export type PluginKind = 'connector' | 'expert' | 'mcp'

export interface PluginRecord {
  id: string
  kind: PluginKind
  name: string
  version: string | null
  enabled: boolean
  permissions: string[]
  manifest: unknown
  installedAt: string
}

function mapRow(row: typeof plugin.$inferSelect): PluginRecord {
  let permissions: string[] = []
  try {
    const parsed: unknown = JSON.parse(row.permissionsJson)
    if (Array.isArray(parsed)) permissions = parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    // 损坏的 JSON 不能让整个插件列表不可用;按无权限处理更安全
  }
  let manifest: unknown = {}
  try {
    manifest = JSON.parse(row.manifestJson)
  } catch {
    manifest = {}
  }
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    version: row.version,
    enabled: row.enabled === 1,
    permissions,
    manifest,
    installedAt: row.installedAt
  }
}

export interface UpsertPluginInput {
  kind: PluginKind
  name: string
  version?: string | null
  enabled?: boolean
  permissions?: string[]
  manifest: unknown
}

/**
 * 同一 (kind, name) 视为同一个插件:重装时保留原 id 与 installed_at 语义,
 * 只更新版本、权限与清单。这样 UI 里不会因为升级出现"两个同名插件"。
 */
export function upsertPlugin(db: AppDatabase, input: UpsertPluginInput): PluginRecord {
  const existing = db
    .select()
    .from(plugin)
    .where(and(eq(plugin.kind, input.kind), eq(plugin.name, input.name)))
    .all()[0]

  const permissionsJson = JSON.stringify(input.permissions ?? [])
  const manifestJson = JSON.stringify(input.manifest ?? {})

  if (existing) {
    db.update(plugin)
      .set({
        version: input.version ?? null,
        ...(input.enabled !== undefined ? { enabled: input.enabled ? 1 : 0 } : {}),
        permissionsJson,
        manifestJson
      })
      .where(eq(plugin.id, existing.id))
      .run()
    return {
      ...mapRow(existing),
      version: input.version ?? null,
      enabled: input.enabled ?? existing.enabled === 1,
      permissions: input.permissions ?? [],
      manifest: input.manifest ?? {}
    }
  }

  const row = {
    id: ulid(),
    kind: input.kind,
    name: input.name,
    version: input.version ?? null,
    enabled: input.enabled === false ? 0 : 1,
    permissionsJson,
    manifestJson,
    installedAt: nowIso()
  }
  db.insert(plugin).values(row).run()
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    version: row.version,
    enabled: row.enabled === 1,
    permissions: input.permissions ?? [],
    manifest: input.manifest ?? {},
    installedAt: row.installedAt
  }
}

export function listPlugins(db: AppDatabase): PluginRecord[] {
  return db
    .select()
    .from(plugin)
    .orderBy(desc(plugin.installedAt), plugin.name)
    .all()
    .map(mapRow)
}

export function getPlugin(db: AppDatabase, name: string): PluginRecord | undefined {
  const row = db.select().from(plugin).where(eq(plugin.name, name)).all()[0]
  return row ? mapRow(row) : undefined
}

export function setPluginEnabled(db: AppDatabase, name: string, enabled: boolean): boolean {
  const existing = db.select().from(plugin).where(eq(plugin.name, name)).all()[0]
  if (!existing) return false
  db.update(plugin).set({ enabled: enabled ? 1 : 0 }).where(eq(plugin.id, existing.id)).run()
  return true
}

export function deletePlugin(db: AppDatabase, name: string): boolean {
  const existing = db.select().from(plugin).where(eq(plugin.name, name)).all()[0]
  if (!existing) return false
  db.delete(plugin).where(eq(plugin.id, existing.id)).run()
  return true
}
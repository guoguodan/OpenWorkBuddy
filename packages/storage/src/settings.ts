import { and, eq } from 'drizzle-orm'
import type { AppDatabase } from './client.js'
import { nowIso } from './ids.js'
import { workspaceSetting } from './schema.js'

/**
 * 工作区设置仓储。
 *
 * 只存"用户显式选择"的偏好:权限档位、默认运行位置、模型。默认值不落库,
 * 读取时兜底,这样升级后新增开关不会把老库写成半套配置。
 */
export const SETTING_KEYS = [
  'permissionMode',
  'taskTarget',
  'model',
  'disabledSkills',
  'pinnedSkills'
] as const
export type SettingKey = (typeof SETTING_KEYS)[number]

export type PermissionMode = 'default' | 'fullAccess' | 'readOnly'

export interface WorkspaceSettings {
  permissionMode: PermissionMode
  taskTarget: 'local'
  model: string | null
  /** 已关闭自动触发的技能名;仅存显式关闭项,默认开启不落库。 */
  disabledSkills: string[]
  /** 已置顶技能名;排序只影响展示,不影响运行。 */
  pinnedSkills: string[]
}

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  permissionMode: 'default',
  taskTarget: 'local',
  model: null,
  disabledSkills: [],
  pinnedSkills: []
}

function parseNameList(raw: string | undefined, sort = false): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const unique = [
      ...new Set(parsed.filter((name): name is string => typeof name === 'string' && name.trim().length > 0))
    ].map((name) => name.trim())
    // 顺序只有置顶列表有语义;禁用集合要排序,保证持久化结果稳定。
    return sort ? unique.sort() : unique
  } catch {
    // 手工改坏的值不应让整个设置读取失败;按"全部开启"兜底。
    return []
  }
}

export function getWorkspaceSettings(db: AppDatabase, workspaceId: string): WorkspaceSettings {
  const rows = db
    .select()
    .from(workspaceSetting)
    .where(eq(workspaceSetting.workspaceId, workspaceId))
    .all()
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const rawPermission = map.get('permissionMode')
  const permissionMode: PermissionMode =
    rawPermission === 'fullAccess' || rawPermission === 'readOnly' ? rawPermission : 'default'
  return {
    permissionMode,
    taskTarget: 'local',
    model: map.get('model') ?? null,
    disabledSkills: parseNameList(map.get('disabledSkills'), true),
    pinnedSkills: parseNameList(map.get('pinnedSkills'))
  }
}

export function setWorkspaceSetting(
  db: AppDatabase,
  workspaceId: string,
  key: SettingKey,
  value: string | null
): WorkspaceSettings {
  if (value === null || value === '') {
    db.delete(workspaceSetting)
      .where(and(eq(workspaceSetting.workspaceId, workspaceId), eq(workspaceSetting.key, key)))
      .run()
  } else {
    const at = nowIso()
    db.insert(workspaceSetting)
      .values({ workspaceId, key, value, updatedAt: at })
      .onConflictDoUpdate({
        target: [workspaceSetting.workspaceId, workspaceSetting.key],
        set: { value, updatedAt: at }
      })
      .run()
  }
  return getWorkspaceSettings(db, workspaceId)
}

/** 关闭的技能名会原样写入工作区设置;空集合删除该行,回到默认全开。 */
export function setDisabledSkills(
  db: AppDatabase,
  workspaceId: string,
  names: string[]
): WorkspaceSettings {
  const unique = [...new Set(names.filter((name) => typeof name === 'string' && name.trim().length > 0))]
    .map((name) => name.trim())
    .sort()
  return setWorkspaceSetting(
    db,
    workspaceId,
    'disabledSkills',
    unique.length > 0 ? JSON.stringify(unique) : null
  )
}

export function setPinnedSkills(
  db: AppDatabase,
  workspaceId: string,
  names: string[]
): WorkspaceSettings {
  const unique = [...new Set(names.filter((name) => typeof name === 'string' && name.trim().length > 0))]
    .map((name) => name.trim())
  return setWorkspaceSetting(
    db,
    workspaceId,
    'pinnedSkills',
    unique.length > 0 ? JSON.stringify(unique) : null
  )
}


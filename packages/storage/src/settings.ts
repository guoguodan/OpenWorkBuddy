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
export const SETTING_KEYS = ['permissionMode', 'taskTarget', 'model'] as const
export type SettingKey = (typeof SETTING_KEYS)[number]

export type PermissionMode = 'default' | 'fullAccess' | 'readOnly'

export interface WorkspaceSettings {
  permissionMode: PermissionMode
  taskTarget: 'local'
  model: string | null
}

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  permissionMode: 'default',
  taskTarget: 'local',
  model: null
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
    model: map.get('model') ?? null
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


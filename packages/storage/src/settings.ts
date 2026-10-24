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
  'fallbackModel',
  'reasoningEffort',
  'tokenBudget',
  'disabledSkills',
  'pinnedSkills'
] as const
export type SettingKey = (typeof SETTING_KEYS)[number]

export type PermissionMode = 'default' | 'fullAccess' | 'readOnly'

/**
 * 思考强度档位。
 *
 * 只有用户显式选择才落库;空值表示"不干预",由模型/网关使用自身默认值。
 * 这与真实产品的"自定义 高"一致:显示当前生效档位,但不伪造模型能力。
 */
export type ReasoningEffort = 'low' | 'medium' | 'high'

export interface WorkspaceSettings {
  permissionMode: PermissionMode
  taskTarget: 'local'
  model: string | null
  /** 主模型连续失败且尚未产生输出时使用的备用模型;为空表示不启用降级。 */
  fallbackModel: string | null
  /** 本轮思考强度;null 表示不向网关显式传参。 */
  reasoningEffort: ReasoningEffort | null
  /** 单轮 token 硬上限(输入+输出)。0 表示不限制;超限后停止继续调用模型。 */
  tokenBudget: number
  /** 已关闭自动触发的技能名;仅存显式关闭项,默认开启不落库。 */
  disabledSkills: string[]
  /** 已置顶技能名;排序只影响展示,不影响运行。 */
  pinnedSkills: string[]
}

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  permissionMode: 'default',
  taskTarget: 'local',
  model: null,
  fallbackModel: null,
  reasoningEffort: null,
  tokenBudget: 0,
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
    fallbackModel: map.get('fallbackModel') ?? null,
    reasoningEffort: parseReasoningEffort(map.get('reasoningEffort')),
    tokenBudget: parseTokenBudget(map.get('tokenBudget')),
    disabledSkills: parseNameList(map.get('disabledSkills'), true),
    pinnedSkills: parseNameList(map.get('pinnedSkills'))
  }
}

/**
 * 预算来自可手改的本地设置,必须收敛成非负整数。
 * 非法/负值按"不限"处理,不能在运行中把上限误读成 0 而拒绝一切请求。
 */
export function parseTokenBudget(raw: string | null | undefined): number {
  if (!raw) return 0
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.trunc(value)
}

/** 手改的档位值必须收敛到受支持集合,不能让任意字符串进入请求体。 */
export function parseReasoningEffort(raw: string | null | undefined): ReasoningEffort | null {
  return raw === 'low' || raw === 'medium' || raw === 'high' ? raw : null
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


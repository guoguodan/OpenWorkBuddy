import { eq } from 'drizzle-orm'
import type { AppDatabase } from './client.js'
import { nowIso } from './ids.js'
import { serviceConnection } from './schema.js'

export type ServiceProvider = 'mailbox' | 'tencentDocs' | 'ima' | 'lexiang'
export type ServiceStatus = 'not_connected' | 'connecting' | 'connected' | 'error'

export interface ServiceConnectionRecord {
  provider: ServiceProvider
  status: ServiceStatus
  endpoint: string | null
  account: string | null
  lastError: string | null
  lastCheckedAt: string | null
  createdAt: string
  updatedAt: string
}

export const SERVICE_PROVIDERS: ServiceProvider[] = ['mailbox', 'tencentDocs', 'ima', 'lexiang']

export function isServiceProvider(value: unknown): value is ServiceProvider {
  return typeof value === 'string' && (SERVICE_PROVIDERS as string[]).includes(value)
}

/**
 * 只保留 origin,避免把 OAuth token / 签名 query 持久化到数据库。
 * 无法解析的地址一律判为无效,不让它进入"已连接"状态。
 */
export function sanitizeEndpoint(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}

function mapRow(
  provider: ServiceProvider,
  row: typeof serviceConnection.$inferSelect
): ServiceConnectionRecord {
  return {
    provider,
    status: row.status,
    endpoint: row.endpoint,
    account: row.account,
    lastError: row.lastError,
    lastCheckedAt: row.lastCheckedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

export function getConnection(
  db: AppDatabase,
  workspaceId: string,
  provider: ServiceProvider
): ServiceConnectionRecord | undefined {
  const row = db
    .select()
    .from(serviceConnection)
    .where(eq(serviceConnection.workspaceId, workspaceId))
    .all()
    .find((item) => item.provider === provider)
  return row ? mapRow(provider, row) : undefined
}

/** 未配置过的服务返回 not_connected,而不是 undefined:界面无需区分"没记录"和"没连接"。 */
export function listConnections(db: AppDatabase, workspaceId: string): ServiceConnectionRecord[] {
  const rows = db
    .select()
    .from(serviceConnection)
    .where(eq(serviceConnection.workspaceId, workspaceId))
    .all()
  return SERVICE_PROVIDERS.map((provider) => {
    const row = rows.find((item) => item.provider === provider)
    return row
      ? mapRow(provider, row)
      : {
          provider,
          status: 'not_connected' as const,
          endpoint: null,
          account: null,
          lastError: null,
          lastCheckedAt: null,
          createdAt: '',
          updatedAt: ''
        }
  })
}

export interface ConnectionPatch {
  workspaceId: string
  provider: ServiceProvider
  status: ServiceStatus
  endpoint?: string | null
  account?: string | null
  lastError?: string | null
  check?: boolean
}

/**
 * upsert 一条连接状态。
 *
 * 约束:status=connected 必须带有效 endpoint,否则降级为 error。
 * 这条规则在存储层而非 UI 层,任何调用方都无法伪造"已连接"。
 */
export function setConnection(db: AppDatabase, patch: ConnectionPatch): ServiceConnectionRecord {
  const existing = getConnection(db, patch.workspaceId, patch.provider)
  const at = nowIso()
  const endpoint =
    patch.endpoint !== undefined ? sanitizeEndpoint(patch.endpoint) : (existing?.endpoint ?? null)
  const status: ServiceStatus =
    patch.status === 'connected' && !endpoint ? 'error' : patch.status
  const row: typeof serviceConnection.$inferInsert = {
    workspaceId: patch.workspaceId,
    provider: patch.provider,
    status,
    endpoint,
    account: patch.account !== undefined ? patch.account : (existing?.account ?? null),
    lastError:
      status === 'error' && !patch.lastError && patch.status === 'connected'
        ? '连接地址无效'
        : (patch.lastError !== undefined ? patch.lastError : (existing?.lastError ?? null)),
    lastCheckedAt: patch.check ? at : (existing?.lastCheckedAt ?? null),
    createdAt: existing?.createdAt || at,
    updatedAt: at
  }
  db.insert(serviceConnection)
    .values(row)
    .onConflictDoUpdate({
      target: [serviceConnection.workspaceId, serviceConnection.provider],
      set: {
        status: row.status,
        endpoint: row.endpoint,
        account: row.account,
        lastError: row.lastError,
        lastCheckedAt: row.lastCheckedAt,
        updatedAt: row.updatedAt
      }
    })
    .run()
  return getConnection(db, patch.workspaceId, patch.provider)!
}

export function disconnectService(
  db: AppDatabase,
  workspaceId: string,
  provider: ServiceProvider
): ServiceConnectionRecord {
  return setConnection(db, {
    workspaceId,
    provider,
    status: 'not_connected',
    endpoint: null,
    account: null,
    lastError: null,
    check: true
  })
}

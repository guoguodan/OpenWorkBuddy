export interface StoredGrant {
  groupKey: string
  toolName: string
  grantedAt: string
  expiresAt: string | null
}

export interface SessionGrantStore {
  has(conversationId: string, groupKey: string): boolean
  add(conversationId: string, groupKey: string): void
}

export interface PersistentGrantStore {
  has(groupKey: string, now: Date): boolean | Promise<boolean>
  add(groupKey: string, toolName: string, expiresAt: string): void | Promise<void>
}

export class InMemorySessionGrants implements SessionGrantStore {
  private readonly keys = new Set<string>()

  has(conversationId: string, groupKey: string): boolean {
    return this.keys.has(`${conversationId}\u0000${groupKey}`)
  }

  add(conversationId: string, groupKey: string): void {
    this.keys.add(`${conversationId}\u0000${groupKey}`)
  }

  clear(): void {
    this.keys.clear()
  }
}

export class MemoryPersistentGrants implements PersistentGrantStore {
  private readonly grants = new Map<string, StoredGrant>()

  has(groupKey: string, now: Date): boolean {
    const grant = this.grants.get(groupKey)
    if (!grant) return false
    if (!grant.expiresAt) return true
    return new Date(grant.expiresAt).getTime() > now.getTime()
  }

  add(groupKey: string, toolName: string, expiresAt: string): void {
    this.grants.set(groupKey, {
      groupKey,
      toolName,
      grantedAt: new Date().toISOString(),
      expiresAt
    })
  }

  delete(groupKey: string): void {
    this.grants.delete(groupKey)
  }
}

/** 默认 30 天;非法值回落 30,避免配置错误把授权变成永久 */
export function approvalExpiry(now: Date, ttlDays = 30): string {
  const days = Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 30
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString()
}

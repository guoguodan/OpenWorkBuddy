import type { MoreEntry } from './Sidebar'

export type PrimaryMenuId = 'colleagues' | 'skills' | 'automation' | 'library'
export type DiscoverMenuId = MoreEntry

export interface CustomNavItem {
  id: string
  label: string
  fixed?: boolean
}

export interface CustomMenuSection {
  id: 'primary' | 'discover'
  title: string
  emptyLabel: string
  items: CustomNavItem[]
}

export interface CustomMenuLayout {
  version: 1
  sections: CustomMenuSection[]
}

export const CUSTOM_MENU_STORAGE_KEY = 'owb.sidebar.custom-menu.v1'

/** 一级菜单的固定入口:只负责打开"发现"菜单,不允许被拖走。 */
export const MORE_ITEM: CustomNavItem = { id: 'more', label: '更多', fixed: true }

export const PRIMARY_META: Array<{ id: PrimaryMenuId; label: string }> = [
  { id: 'colleagues', label: '助理' },
  { id: 'skills', label: '专家·技能·连接器' },
  { id: 'automation', label: '定时任务' },
  { id: 'library', label: '资料库' }
]

export const DISCOVER_META: Array<{ id: DiscoverMenuId; label: string }> = [
  { id: 'projects', label: '项目' },
  { id: 'mailbox', label: '我的邮箱' },
  { id: 'tencentDocs', label: '腾讯文档' },
  { id: 'ima', label: 'ima' },
  { id: 'lexiang', label: '乐享知识库' },
  { id: 'inspiration', label: '灵感社区' }
]

const ALL_CONFIGURABLE = [...PRIMARY_META, ...DISCOVER_META]

function metaLabel(id: string): string | null {
  const found = ALL_CONFIGURABLE.find((item) => item.id === id)
  return found?.label ?? null
}

function idsOnly(items: CustomNavItem[]): string[] {
  return items.map((item) => item.id)
}

/**
 * 归一化布局。
 *
 * 存储里可能来自旧版本、手工修改或损坏数据。这里不信任任何 id:
 * 未知项丢弃、重复项只保留第一次、缺失项补回默认位置,
 * 并强制"更多"留在一级菜单末尾,避免 UI 打开一个不存在的分组。
 */
export function normalizeCustomMenuLayout(raw: unknown): CustomMenuLayout {
  const parsed = raw as { version?: unknown; sections?: unknown } | null
  const source = Array.isArray(parsed?.sections) ? parsed!.sections : []
  const bySection = new Map<string, unknown>()
  for (const section of source) {
    if (!section || typeof section !== 'object') continue
    const record = section as { id?: unknown; items?: unknown }
    if ((record.id === 'primary' || record.id === 'discover') && Array.isArray(record.items)) {
      bySection.set(record.id, record.items)
    }
  }

  const seen = new Set<string>()
  const readIds = (sectionId: string): string[] => {
    const list = bySection.get(sectionId)
    if (!Array.isArray(list)) return []
    const out: string[] = []
    for (const entry of list) {
      const id = typeof entry === 'string' ? entry : (entry as { id?: unknown } | null)?.id
      if (typeof id !== 'string' || id === 'more') continue
      if (!metaLabel(id) || seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
    return out
  }

  const primaryIds = readIds('primary')
  const discoverIds = readIds('discover')
  if (bySection.size === 0) {
    primaryIds.push(...PRIMARY_META.map((item) => item.id))
    discoverIds.push(...DISCOVER_META.map((item) => item.id))
    for (const id of [...primaryIds, ...discoverIds]) seen.add(id)
  } else {
    // 缺失项按默认分组补回,已移动的项不会被重复补。
    for (const item of PRIMARY_META) {
      if (!seen.has(item.id)) {
        primaryIds.push(item.id)
        seen.add(item.id)
      }
    }
    for (const item of DISCOVER_META) {
      if (!seen.has(item.id)) {
        discoverIds.push(item.id)
        seen.add(item.id)
      }
    }
  }

  return {
    version: 1,
    sections: [
      {
        id: 'primary',
        title: '一级菜单',
        emptyLabel: '暂无内容，可把常用功能拖到这里',
        items: [
          ...primaryIds.map((id) => ({ id, label: metaLabel(id)! })),
          MORE_ITEM
        ]
      },
      {
        id: 'discover',
        title: '发现',
        emptyLabel: '暂无内容，可将不常用的菜单功能移动到"发现"下',
        items: discoverIds.map((id) => ({ id, label: metaLabel(id)! }))
      }
    ]
  }
}

export function defaultCustomMenuLayout(): CustomMenuLayout {
  return normalizeCustomMenuLayout(null)
}

export function readCustomMenuLayout(): CustomMenuLayout {
  try {
    const raw = localStorage.getItem(CUSTOM_MENU_STORAGE_KEY)
    if (!raw) return defaultCustomMenuLayout()
    return normalizeCustomMenuLayout(JSON.parse(raw))
  } catch {
    return defaultCustomMenuLayout()
  }
}

export function saveCustomMenuLayout(layout: CustomMenuLayout): void {
  try {
    localStorage.setItem(CUSTOM_MENU_STORAGE_KEY, JSON.stringify({ version: 1, sections: layout.sections }))
  } catch {
    // 存储不可用时不阻断使用:本次会话内的顺序仍然生效。
  }
}

function findItem(layout: CustomMenuLayout, id: string): CustomMenuSection | null {
  return layout.sections.find((section) => section.items.some((item) => item.id === id)) ?? null
}

/**
 * 移动一个可拖拽项。
 *
 * "更多"是固定项,天然是分区的右边界:任何落到它之后的请求都夹到它之前,
 * 这样拖拽不会把固定入口挤出可视区域。
 */
export function moveCustomMenuItem(
  layout: CustomMenuLayout,
  activeId: string,
  targetGroupId: 'primary' | 'discover',
  targetIndex: number
): CustomMenuLayout | null {
  const source = findItem(layout, activeId)
  const active = source?.items.find((item) => item.id === activeId)
  if (!source || !active || active.fixed) return null
  const target = layout.sections.find((section) => section.id === targetGroupId)
  if (!target) return null

  const next: CustomMenuLayout = {
    version: 1,
    sections: layout.sections.map((section) => ({
      ...section,
      items: section.items.map((item) => ({ ...item }))
    }))
  }
  const from = next.sections.find((section) => section.id === source.id)!
  const to = next.sections.find((section) => section.id === targetGroupId)!
  from.items = from.items.filter((item) => item.id !== activeId)

  const separable = to.items.filter((item) => !item.fixed).length
  const clamped = Math.max(0, Math.min(Math.floor(targetIndex), separable))
  const movableIndexes = to.items
    .map((item, index) => (item.fixed ? -1 : index))
    .filter((index) => index >= 0)
  const insertAt = clamped < movableIndexes.length ? movableIndexes[clamped]! : (movableIndexes.at(-1) ?? -1) + 1
  const safeIndex = insertAt < 0 ? to.items.length : insertAt
  to.items.splice(safeIndex, 0, { id: active.id, label: active.label })
  return next
}

/** 键盘换位:保持分区边界,固定项不参与。 */
export function nudgeCustomMenuItem(
  layout: CustomMenuLayout,
  id: string,
  delta: -1 | 1
): CustomMenuLayout | null {
  const section = findItem(layout, id)
  if (!section) return null
  const movable = section.items.filter((item) => !item.fixed)
  const index = movable.findIndex((item) => item.id === id)
  if (index < 0) return null
  const nextIndex = index + delta
  if (nextIndex < 0 || nextIndex >= movable.length) return null
  return moveCustomMenuItem(layout, id, section.id, nextIndex)
}

export function splitCustomMenu(layout: CustomMenuLayout): {
  primary: CustomNavItem[]
  discover: CustomNavItem[]
} {
  const primary = layout.sections.find((section) => section.id === 'primary')
  const discover = layout.sections.find((section) => section.id === 'discover')
  return {
    primary: (primary?.items ?? []).filter((item) => item.id !== MORE_ITEM.id),
    discover: discover?.items ?? []
  }
}

export function customMenuIds(layout: CustomMenuLayout): { primary: string[]; discover: string[] } {
  const { primary, discover } = splitCustomMenu(layout)
  return { primary: idsOnly(primary), discover: idsOnly(discover) }
}
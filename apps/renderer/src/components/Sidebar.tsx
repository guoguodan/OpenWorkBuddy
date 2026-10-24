import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TaskFilterState } from './TopBar'
import {
  IconBell,
  IconBook,
  IconBriefcase,
  IconBulb,
  IconChat,
  IconChevron,
  IconClock,
  IconFolder,
  IconGrid,
  IconMail,
  IconPin,
  IconPlus,
  IconTool
} from './Icons'
import brandIcon from '../assets/brand-icon.svg'

export interface ConversationSummary {
  id: string
  title: string
  modeId: string
  colleagueId?: string | null
  colleagueName?: string | null
  pinnedAt?: string | null
  pinOrder?: number | null
  channelId?: string | null
  channelName?: string | null
  projectId?: string | null
  projectName?: string | null
  updatedAt: string
  lastSeq: number
  messageCount?: number
  taskTotal?: number
  pending?: number
  running?: number
  failed?: number
  done?: number
  artifacts?: number
  status?: 'active' | 'archived'
}

export type MoreEntry =
  | 'projects'
  | 'mailbox'
  | 'tencentDocs'
  | 'ima'
  | 'lexiang'
  | 'inspiration'

const SECTION_STATE_KEY = 'owb.sidebar.sections.v1'
const DEFAULT_VISIBLE = 5
const VISIBLE_STEP = 20

type SectionId = 'pinned' | 'tasks' | 'workspaces' | 'colleagues'

interface SectionState {
  collapsed: Record<SectionId, boolean>
  visible: Record<SectionId, number>
  collapsedGroups: Record<string, boolean>
}

function readSectionState(): SectionState {
  const empty: SectionState = {
    collapsed: { pinned: false, tasks: false, workspaces: false, colleagues: false },
    visible: { pinned: DEFAULT_VISIBLE, tasks: DEFAULT_VISIBLE, workspaces: DEFAULT_VISIBLE, colleagues: DEFAULT_VISIBLE },
    collapsedGroups: {}
  }
  try {
    const raw = localStorage.getItem(SECTION_STATE_KEY)
    if (!raw) return empty
    const parsed = JSON.parse(raw) as Partial<SectionState>
    return {
      collapsed: { ...empty.collapsed, ...(parsed.collapsed ?? {}) },
      visible: { ...empty.visible, ...(parsed.visible ?? {}) },
      collapsedGroups: parsed.collapsedGroups ?? {}
    }
  } catch {
    return empty
  }
}

interface SidebarProps {
  conversations: ConversationSummary[]
  activeId: string
  busy: boolean
  collapsed: boolean
  onToggleCollapse: () => void
  onNew: () => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onPin: (id: string, pinned: boolean) => void
  onReorderPinned: (orderedIds: string[]) => void
  onRename: (id: string, title: string) => void
  onOpenColleagues: () => void
  onOpenSkills: () => void
  onOpenAutomation: () => void
  onOpenLibrary: () => void
  onOpenMessages: () => void
  unreadMessages: number
  onOpenActivity: () => void
  onOpenSupport: () => void
  onOpenMore: (entry: MoreEntry) => void
  onOpenAccount: () => void
  filter: TaskFilterState
  onOpenFilter: () => void
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/**
 * 判断一个会话是否命中筛选条件。
 *
 * 状态来自 task/artifact 的真实汇总:
 *   进行中 = 有 running 任务
 *   待处理 = 没有 running 但存在未开始的 pending 任务
 *   规划中 = 任务从未真正启动(没有 task 行),仍处于草稿阶段
 *   已完成 = 至少完成过一个任务;失败 = 存在 failed 任务
 * 多选状态是"任一命中",与真实产品的多选语义一致。
 */
export function matchesTaskFilter(c: ConversationSummary, filter: TaskFilterState): boolean {
  if (filter.sessionStatus.length > 0) {
    const total = c.taskTotal ?? 0
    const completed = (c.done ?? 0) > 0
    const hit = filter.sessionStatus.some((status) => {
      if (status === 'working') return (c.running ?? 0) > 0
      if (status === 'failed') return (c.failed ?? 0) > 0
      if (status === 'completed') return completed
      if (status === 'pending') return (c.pending ?? 0) > 0
      return total === 0 && (c.messageCount ?? 0) === 0
    })
    if (!hit) return false
  }

  if (filter.date) {
    const time = Date.parse(c.updatedAt)
    if (!Number.isFinite(time)) return false
    const now = new Date()
    if (filter.date === 'today') return time >= startOfDay(now)
    if (filter.date === 'last7days') return time >= startOfDay(now) - 6 * 86_400_000
    return time >= startOfDay(now) - 29 * 86_400_000
  }
  return true
}

function dayLabel(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  return `${sameYear ? '' : `${d.getFullYear()}年`}${d.getMonth() + 1}月${d.getDate()}日`
}

const MORE_ITEMS: Array<{ id: MoreEntry; label: string; icon: typeof IconGrid; beta?: boolean; hint?: string }> = [
  { id: 'projects', label: '项目', icon: IconGrid, beta: true },
  { id: 'mailbox', label: '我的邮箱', icon: IconMail },
  { id: 'tencentDocs', label: '腾讯文档', icon: IconBook },
  { id: 'ima', label: 'ima', icon: IconBook },
  { id: 'lexiang', label: '乐享知识库', icon: IconBook },
  { id: 'inspiration', label: '灵感社区', icon: IconBulb }
]

/**
 * 侧栏与真实产品保持同一信息层级:
 *  品牌/发现应用 → 主导航(新建任务/助理/专家·技能·连接器/定时任务/资料库/更多)
 *  → 任务列表(按日期) → 积分卡片 → 账号栏。
 */
export function Sidebar({
  conversations,
  activeId,
  busy,
  collapsed,
  onToggleCollapse,
  onNew,
  onSelect,
  onDelete,
  onPin,
  onReorderPinned,
  onRename,
  onOpenColleagues,
  onOpenSkills,
  onOpenAutomation,
  onOpenLibrary,
  onOpenMessages,
  unreadMessages,
  onOpenActivity,
  onOpenSupport,
  onOpenMore,
  onOpenAccount,
  filter,
  onOpenFilter
}: SidebarProps) {
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  const [sectionState, setSectionState] = useState<SectionState>(readSectionState)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const renameRef = useRef<HTMLInputElement>(null)
  const [taskListOpen, setTaskListOpen] = useState(false)
  const taskListTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  // dragstart 与 dragover/drop 可能在同一轮事件里连续派发,state 尚未提交,
  // 因此真实来源以 ref 为准;state 只负责视觉反馈。
  const dragIdRef = useRef<string | null>(null)
  // 拖拽结束后浏览器仍会派发一次 click:用时间窗抑制,避免排序顺手切换任务。
  const lastDragEnd = useRef(0)

  // 真实产品在折叠侧栏中始终保留"任务列表"入口;悬停打开,离开稍延迟关闭。
  const openTaskList = () => {
    if (taskListTimer.current) clearTimeout(taskListTimer.current)
    setTaskListOpen(true)
  }
  const closeTaskListSoon = () => {
    if (taskListTimer.current) clearTimeout(taskListTimer.current)
    taskListTimer.current = setTimeout(() => setTaskListOpen(false), 150)
  }

  useEffect(() => () => {
    if (taskListTimer.current) clearTimeout(taskListTimer.current)
  }, [])

  useEffect(() => {
    localStorage.setItem(SECTION_STATE_KEY, JSON.stringify(sectionState))
  }, [sectionState])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.owb-conv-menu')) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  useEffect(() => {
    if (renaming) renameRef.current?.focus()
  }, [renaming])

  const toggleSection = useCallback((id: SectionId) => {
    setSectionState((s) => ({ ...s, collapsed: { ...s.collapsed, [id]: !s.collapsed[id] } }))
  }, [])

  const showMore = useCallback((id: SectionId) => {
    setSectionState((s) => ({ ...s, visible: { ...s.visible, [id]: s.visible[id] + VISIBLE_STEP } }))
  }, [])

  const showLess = useCallback((id: SectionId) => {
    setSectionState((s) => ({ ...s, visible: { ...s.visible, [id]: DEFAULT_VISIBLE } }))
  }, [])

  const toggleGroup = useCallback((key: string) => {
    setSectionState((s) => ({
      ...s,
      collapsedGroups: { ...s.collapsedGroups, [key]: !s.collapsedGroups[key] }
    }))
  }, [])

  const grouped = useMemo(() => {
    const pinned: ConversationSummary[] = []
    const tasks: ConversationSummary[] = []
    const workspaces = new Map<string, ConversationSummary[]>()
    const colleagues = new Map<string, ConversationSummary[]>()

    // 筛选只作用于列表视图,不改变数据本身。四项分组都必须使用同一份过滤结果,
    // 否则会出现"任务为空但工作空间里还挂着被筛掉的任务"这种不一致。
    const filtered = conversations.filter((c) => matchesTaskFilter(c, filter))

    for (const c of filtered) {
      if (c.pinnedAt) {
        pinned.push(c)
        continue
      }
      if (c.colleagueId || c.colleagueName) {
        const key = c.colleagueId ?? c.colleagueName ?? 'unknown'
        colleagues.set(key, [...(colleagues.get(key) ?? []), c])
        continue
      }
      if (c.channelId) {
        const key = c.channelId
        workspaces.set(key, [...(workspaces.get(key) ?? []), c])
        continue
      }
      tasks.push(c)
    }

    // 置顶组按写入的 pinOrder 排;历史数据没有序号时退回置顶时间,保证稳定。
    pinned.sort((a, b) => {
      const ao = a.pinOrder ?? Number.MAX_SAFE_INTEGER
      const bo = b.pinOrder ?? Number.MAX_SAFE_INTEGER
      if (ao !== bo) return ao - bo
      return (a.pinnedAt ?? '').localeCompare(b.pinnedAt ?? '')
    })

    return {
      pinned,
      tasks,
      filtered,
      workspaces: Array.from(workspaces.entries()).map(([key, list]) => ({
        key,
        title: list[0]?.channelName ?? '未命名工作空间',
        conversations: list
      })),
      colleagues: Array.from(colleagues.entries()).map(([key, list]) => ({
        key,
        title: list[0]?.colleagueName ?? '助理',
        conversations: list
      }))
    }
  }, [conversations, filter])

  const submitRename = (id: string) => {
    const next = renaming?.value.trim() ?? ''
    if (next) onRename(id, next)
    setRenaming(null)
  }

  const dropPinned = (targetId: string) => {
    const source = dragIdRef.current
    dragIdRef.current = null
    setDragId(null)
    setDragOverId(null)
    lastDragEnd.current = Date.now()
    if (!source || source === targetId) return
    // 排序提交必须覆盖全部置顶任务;当前筛选可能只显示一部分。
    const ids = conversations
      .filter((item) => item.pinnedAt)
      .sort((a, b) => {
        const ao = a.pinOrder ?? Number.MAX_SAFE_INTEGER
        const bo = b.pinOrder ?? Number.MAX_SAFE_INTEGER
        if (ao !== bo) return ao - bo
        return (a.pinnedAt ?? '').localeCompare(b.pinnedAt ?? '')
      })
      .map((item) => item.id)
    const from = ids.indexOf(source)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0) return
    ids.splice(to, 0, ids.splice(from, 1)[0]!)
    onReorderPinned(ids)
  }

  const renderItem = (c: ConversationSummary, pinned = false) => (
    <div
      key={c.id}
      className={`owb-conv-item${c.id === activeId ? ' owb-conv-item--active' : ''}${
        dragId === c.id ? ' owb-conv-item--dragging' : ''
      }${dragOverId === c.id ? ' owb-conv-item--drop-target' : ''}`}
      data-testid="conversation-item"
      data-conversation-id={c.id}
      data-pinned={c.pinnedAt ? '1' : '0'}
      draggable={Boolean(c.pinnedAt) && !renaming}
      onDragStart={(e) => {
        if (!c.pinnedAt) return
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', c.id)
        dragIdRef.current = c.id
        setDragId(c.id)
      }}
      onDragOver={(e) => {
        if (!c.pinnedAt || !dragIdRef.current || dragIdRef.current === c.id) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDragOverId(c.id)
      }}
      onDragLeave={() => setDragOverId((current) => (current === c.id ? null : current))}
      onDrop={(e) => {
        if (!c.pinnedAt) return
        e.preventDefault()
        dropPinned(c.id)
      }}
      onDragEnd={() => {
        dragIdRef.current = null
        setDragId(null)
        setDragOverId(null)
        lastDragEnd.current = Date.now()
      }}
      onClick={() => {
        if (Date.now() - lastDragEnd.current < 250) return
        if (!busy && c.id !== activeId) onSelect(c.id)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ id: c.id, x: e.clientX, y: e.clientY })
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !busy && c.id !== activeId) onSelect(c.id)
      }}
    >
      {renaming?.id === c.id ? (
        <input
          ref={renameRef}
          className="owb-conv-item__rename"
          data-testid="conversation-rename-input"
          value={renaming.value}
          maxLength={200}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setRenaming({ id: c.id, value: e.target.value })}
          onBlur={() => setRenaming(null)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') submitRename(c.id)
            if (e.key === 'Escape') setRenaming(null)
          }}
        />
      ) : (
        <>
          <span className="owb-conv-item__title" title={c.title}>
            {pinned || c.pinnedAt ? <IconPin size={12} className="owb-conv-item__pin" /> : null}
            {c.title}
            {c.channelName ? <span className="owb-conv-item__channel">#{c.channelName}</span> : null}
            {c.projectName ? (
              <span className="owb-conv-item__project" title={`所属项目：${c.projectName}`}>
                <IconFolder size={11} />
                {c.projectName}
              </span>
            ) : null}
          </span>
          <span className="owb-conv-item__meta">{dayLabel(c.updatedAt)}</span>
        </>
      )}
    </div>
  )

  const renderSection = (
    id: SectionId,
    label: string,
    items: ConversationSummary[],
    options: { pinned?: boolean; key?: string } = {}
  ) => {
    if (items.length === 0) return null
    const collapsed = options.key
      ? Boolean(sectionState.collapsedGroups[options.key])
      : sectionState.collapsed[id]
    const visible = sectionState.visible[id]
    const shown = items.slice(0, visible)
    const remaining = items.length - shown.length
    return (
      <div className={`owb-sidebar__group${options.key ? ' owb-sidebar__group--sub' : ''}`} key={options.key ?? id}>
        <button
          className="owb-sidebar__section"
          data-testid={options.key ? 'conversation-subsection' : `section-${id}`}
          aria-expanded={!collapsed}
          onClick={() => (options.key ? toggleGroup(options.key) : toggleSection(id))}
        >
          <span className={`owb-sidebar__chevron${collapsed ? '' : ' owb-sidebar__chevron--open'}`}>
            <IconChevron size={12} />
          </span>
          <span>{label} ({items.length})</span>
        </button>
        {collapsed ? null : (
          <div className="owb-sidebar__list">
            {shown.map((c) => renderItem(c, options.pinned))}
            {remaining > 0 || visible > DEFAULT_VISIBLE ? (
              <div className="owb-sidebar__more-row">
                {remaining > 0 ? (
                  <button className="owb-sidebar__more" data-testid="section-show-more" onClick={() => showMore(id)}>
                    查看更多 ({remaining})
                  </button>
                ) : null}
                {visible > DEFAULT_VISIBLE ? (
                  <button className="owb-sidebar__more" data-testid="section-show-less" onClick={() => showLess(id)}>
                    收起
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
    )
  }

  const menuConversation = menu ? conversations.find((c) => c.id === menu.id) : null

  useEffect(() => {
    if (!moreOpen) return
    const onDown = (e: MouseEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [moreOpen])

  return (
    <aside className={`owb-sidebar${collapsed ? ' owb-sidebar--collapsed' : ''}`} data-testid="sidebar">
      <div className="owb-sidebar__brand">
        <button className="owb-brand-mark" onClick={onToggleCollapse} title={collapsed ? '展开侧边栏' : '收起侧边栏'} aria-label="切换侧边栏">
          <img src={brandIcon} alt="" aria-hidden="true" />
        </button>
        <div className="owb-brand-text">
          <div className="owb-brand-title">OpenWorkBuddy</div>
          <div className="owb-brand-sub">V0.0.1</div>
        </div>
        <button className="owb-discover" onClick={onOpenSkills} title="发现应用">
          <IconGrid size={14} />
          <span>发现应用</span>
          <IconChevron size={12} />
        </button>
      </div>

      <nav className="owb-sidebar__nav" aria-label="主导航">
        <button className="owb-nav-item owb-nav-item--primary" onClick={onNew} disabled={busy} data-testid="new-task">
          <IconPlus size={17} />
          <span className="owb-nav-item__label">新建任务</span>
        </button>
        <button className="owb-nav-item" onClick={onOpenColleagues} data-testid="open-colleagues">
          <IconBriefcase size={17} />
          <span className="owb-nav-item__label">助理</span>
          <span className="owb-nav-beta">BETA</span>
        </button>
        <button className="owb-nav-item" onClick={onOpenSkills} data-testid="open-skills">
          <IconTool size={17} />
          <span className="owb-nav-item__label">专家·技能·连接器</span>
        </button>
        <button className="owb-nav-item" onClick={onOpenAutomation} data-testid="open-automation">
          <IconClock size={17} />
          <span className="owb-nav-item__label">定时任务</span>
        </button>
        <button className="owb-nav-item" onClick={onOpenLibrary} data-testid="open-library">
          <IconBook size={17} />
          <span className="owb-nav-item__label">资料库</span>
        </button>
        <div className="owb-more" ref={moreRef}>
          <button
            className={`owb-nav-item${moreOpen ? ' owb-nav-item--open' : ''}`}
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            data-testid="open-more"
          >
            <IconGrid size={17} />
            <span className="owb-nav-item__label">更多</span>
            <span className="owb-nav-hint">灵感</span>
          </button>
          {moreOpen ? (
            <div className="owb-more__menu" role="menu">
              {MORE_ITEMS.map((item) => (
                <button
                  key={item.id}
                  role="menuitem"
                  className="owb-more__item"
                  onClick={() => {
                    setMoreOpen(false)
                    onOpenMore(item.id)
                  }}
                >
                  <item.icon size={16} />
                  <span>{item.label}</span>
                  {item.beta ? <span className="owb-nav-beta">BETA</span> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </nav>

      <div className="owb-sidebar__sections">
        {collapsed && conversations.length > 0 ? (
          <div
            className="owb-task-popover-wrap"
            onMouseEnter={openTaskList}
            onMouseLeave={closeTaskListSoon}
          >
            <button
              className="owb-task-popover-trigger"
              title="任务列表"
              aria-label="任务列表"
              data-testid="task-list-trigger"
              onClick={() => setTaskListOpen((v) => !v)}
            >
              <IconChat size={17} />
            </button>
            {taskListOpen ? (
              <div className="owb-task-popover" role="dialog" aria-label="任务列表" data-testid="task-list-popover">
                {grouped.tasks.length > 0 ? (
                  <div className="owb-task-popover__group">
                    <div className="owb-task-popover__header">任务</div>
                    {grouped.tasks.map((c) => (
                      <button
                        key={c.id}
                        className={`owb-task-popover__item${c.id === activeId ? ' owb-task-popover__item--active' : ''}`}
                        onClick={() => {
                          setTaskListOpen(false)
                          onSelect(c.id)
                        }}
                      >
                        {c.title}
                      </button>
                    ))}
                  </div>
                ) : null}
                {grouped.workspaces.length > 0 ? (
                  <div className="owb-task-popover__group">
                    <div className="owb-task-popover__header">工作空间</div>
                    {grouped.workspaces.map((g) => {
                      const key = `popover:${g.key}`
                      const folded = Boolean(sectionState.collapsedGroups[key])
                      return (
                        <div key={g.key} className="owb-task-popover__subgroup">
                          <button
                            className="owb-task-popover__subheader"
                            aria-expanded={!folded}
                            onClick={() => toggleGroup(key)}
                          >
                            <IconFolder size={14} />
                            <span>{g.title}</span>
                            <span className={`owb-sidebar__chevron${folded ? '' : ' owb-sidebar__chevron--open'}`}>
                              <IconChevron size={12} />
                            </span>
                          </button>
                          {folded ? null : g.conversations.map((c) => (
                            <button
                              key={c.id}
                              className={`owb-task-popover__item owb-task-popover__item--nested${c.id === activeId ? ' owb-task-popover__item--active' : ''}`}
                              onClick={() => {
                                setTaskListOpen(false)
                                onSelect(c.id)
                              }}
                            >
                              {c.title}
                            </button>
                          ))}
                        </div>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {conversations.length === 0 ? <div className="owb-conv-empty">还没有任务</div> : null}
        {conversations.length > 0 && grouped.filtered.length === 0 ? (
          <div className="owb-conv-empty owb-conv-empty--filtered" data-testid="filter-empty">
            <span>没有匹配的任务</span>
            <button className="owb-sidebar__more" onClick={onOpenFilter}>
              调整筛选条件
            </button>
          </div>
        ) : null}
        {renderSection('pinned', '置顶', grouped.pinned, { pinned: true })}
        {renderSection('tasks', '任务', grouped.tasks)}
        {grouped.workspaces.length > 0 ? (
          <div className="owb-sidebar__group">
            <button
              className="owb-sidebar__section"
              data-testid="section-workspaces"
              aria-expanded={!sectionState.collapsed.workspaces}
              onClick={() => toggleSection('workspaces')}
            >
              <span className={`owb-sidebar__chevron${sectionState.collapsed.workspaces ? '' : ' owb-sidebar__chevron--open'}`}>
                <IconChevron size={12} />
              </span>
              <span>工作空间</span>
            </button>
            {sectionState.collapsed.workspaces
              ? null
              : grouped.workspaces.map((g) => renderSection('workspaces', g.title, g.conversations, { key: `ws:${g.key}` }))}
          </div>
        ) : null}
        {grouped.colleagues.length > 0 ? (
          <div className="owb-sidebar__group">
            <button
              className="owb-sidebar__section"
              data-testid="section-colleagues"
              aria-expanded={!sectionState.collapsed.colleagues}
              onClick={() => toggleSection('colleagues')}
            >
              <span className={`owb-sidebar__chevron${sectionState.collapsed.colleagues ? '' : ' owb-sidebar__chevron--open'}`}>
                <IconChevron size={12} />
              </span>
              <span>助理任务</span>
            </button>
            {sectionState.collapsed.colleagues
              ? null
              : grouped.colleagues.map((g) => renderSection('colleagues', g.title, g.conversations, { key: `colleague:${g.key}` }))}
          </div>
        ) : null}
      </div>

      {menu && menuConversation ? (
        <div
          className="owb-conv-menu"
          data-testid="conversation-menu"
          role="menu"
          style={{ left: Math.min(menu.x, window.innerWidth - 180), top: Math.min(menu.y, window.innerHeight - 150) }}
        >
          <button
            role="menuitem"
            onClick={() => {
              onPin(menuConversation.id, !menuConversation.pinnedAt)
              setMenu(null)
            }}
          >
            <IconPin size={14} />
            {menuConversation.pinnedAt ? '取消置顶' : '置顶'}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setRenaming({ id: menuConversation.id, value: menuConversation.title })
              setMenu(null)
            }}
          >
            重命名
          </button>
          <button
            role="menuitem"
            className="owb-conv-menu__danger"
            disabled={busy}
            onClick={() => {
              setMenu(null)
              onDelete(menuConversation.id)
            }}
          >
            删除任务
          </button>
        </div>
      ) : null}

      <div className="owb-promo">
        <div className="owb-promo__title">做任务赢积分好礼</div>
        <div className="owb-promo__sub">连签抽取 Buddy 周边</div>
        <button className="owb-promo__cta" onClick={onOpenActivity}>立即前往</button>
      </div>

      <div className="owb-sidebar__footer">
        <button className="owb-account" onClick={onOpenAccount} title="账号与设置">
          <span className="owb-account__avatar">蜗</span>
          <span className="owb-account__name">坐房顶吹风的蜗牛先生</span>
        </button>
        <div className="owb-account__actions">
          <button
            className="owb-icon-btn owb-notifications-btn"
            title="通知"
            aria-label={unreadMessages > 0 ? `通知，${unreadMessages} 条未读` : '通知'}
            onClick={onOpenMessages}
          >
            <IconBell size={17} />
            {unreadMessages > 0 ? <span className="owb-notifications-btn__dot" data-testid="notifications-badge" /> : null}
          </button>
          <button className="owb-icon-btn" title="客服" aria-label="客服" onClick={onOpenSupport}>
            <IconChat size={17} />
          </button>
        </div>
      </div>
    </aside>
  )
}

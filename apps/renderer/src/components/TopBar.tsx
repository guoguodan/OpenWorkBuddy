import { useEffect, useRef, useState } from 'react'
import { IconCheck, IconFilter, IconSearch, IconSidebar } from './Icons'

export type TaskStatusFilter = 'working' | 'completed' | 'failed' | 'pending' | 'planning'
export type TaskDateFilter = 'today' | 'last7days' | 'last30days'

export interface TaskFilterState {
  sessionStatus: TaskStatusFilter[]
  date: TaskDateFilter | null
}

export const EMPTY_TASK_FILTER: TaskFilterState = { sessionStatus: [], date: null }

export function hasTaskFilter(filter: TaskFilterState): boolean {
  return filter.sessionStatus.length > 0 || filter.date !== null
}

interface TopBarProps {
  collapsed: boolean
  theme: 'light' | 'dark'
  onToggleCollapse: () => void
  onToggleTheme: () => void
  onFocusSearch: () => void
  onClearInput: () => void
  onOpenSettings: () => void
  onOpenWorkspace: () => void
  filter: TaskFilterState
  onFilterChange: (next: TaskFilterState) => void
}

const STATUS_OPTIONS: Array<{ value: TaskStatusFilter | null; label: string }> = [
  { value: null, label: '全部状态' },
  { value: 'working', label: '进行中' },
  { value: 'completed', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'pending', label: '待处理' },
  { value: 'planning', label: '规划中' }
]

const DATE_OPTIONS: Array<{ value: TaskDateFilter | null; label: string }> = [
  { value: null, label: '全部时间' },
  { value: 'today', label: '今天' },
  { value: 'last7days', label: '最近 7 天' },
  { value: 'last30days', label: '最近 30 天' }
]

/**
 * 任务筛选菜单。
 *
 * 对齐真实产品的两条独立维度:状态可多选、时间单选;选中的项才写进条件。
 * "全部"不是第三个互斥项,而是清空该维度,避免出现"全部 + 进行中"这种自相矛盾状态。
 */
function TaskFilterMenu({
  value,
  onChange,
  onReset
}: {
  value: TaskFilterState
  onChange: (next: TaskFilterState) => void
  onReset: () => void
}) {
  const active = hasTaskFilter(value)
  const pickStatus = (next: TaskStatusFilter | null) => {
    if (next === null) {
      onChange({ ...value, sessionStatus: [] })
      return
    }
    const list = value.sessionStatus.includes(next)
      ? value.sessionStatus.filter((item) => item !== next)
      : [...value.sessionStatus, next]
    onChange({ ...value, sessionStatus: list })
  }
  const pickDate = (next: TaskDateFilter | null) => {
    onChange({ ...value, date: next === null || value.date === next ? null : next })
  }

  return (
    <div className="owb-task-filter" role="menu" data-testid="task-filter-menu">
      <div className="owb-task-filter__section">
        <div className="owb-task-filter__title">筛选状态</div>
        <div className="owb-task-filter__options">
          {STATUS_OPTIONS.map((item) => {
            const selected = item.value === null ? value.sessionStatus.length === 0 : value.sessionStatus.includes(item.value)
            return (
              <button
                key={item.value ?? 'all'}
                role="menuitemcheckbox"
                aria-checked={selected}
                className={`owb-task-filter__option${selected ? ' owb-task-filter__option--on' : ''}`}
                onClick={() => pickStatus(item.value)}
                data-testid={`filter-status-${item.value ?? 'all'}`}
              >
                <span>{item.label}</span>
                {selected ? <IconCheck size={14} className="owb-task-filter__check" /> : null}
              </button>
            )
          })}
        </div>
      </div>
      <div className="owb-task-filter__divider" />
      <div className="owb-task-filter__section">
        <div className="owb-task-filter__title">筛选时间</div>
        <div className="owb-task-filter__options">
          {DATE_OPTIONS.map((item) => {
            const selected = item.value === null ? value.date === null : value.date === item.value
            return (
              <button
                key={item.value ?? 'all'}
                role="menuitemradio"
                aria-checked={selected}
                className={`owb-task-filter__option${selected ? ' owb-task-filter__option--on' : ''}`}
                onClick={() => pickDate(item.value)}
                data-testid={`filter-date-${item.value ?? 'all'}`}
              >
                <span>{item.label}</span>
                {selected ? <IconCheck size={14} className="owb-task-filter__check" /> : null}
              </button>
            )
          })}
        </div>
      </div>
      <div className="owb-task-filter__divider" />
      <button
        className={`owb-task-filter__reset${active ? '' : ' owb-task-filter__reset--disabled'}`}
        onClick={onReset}
        disabled={!active}
        data-testid="filter-reset"
      >
        重置筛选条件
      </button>
    </div>
  )
}

/**
 * 顶部菜单栏复刻真实产品的"细标题栏":
 * 左侧是窗口级操作(侧栏/搜索/筛选),中间是原生风格菜单,右侧留给系统按钮。
 * 这里不自绘最小化/最大化:窗口未启用无边框,系统标题按钮由 Electron 绘制。
 */
export function TopBar({
  collapsed,
  theme,
  onToggleCollapse,
  onToggleTheme,
  onFocusSearch,
  onClearInput,
  onOpenSettings,
  onOpenWorkspace,
  filter,
  onFilterChange
}: TopBarProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const rootRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!openMenu) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpenMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [openMenu])

  const menu = (
    id: string,
    label: string,
    items: Array<{ text: string; hint?: string; onPick: () => void }>
  ) => (
    <div className="owb-menubar__item">
      <button
        type="button"
        className={`owb-menubar__trigger${openMenu === id ? ' owb-menubar__trigger--open' : ''}`}
        onClick={() => setOpenMenu(openMenu === id ? null : id)}
        aria-expanded={openMenu === id}
      >
        {label}
      </button>
      {openMenu === id ? (
        <div className="owb-menu" role="menu">
          {items.map((it) => (
            <button
              key={it.text}
              role="menuitem"
              className="owb-menu__item"
              onClick={() => {
                setOpenMenu(null)
                it.onPick()
              }}
            >
              <span>{it.text}</span>
              {it.hint ? <span className="owb-menu__hint">{it.hint}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )

  return (
    <header className="owb-topbar" ref={rootRef}>
      <div className="owb-topbar__left">
        <button
          className="owb-icon-btn owb-topbar__btn"
          onClick={onToggleCollapse}
          title={collapsed ? '展开侧边栏' : '收起侧边栏'}
          aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
        >
          <IconSidebar size={17} />
        </button>
        <button className="owb-icon-btn owb-topbar__btn" onClick={onFocusSearch} title="搜索任务" aria-label="搜索任务">
          <IconSearch size={17} />
        </button>
        <span className="owb-topbar__filter">
          <button
            className="owb-icon-btn owb-topbar__btn"
            onClick={() => setOpenMenu(openMenu === 'filter' ? null : 'filter')}
            title="筛选"
            aria-label="筛选"
            aria-expanded={openMenu === 'filter'}
            data-testid="open-filter"
          >
            <IconFilter size={17} />
            {hasTaskFilter(filter) ? <span className="owb-topbar__filter-dot" data-testid="filter-dot" /> : null}
          </button>
          {openMenu === 'filter' ? (
            <TaskFilterMenu
              value={filter}
              onChange={onFilterChange}
              onReset={() => {
                onFilterChange(EMPTY_TASK_FILTER)
                setOpenMenu(null)
              }}
            />
          ) : null}
        </span>
      </div>

      <nav className="owb-menubar" aria-label="主菜单">
        {menu('edit', '编辑(E)', [
          { text: '清空输入框', hint: 'Ctrl+Shift+X', onPick: onClearInput },
          { text: '搜索任务', hint: 'Ctrl+K', onPick: onFocusSearch }
        ])}
        {menu('view', '窗口(W)', [
          { text: theme === 'dark' ? '切换到浅色主题' : '切换到深色主题', onPick: onToggleTheme },
          { text: collapsed ? '展开侧边栏' : '收起侧边栏', hint: 'Ctrl+B', onPick: onToggleCollapse },
          { text: '打开工作区目录', onPick: onOpenWorkspace }
        ])}
        {menu('help', '帮助(H)', [
          { text: '发送：Enter', onPick: () => undefined },
          { text: '换行：Shift + Enter', onPick: () => undefined },
          { text: '设置与权限', onPick: onOpenSettings }
        ])}
        {menu('about', '关于(A)', [
          { text: 'OpenWorkBuddy 0.0.1', onPick: () => undefined },
          { text: '本地优先的 AI 工作台', onPick: () => undefined }
        ])}
      </nav>

      <div className="owb-topbar__right" />
    </header>
  )
}

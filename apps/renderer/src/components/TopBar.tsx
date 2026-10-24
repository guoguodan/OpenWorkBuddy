import { useEffect, useRef, useState } from 'react'
import { IconFilter, IconSearch, IconSidebar } from './Icons'

interface TopBarProps {
  collapsed: boolean
  theme: 'light' | 'dark'
  onToggleCollapse: () => void
  onToggleTheme: () => void
  onFocusSearch: () => void
  onClearInput: () => void
  onOpenSettings: () => void
  onOpenWorkspace: () => void
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
  onOpenWorkspace
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
        <button
          className="owb-icon-btn owb-topbar__btn"
          onClick={() => setOpenMenu(openMenu === 'filter' ? null : 'filter')}
          title="筛选"
          aria-label="筛选"
        >
          <IconFilter size={17} />
        </button>
        {openMenu === 'filter' ? (
          <div className="owb-menu owb-menu--anchor" role="menu">
            {[
              { text: '全部任务', onPick: onFocusSearch },
              { text: '只看执行中', onPick: onFocusSearch },
              { text: '只看有交付物的任务', onPick: onOpenWorkspace }
            ].map((item) => (
              <button
                key={item.text}
                role="menuitem"
                className="owb-menu__item"
                onClick={() => { setOpenMenu(null); item.onPick() }}
              >
                {item.text}
              </button>
            ))}
          </div>
        ) : null}
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

import { useEffect, useRef, useState } from 'react'
import { IconSearch, IconSidebar } from './Icons'

interface TopBarProps {
  collapsed: boolean
  theme: 'light' | 'dark'
  onToggleCollapse: () => void
  onToggleTheme: () => void
  onFocusSearch: () => void
  onClearInput: () => void
  onToggleMemory: () => void
  onOpenWorkspace: () => void
}

export function TopBar({
  collapsed,
  theme,
  onToggleCollapse,
  onToggleTheme,
  onFocusSearch,
  onClearInput,
  onToggleMemory,
  onOpenWorkspace
}: TopBarProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

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
          className="owb-icon-btn"
          onClick={onToggleCollapse}
          title={collapsed ? '展开侧边栏' : '收起侧边栏'}
          aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
        >
          <IconSidebar />
        </button>
        <button className="owb-icon-btn" onClick={onFocusSearch} title="搜索会话" aria-label="搜索会话">
          <IconSearch size={17} />
        </button>
      </div>

      <nav className="owb-menubar" aria-label="主菜单">
        {menu('edit', '编辑', [
          { text: '清空输入框', hint: 'Ctrl+Shift+X', onPick: onClearInput },
          { text: '打开记忆面板', onPick: onToggleMemory },
          { text: '搜索会话', hint: 'Ctrl+K', onPick: onFocusSearch }
        ])}
        {menu('view', '窗口', [
          {
            text: theme === 'dark' ? '切换到浅色主题' : '切换到深色主题',
            onPick: onToggleTheme
          },
          {
            text: collapsed ? '展开侧边栏' : '收起侧边栏',
            hint: 'Ctrl+B',
            onPick: onToggleCollapse
          },
          { text: '打开工作区目录', onPick: onOpenWorkspace }
        ])}
        {menu('help', '帮助', [
          { text: '发送：Enter', onPick: onToggleMemory },
          { text: '换行：Shift + Enter', onPick: onFocusSearch }
        ])}
        {menu('about', '关于', [
          { text: 'OpenWorkBuddy 0.0.1', onPick: () => undefined },
          { text: '本地优先的 AI 工作台', onPick: () => undefined }
        ])}
      </nav>

      <div className="owb-topbar__right">
        <span className="owb-topbar__badge" title="本地执行，不上传工作区文件">
          <span className="owb-topbar__badge-dot" />
          本地运行
        </span>
      </div>
    </header>
  )
}
import { useEffect, useRef, useState } from 'react'
import { IconChevron, IconFile, IconFolder, IconPin } from './Icons'

interface ContentHeaderProps {
  title: string
  modeLabel: string
  workspaceLabel: string
  workspacePath: string
  busy: boolean
  artifactCount: number
  artifactPanelOpen: boolean
  onToggleArtifacts: () => void
  pinned: boolean
  onPin: (pinned: boolean) => void
  onRename: (title: string) => void
  onDelete: () => void
}

export function ContentHeader({
  title,
  modeLabel,
  workspaceLabel,
  workspacePath,
  busy,
  artifactCount,
  artifactPanelOpen,
  onToggleArtifacts,
  pinned,
  onPin,
  onRename,
  onDelete
}: ContentHeaderProps) {
  const [menu, setMenu] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!menu) return
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenu(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  useEffect(() => {
    if (editing !== null) inputRef.current?.select()
  }, [editing])

  const submitRename = () => {
    const next = editing?.trim()
    setEditing(null)
    if (next && next !== title) onRename(next)
  }

  return (
    <div className="owb-content-header" ref={rootRef}>
      <div className="owb-breadcrumb" title={`${workspacePath || workspaceLabel} / ${modeLabel} / ${title}`}>
        <IconFolder size={17} className="owb-breadcrumb__icon" />
        <span className="owb-breadcrumb__crumb">{workspaceLabel}</span>
        <span className="owb-breadcrumb__sep">/</span>
        <span className="owb-breadcrumb__crumb">{modeLabel}</span>
        <span className="owb-breadcrumb__sep">/</span>
        {editing !== null ? (
          <input
            ref={inputRef}
            className="owb-breadcrumb__rename"
            data-testid="header-rename-input"
            value={editing}
            maxLength={200}
            onChange={(event) => setEditing(event.target.value)}
            onBlur={submitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitRename()
              if (event.key === 'Escape') setEditing(null)
            }}
          />
        ) : (
          <span className="owb-breadcrumb__current" data-testid="header-title">{title}</span>
        )}
      </div>
      <div className="owb-content-header__right">
        {busy ? (
          <span className="owb-content-header__running">
            <span className="owb-content-header__dot" />
            执行中
          </span>
        ) : null}
        <button
          type="button"
          className="owb-content-header__tool"
          title="交付物"
          aria-label="交付物"
          aria-pressed={artifactPanelOpen}
          data-testid="artifact-panel-trigger"
          onClick={onToggleArtifacts}
        >
          <IconFile size={16} />
          <span>交付物</span>
          {artifactCount > 0 ? <span className="owb-content-header__badge">{artifactCount}</span> : null}
        </button>
        <button
          type="button"
          className="owb-content-header__menu-trigger"
          title="任务操作"
          aria-label="任务操作"
          aria-haspopup="menu"
          aria-expanded={menu}
          data-testid="header-menu-trigger"
          onClick={() => setMenu((value) => !value)}
        >
          <IconChevron size={16} className="owb-content-header__more" />
        </button>
        {menu ? (
          <div className="owb-content-header__menu" role="menu" data-testid="header-menu">
            <button
              role="menuitem"
              onClick={() => {
                setEditing(title)
                setMenu(false)
              }}
            >
              重命名
            </button>
            <button
              role="menuitem"
              onClick={() => {
                onPin(!pinned)
                setMenu(false)
              }}
            >
              <IconPin size={14} />
              {pinned ? '取消置顶' : '置顶'}
            </button>
            <button
              role="menuitem"
              className="owb-content-header__danger"
              disabled={busy}
              title={busy ? '任务运行中,结束后才能删除' : undefined}
              onClick={() => {
                setMenu(false)
                onDelete()
              }}
            >
              删除任务
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

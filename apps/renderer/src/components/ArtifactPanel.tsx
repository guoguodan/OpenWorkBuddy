import { useEffect, useMemo, useRef, useState } from 'react'
import type { ArtifactInfo } from './ArtifactCards'
import { IconCopy, IconFile, IconFolder, IconImage, IconLink, IconSearch, IconTrash, IconX } from './Icons'

type FilterKind = 'all' | ArtifactInfo['kind']

interface ArtifactPanelProps {
  artifacts: ArtifactInfo[]
  busy: boolean
  onClose: () => void
  onOpen: (artifact: ArtifactInfo) => void
  onRename: (artifact: ArtifactInfo, title: string) => void
  onRemove: (artifact: ArtifactInfo) => void
  onReveal: (artifact: ArtifactInfo) => void
  onOpenAll: () => void
  onNotify: (kind: 'info' | 'system', text: string) => void
}

const FILTERS: Array<{ id: FilterKind; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'file', label: '文档' },
  { id: 'html', label: '网页' },
  { id: 'image', label: '图片' },
  { id: 'url', label: '链接' }
]

const KIND_LABEL: Record<ArtifactInfo['kind'], string> = {
  file: '文档',
  html: '网页',
  image: '图片',
  url: '链接'
}

function kindIcon(kind: ArtifactInfo['kind']) {
  if (kind === 'image') return IconImage
  if (kind === 'url') return IconLink
  return IconFile
}

function sizeText(size: number | undefined): string {
  if (!size || !Number.isFinite(size)) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 会话级产物面板。
 *
 * 任务过程中产生的成果需要在同一个地方集中查看,否则用户只能往回翻消息。
 * 面板只负责展示与记录级操作;打开文件、定位和删除磁盘文件都交给主进程
 * 做工作区边界校验。
 */
export function ArtifactPanel({
  artifacts,
  busy,
  onClose,
  onOpen,
  onRename,
  onRemove,
  onReveal,
  onOpenAll,
  onNotify
}: ArtifactPanelProps) {
  const [filter, setFilter] = useState<FilterKind>('all')
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const blurLock = useRef(false)

  useEffect(() => {
    if (editingId) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editingId])

  const counts = useMemo(() => {
    const next: Record<string, number> = { all: artifacts.length }
    for (const item of artifacts) next[item.kind] = (next[item.kind] ?? 0) + 1
    return next
  }, [artifacts])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return artifacts.filter((item) => {
      if (filter !== 'all' && item.kind !== filter) return false
      if (!q) return true
      return [item.title, item.description ?? '', item.path ?? '', item.url ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q)
    })
  }, [artifacts, filter, query])

  const startRename = (item: ArtifactInfo) => {
    blurLock.current = false
    setEditingId(item.id)
    setDraft(item.title)
  }

  const commitRename = (item: ArtifactInfo) => {
    if (editingId !== item.id) return
    const next = draft.trim()
    setEditingId(null)
    if (next && next !== item.title) onRename(item, next)
  }

  const cancelRename = () => {
    blurLock.current = true
    setEditingId(null)
    setDraft('')
  }

  const copyPath = async (item: ArtifactInfo) => {
    const value = item.path || item.url
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      onNotify('info', `已复制路径: ${value}`)
    } catch (err) {
      onNotify('system', `复制失败: ${(err as Error).message}`)
    }
  }

  const remove = (item: ArtifactInfo) => {
    const confirmed = window.confirm(
      `从产物列表移除「${item.title}」?\n\n只会删除这条记录,工作区里的文件仍然保留。`
    )
    if (confirmed) onRemove(item)
  }

  return (
    <aside className="owb-artifact-panel" data-testid="artifact-panel" aria-label="产物">
      <header className="owb-artifact-panel__header">
        <div className="owb-artifact-panel__heading">
          <h2>产物</h2>
          <span className="owb-artifact-panel__count">{artifacts.length}</span>
        </div>
        <button
          type="button"
          className="owb-icon-btn"
          aria-label="关闭产物面板"
          data-testid="artifact-panel-close"
          onClick={onClose}
        >
          <IconX size={16} />
        </button>
      </header>

      <div className="owb-artifact-panel__search">
        <IconSearch size={15} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索产物"
          aria-label="搜索产物"
          data-testid="artifact-panel-search"
        />
      </div>

      <div className="owb-artifact-panel__filters" role="tablist" aria-label="按类型筛选">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={filter === item.id}
            className={`owb-artifact-panel__filter${filter === item.id ? ' owb-artifact-panel__filter--on' : ''}`}
            data-testid={`artifact-filter-${item.id}`}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
            {counts[item.id] ? <span>{counts[item.id]}</span> : null}
          </button>
        ))}
      </div>

      <div className="owb-artifact-panel__list">
        {artifacts.length === 0 ? (
          <div className="owb-artifact-panel__empty">
            <IconFile size={28} />
            <strong>还没有产物</strong>
            <span>对话过程中产生的所有产物都沉淀在这里。</span>
          </div>
        ) : visible.length === 0 ? (
          <div className="owb-artifact-panel__empty">
            <IconSearch size={26} />
            <strong>没有匹配的产物</strong>
            <span>换个关键词或筛选项试试。</span>
          </div>
        ) : (
          visible.map((item) => {
            const Icon = kindIcon(item.kind)
            const meta = [KIND_LABEL[item.kind], sizeText(item.size)].filter(Boolean).join(' · ')
            const isEditing = editingId === item.id
            return (
              <article key={item.id} className="owb-artifact-panel__row" data-testid="artifact-row">
                <button
                  type="button"
                  className="owb-artifact-panel__main"
                  title={item.path ?? item.url ?? item.title}
                  data-testid="artifact-open"
                  onClick={() => onOpen(item)}
                >
                  <span className={`owb-artifact-panel__icon owb-artifact-panel__icon--${item.kind}`}>
                    <Icon size={17} />
                  </span>
                  <span className="owb-artifact-panel__body">
                    {isEditing ? (
                      <input
                        ref={inputRef}
                        className="owb-artifact-panel__rename"
                        data-testid="artifact-rename-input"
                        value={draft}
                        maxLength={200}
                        aria-label="产物名称"
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => setDraft(event.target.value)}
                        onBlur={() => {
                          if (blurLock.current) {
                            blurLock.current = false
                            return
                          }
                          commitRename(item)
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            blurLock.current = true
                            commitRename(item)
                          }
                          if (event.key === 'Escape') {
                            event.preventDefault()
                            cancelRename()
                          }
                        }}
                      />
                    ) : (
                      <span className="owb-artifact-panel__title">{item.title}</span>
                    )}
                    <span className="owb-artifact-panel__meta">
                      {meta}
                      {item.path ? <span className="owb-artifact-panel__path">{item.path}</span> : null}
                    </span>
                  </span>
                </button>

                <div className="owb-artifact-panel__actions">
                  <button
                    type="button"
                    className="owb-artifact-panel__action"
                    title="重命名"
                    aria-label={`重命名 ${item.title}`}
                    data-testid="artifact-rename"
                    disabled={busy}
                    onClick={() => startRename(item)}
                  >
                    <IconFile size={13} />
                  </button>
                  {item.kind !== 'url' && item.path ? (
                    <button
                      type="button"
                      className="owb-artifact-panel__action"
                      title="在文件夹中显示"
                      aria-label={`定位 ${item.title}`}
                      data-testid="artifact-reveal"
                      onClick={() => onReveal(item)}
                    >
                      <IconFolder size={13} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="owb-artifact-panel__action"
                    title="复制路径"
                    aria-label={`复制 ${item.title} 的路径`}
                    data-testid="artifact-copy-path"
                    onClick={() => void copyPath(item)}
                  >
                    <IconCopy size={13} />
                  </button>
                  <button
                    type="button"
                    className="owb-artifact-panel__action owb-artifact-panel__action--danger"
                    title="从列表移除(不删除文件)"
                    aria-label={`移除 ${item.title}`}
                    data-testid="artifact-remove"
                    disabled={busy}
                    onClick={() => remove(item)}
                  >
                    <IconTrash size={13} />
                  </button>
                </div>
              </article>
            )
          })
        )}
      </div>

      <footer className="owb-artifact-panel__footer">
        <button
          type="button"
          className="owb-artifact-panel__all"
          data-testid="artifact-view-all"
          onClick={onOpenAll}
        >
          查看所有产物
        </button>
      </footer>
    </aside>
  )
}
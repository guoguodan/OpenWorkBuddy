import { useCallback, useEffect, useState } from 'react'
import { IconBook, IconFile, IconImage, IconLink, IconSearch, IconX } from './Icons'

interface LibraryPanelProps {
  onClose: () => void
  onNotify: (kind: 'system' | 'info', text: string) => void
  onOpenArtifact: (item: LibraryArtifactInfo) => void
}

function iconFor(kind: LibraryArtifactInfo['kind']) {
  if (kind === 'image') return IconImage
  if (kind === 'url') return IconLink
  if (kind === 'html') return IconBook
  return IconFile
}

function sizeText(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 资料库:跨任务聚合所有已交付的成果。
 *
 * 这里只读:资料库不是文件管理器,不提供移动/删除,避免绕过任务审计。
 */
export function LibraryPanel({ onClose, onNotify, onOpenArtifact }: LibraryPanelProps) {
  const [items, setItems] = useState<LibraryArtifactInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')

  const refresh = useCallback(async () => {
    try {
      const r = await window.openwb.library.list({ limit: 200 })
      setItems(r.items)
    } catch (err) {
      onNotify('system', `资料库加载失败: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [onNotify])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const filtered = query.trim()
    ? items.filter((item) =>
        [item.title, item.description ?? '', item.path ?? '', item.conversationTitle ?? '', item.taskTitle ?? '']
          .join(' ')
          .toLowerCase()
          .includes(query.trim().toLowerCase())
      )
    : items

  return (
    <section className="owb-sheet owb-sheet--wide" role="dialog" aria-modal="true" aria-label="资料库">
      <header className="owb-sheet__header">
        <div>
          <h2>资料库</h2>
          <p>由任务交付的成果集中在这里，按更新时间排序</p>
        </div>
        <button className="owb-icon-btn" onClick={onClose} aria-label="关闭资料库">
          <IconX size={16} />
        </button>
      </header>

      <div className="owb-sheet__body">
        <div className="owb-sheet__search">
          <IconSearch size={15} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题、路径或所属任务"
            aria-label="搜索资料"
          />
        </div>

        {loading ? (
          <div className="owb-empty">加载中…</div>
        ) : filtered.length === 0 ? (
          <div className="owb-empty">
            <IconBook size={30} />
            <strong>{items.length === 0 ? '还没有交付物' : '没有匹配的资料'}</strong>
            <span>{items.length === 0 ? '让 Buddy 完成任务并调用交付，成果会出现在这里。' : '换个关键词试试。'}</span>
          </div>
        ) : (
          <div className="owb-card-list">
            {filtered.map((item) => {
              const Icon = iconFor(item.kind)
              return (
                <button key={item.id} className="owb-card owb-card--row" onClick={() => onOpenArtifact(item)}>
                  <span className={`owb-card__icon owb-card__icon--${item.kind}`}>
                    <Icon size={17} />
                  </span>
                  <span className="owb-card__main">
                    <span className="owb-card__title">{item.title}</span>
                    <span className="owb-card__sub">
                      {[item.taskTitle, item.conversationTitle, item.path, sizeText(item.size)]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <span className="owb-card__time">{new Date(item.createdAt).toLocaleDateString('zh-CN')}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}

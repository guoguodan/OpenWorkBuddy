import { useCallback, useEffect, useRef, useState } from 'react'
import { IconSearch, IconX } from './Icons'

export interface SearchHit {
  group: 'message' | 'artifact' | 'task'
  id: string
  conversationId: string
  conversationTitle: string
  seq: number | null
  title: string
  snippet: string
  role?: string
  createdAt: string
}

export interface SearchGroup {
  group: 'message' | 'artifact' | 'task'
  total: number
  items: SearchHit[]
}

const GROUP_LABEL: Record<SearchGroup['group'], string> = {
  message: '消息',
  artifact: '交付物',
  task: '任务'
}

interface SearchPanelProps {
  open: boolean
  onClose: () => void
  onQuery: (q: string) => Promise<SearchGroup[]>
  onJump: (hit: SearchHit) => void
}

/**
 * 全局搜索面板。
 * 防抖放在组件里而不是调用方:输入框一挂载就负责自己的节奏,
 * 任何一次击键都会取消上一次未发出的查询。
 */
export function SearchPanel({ open, onClose, onQuery, onJump }: SearchPanelProps) {
  const [query, setQuery] = useState('')
  const [groups, setGroups] = useState<SearchGroup[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seqRef = useRef(0)
  const onQueryRef = useRef(onQuery)
  onQueryRef.current = onQuery
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const id = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(id)
  }, [open])

  // 关闭时取消在途查询:否则关闭后返回的结果会写进已清空的状态
  useEffect(() => {
    if (open) return
    seqRef.current++
    if (timer.current) clearTimeout(timer.current)
    setQuery('')
    setGroups([])
    setError('')
    setBusy(false)
  }, [open])

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    const q = query.trim()
    if (!open || q.length === 0) {
      setGroups([])
      setBusy(false)
      return
    }
    setBusy(true)
    const mine = ++seqRef.current
    timer.current = setTimeout(() => {
      void onQueryRef.current(q)
        .then((result) => {
          if (mine !== seqRef.current) return
          setGroups(result)
          setError('')
        })
        .catch((err) => {
          if (mine !== seqRef.current) return
          setGroups([])
          setError((err as Error).message)
        })
        .finally(() => {
          if (mine === seqRef.current) setBusy(false)
        })
    }, 200)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [query, open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null
  const total = groups.reduce((n, g) => n + g.items.length, 0)

  return (
    <div className="owb-search-overlay" onClick={onClose} role="presentation">
      <div className="owb-search-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="全局搜索" data-testid="search-panel">
        <div className="owb-search-panel__input">
          <IconSearch size={16} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索消息、交付物与任务…"
            aria-label="全局搜索"
            data-testid="search-input"
          />
          {busy ? <span className="owb-search-panel__hint">搜索中…</span> : null}
          <button className="owb-icon-btn" onClick={onClose} aria-label="关闭搜索"><IconX size={14} /></button>
        </div>

        <div className="owb-search-panel__body">
          {error ? <div className="owb-search-panel__empty">搜索失败:{error}</div> : null}
          {!error && query.trim() && !busy && total === 0 ? (
            <div className="owb-search-panel__empty">没有匹配「{query.trim()}」的内容</div>
          ) : null}
          {groups.filter((g) => g.items.length > 0).map((g) => {
            return (
              <section key={g.group} className="owb-search-group" data-testid={`search-group-${g.group}`}>
                <header className="owb-search-group__title">
                  {GROUP_LABEL[g.group]}
                  <span className="owb-search-group__count">{g.total}</span>
                </header>
                {g.items.map((hit) => (
                  <button
                    key={hit.id}
                    className="owb-search-hit"
                    onClick={() => { onJump(hit); onClose() }}
                  >
                    <span className="owb-search-hit__title">
                      {hit.conversationTitle || hit.title}
                      {hit.seq !== null ? <span className="owb-search-hit__seq">#{hit.seq}</span> : null}
                    </span>
                    <span className="owb-search-hit__snippet">{hit.snippet}</span>
                  </button>
                ))}
                {g.total > g.items.length ? (
                  <div className="owb-search-group__more">仅显示前 {g.items.length} 条,共 {g.total} 条</div>
                ) : null}
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}

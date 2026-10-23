import { IconBrain, IconTrash } from './Icons'

export interface MemoryItem {
  id: string
  scope: string
  kind: string
  content: string
  tokens: number
  createdAt: string
}

interface MemoryPanelProps {
  items: MemoryItem[]
  onDelete: (id: string) => void
  onClose: () => void
}

export function MemoryPanel({ items, onDelete, onClose }: MemoryPanelProps) {
  return (
    <section className="owb-memory" aria-label="记忆面板">
      <div className="owb-memory__header">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <IconBrain size={15} />
          记忆 ({items.length})
        </span>
        <button className="owb-icon-btn" style={{ width: 26, height: 26 }} onClick={onClose} title="收起记忆">
          收起
        </button>
      </div>
      {items.length === 0 ? (
        <div className="owb-memory__empty">暂无记忆。完成一轮任务后,工作区日志与摘要会自动记入这里。</div>
      ) : (
        <div className="owb-memory__list">
          {items.map((m) => (
            <div key={m.id} className="owb-memory__item">
              <span className="owb-memory__scope">{m.scope}</span>
              <span className="owb-memory__kind">{m.kind}</span>
              <span className="owb-memory__content" title={m.content}>{m.content}</span>
              <button className="owb-memory__del" onClick={() => onDelete(m.id)} aria-label="删除这条记忆">
                <IconTrash size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
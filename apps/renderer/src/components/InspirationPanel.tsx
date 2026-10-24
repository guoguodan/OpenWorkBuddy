import { useCallback, useEffect, useState } from 'react'
import { IconBulb, IconCheck, IconPlus, IconRefresh, IconTrash, IconX } from './Icons'

interface InspirationPanelProps {
  onClose: () => void
  onNotify: (kind: 'system' | 'info', text: string) => void
}

type Filter = 'all' | 'favorite'

function dayText(iso: string): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return ''
  return new Date(time).toLocaleDateString('zh-CN')
}

/**
 * 灵感社区。
 *
 * 真实的灵感页空态是"暂无灵感 / 灵感和建议将显示在这里"。
 * 这里不做技能页复用:灵感是独立可发布的条目,收藏与删除都要持久化。
 */
export function InspirationPanel({ onClose, onNotify }: InspirationPanelProps) {
  const [posts, setPosts] = useState<InspirationPostInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [formOpen, setFormOpen] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tags, setTags] = useState('')
  const [working, setWorking] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const r = await window.openwb.inspiration.list()
      setPosts(r.posts)
    } catch (err) {
      onNotify('system', `灵感加载失败: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [onNotify])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const publish = async () => {
    if (!title.trim()) {
      onNotify('system', '请填写灵感标题')
      return
    }
    setWorking(true)
    try {
      await window.openwb.inspiration.create({
        title: title.trim(),
        body: body.trim(),
        source: '本地灵感',
        tags: tags
          .split(/[,，\s]+/)
          .map((tag) => tag.trim())
          .filter(Boolean)
          .slice(0, 12)
      })
      setTitle('')
      setBody('')
      setTags('')
      setFormOpen(false)
      await refresh()
      onNotify('info', '灵感已发布')
    } catch (err) {
      onNotify('system', `发布失败: ${(err as Error).message}`)
    } finally {
      setWorking(false)
    }
  }

  const favorite = async (post: InspirationPostInfo) => {
    setWorking(true)
    try {
      await window.openwb.inspiration.favorite({ id: post.id, favorite: !post.favorite })
      await refresh()
    } catch (err) {
      onNotify('system', `收藏失败: ${(err as Error).message}`)
    } finally {
      setWorking(false)
    }
  }

  const remove = async (post: InspirationPostInfo) => {
    if (!window.confirm(`删除灵感「${post.title}」?`)) return
    setWorking(true)
    try {
      await window.openwb.inspiration.remove(post.id)
      await refresh()
    } catch (err) {
      onNotify('system', `删除失败: ${(err as Error).message}`)
    } finally {
      setWorking(false)
    }
  }

  const visible = filter === 'favorite' ? posts.filter((post) => post.favorite) : posts

  return (
    <section className="owb-sheet owb-sheet--wide" role="dialog" aria-modal="true" aria-label="灵感">
      <header className="owb-sheet__header">
        <div>
          <h2>灵感</h2>
          <p>每天为你整理值得看的灵感，也可以把好点子沉淀成可复用的线索</p>
        </div>
        <div className="owb-sheet__header-actions">
          <button
            className="owb-sheet__primary"
            onClick={() => setFormOpen((value) => !value)}
            data-testid="inspiration-publish"
          >
            <IconPlus size={14} />
            发布灵感
          </button>
          <button className="owb-icon-btn" onClick={onClose} aria-label="关闭灵感">
            <IconX size={16} />
          </button>
        </div>
      </header>

      <div className="owb-sheet__body">
        {formOpen ? (
          <section className="owb-form" data-testid="inspiration-form">
            <label className="owb-field">
              <span>标题</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="一句话写清楚这个点子的价值"
                maxLength={160}
                data-testid="inspiration-title"
              />
            </label>
            <label className="owb-field">
              <span>内容</span>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="补充背景、适用场景或下一步想法"
                rows={4}
                maxLength={8000}
              />
            </label>
            <label className="owb-field">
              <span>标签</span>
              <input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="用逗号或空格分隔，例如：产品 交互"
                maxLength={200}
                data-testid="inspiration-tags"
              />
            </label>
            <div className="owb-form__actions">
              <button className="owb-sheet__action" onClick={() => setFormOpen(false)}>
                取消
              </button>
              <button
                className="owb-sheet__primary"
                onClick={() => void publish()}
                disabled={working}
                data-testid="inspiration-save"
              >
                发布
              </button>
            </div>
          </section>
        ) : null}

        <div className="owb-inspiration-toolbar">
          <div className="owb-segmented" role="tablist" aria-label="灵感筛选">
            {([
              ['all', '全部'],
              ['favorite', '收藏']
            ] as const).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={filter === id}
                className={`owb-segmented__item${filter === id ? ' owb-segmented__item--on' : ''}`}
                onClick={() => setFilter(id)}
                data-testid={`inspiration-filter-${id}`}
              >
                {label}
              </button>
            ))}
          </div>
          <button className="owb-sheet__action" onClick={() => void refresh()} data-testid="inspiration-refresh">
            <IconRefresh size={13} />
            刷新
          </button>
        </div>

        {loading ? (
          <div className="owb-empty">加载中…</div>
        ) : visible.length === 0 ? (
          <div className="owb-empty" data-testid="inspiration-empty">
            <IconBulb size={30} />
            <strong>{posts.length === 0 ? '暂无灵感' : '还没有收藏的灵感'}</strong>
            <span>{posts.length === 0 ? '灵感和建议将显示在这里' : '在全部灵感中收藏你关心的条目'}</span>
          </div>
        ) : (
          <div className="owb-card-list">
            {visible.map((post) => (
              <article key={post.id} className="owb-card owb-inspiration-card" data-testid="inspiration-card" data-post-id={post.id}>
                <div className="owb-card__head">
                  <div className="owb-card__title">{post.title}</div>
                  <div className="owb-card__actions">
                    <button
                      className={`owb-icon-btn${post.favorite ? ' owb-icon-btn--on' : ''}`}
                      onClick={() => void favorite(post)}
                      disabled={working}
                      aria-label={post.favorite ? `取消收藏 ${post.title}` : `收藏 ${post.title}`}
                      data-testid="inspiration-favorite"
                      data-favorite={post.favorite ? '1' : '0'}
                    >
                      {post.favorite ? <IconCheck size={14} /> : <IconBulb size={14} />}
                    </button>
                    <button
                      className="owb-icon-btn owb-icon-btn--danger"
                      onClick={() => void remove(post)}
                      disabled={working}
                      aria-label={`删除灵感 ${post.title}`}
                    >
                      <IconTrash size={14} />
                    </button>
                  </div>
                </div>
                {post.body ? <p className="owb-card__text">{post.body}</p> : null}
                {post.tags.length > 0 ? (
                  <div className="owb-chip-row">
                    {post.tags.map((tag) => (
                      <span key={tag} className="owb-chip">
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="owb-card__sub owb-colleague-meta">
                  <span>{post.source}</span>
                  <span>{dayText(post.createdAt)}</span>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import { IconChat, IconPlus, IconSparkle, IconX } from './Icons'
import { ColleagueDetail } from './colleagues/ColleagueDetail'
import { ColleagueWizard } from './colleagues/ColleagueWizard'
import {
  ColleagueAvatar,
  colleagueState,
  matchesFilter,
  stateLabel,
  type ColleagueFilter,
  type ColleagueFormState
} from './colleagues/shared'
import illustration from '../assets/cloud-assistant-illustration.png'

interface ColleaguesPanelProps {
  onClose: () => void
  onNotify: (kind: 'system' | 'info', text: string) => void
  onAssign: (colleague: ColleagueInfo, prompt?: string) => void
  onOpenTask: (conversationId: string) => void
}

const FILTERS: Array<{ id: ColleagueFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'idle', label: '空闲' },
  { id: 'working', label: '工作中' },
  { id: 'abnormal', label: '异常' }
]

/**
 * 助理协作空间。
 *
 * 卡片状态完全来自 daemon 汇总的真实 task 行;置顶、暂停、删除会立即持久化并影响运行链。
 */
export function ColleaguesPanel({ onClose, onNotify, onAssign, onOpenTask }: ColleaguesPanelProps) {
  const [items, setItems] = useState<ColleagueInfo[]>([])
  const [skills, setSkills] = useState<Array<{ name: string; description: string }>>([])
  const [connectors, setConnectors] = useState<Array<{ name: string; displayName: string }>>([])
  const [channels, setChannels] = useState<Array<{ id: string; name: string }>>([])
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState<string | null>(null)
  const [filter, setFilter] = useState<ColleagueFilter>('all')
  const [mode, setMode] = useState<'local' | 'cloud'>('cloud')
  const [prompt, setPrompt] = useState('')
  const [wizardOpen, setWizardOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const result = await window.openwb.colleagues.list()
      setItems(result.colleagues)
    } catch (err) {
      onNotify('system', `助理列表加载失败: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [onNotify])

  useEffect(() => {
    void refresh()
    void window.openwb.skills.list().then((result) => setSkills(result.skills)).catch(() => undefined)
    void window.openwb.plugins
      .list()
      .then((result) =>
        setConnectors(
          result.plugins
            .filter((plugin) => plugin.kind === 'connector')
            .map((plugin) => ({ name: plugin.name, displayName: plugin.displayName }))
        )
      )
      .catch(() => undefined)
    void window.openwb.channel
      .list()
      .then((result) => setChannels(result.channels.map((channel) => ({ id: channel.id, name: channel.name }))))
      .catch(() => undefined)
  }, [refresh])

  const workingCount = items.filter((item) => colleagueState(item) === 'working').length
  const visible = useMemo(() => items.filter((item) => matchesFilter(item, filter)), [items, filter])
  const editing = editingId ? items.find((item) => item.id === editingId) ?? null : null
  const detail = detailId ? items.find((item) => item.id === detailId) ?? null : null
  const deleting = confirmDeleteId ? items.find((item) => item.id === confirmDeleteId) ?? null : null

  const save = async (form: ColleagueFormState) => {
    setWorking(editingId ?? 'create')
    try {
      const payload: ColleagueInputInfo = {
        name: form.name.trim(),
        title: form.title.trim(),
        description: form.description.trim(),
        instructions: form.instructions.trim(),
        visibility: form.visibility,
        memoryEnabled: form.memoryEnabled,
        skillNames: form.skillNames,
        connectorNames: form.connectorNames,
        channelIds: form.channelIds
      }
      if (editingId) await window.openwb.colleagues.update({ id: editingId, ...payload })
      else await window.openwb.colleagues.create(payload)
      setWizardOpen(false)
      setEditingId(null)
      await refresh()
      onNotify('info', editingId ? '助理档案已保存' : '助理已创建')
    } catch (err) {
      onNotify('system', `保存失败: ${(err as Error).message}`)
    } finally {
      setWorking(null)
    }
  }

  const patch = async (
    item: ColleagueInfo,
    input: Partial<ColleagueInputInfo> & { id: string },
    success?: string
  ) => {
    setWorking(item.id)
    try {
      await window.openwb.colleagues.update(input)
      await refresh()
      if (success) onNotify('info', success)
    } catch (err) {
      onNotify('system', `更新失败: ${(err as Error).message}`)
    } finally {
      setWorking(null)
    }
  }

  const remove = async (item: ColleagueInfo) => {
    setWorking(item.id)
    try {
      await window.openwb.colleagues.remove(item.id)
      setConfirmDeleteId(null)
      if (detailId === item.id) setDetailId(null)
      await refresh()
      onNotify('info', `已删除助理「${item.name}」`)
    } catch (err) {
      onNotify('system', `删除失败: ${(err as Error).message}`)
    } finally {
      setWorking(null)
    }
  }

  const scheduleWork = () => {
    const text = prompt.trim()
    if (!text) {
      onNotify('system', '先写下要安排的工作')
      return
    }
    // 按目标文本匹配助理的职能与简介,优先空闲助理;没有匹配时退回第一位可用助理。
    const assignable = items.filter((item) => item.status === 'active')
    const ranked = assignable
      .map((item) => {
        const haystack = `${item.name} ${item.title} ${item.description}`.toLowerCase()
        let score = 0
        for (const token of text.toLowerCase().split(/[\s,，。;；、]+/).filter((part) => part.length >= 2)) {
          if (haystack.includes(token)) score += 2
        }
        if (colleagueState(item) === 'idle') score += 1
        return { item, score }
      })
      .sort((a, b) => b.score - a.score)
    const target = ranked[0]?.item
    if (!target) {
      onNotify('system', '当前没有可派单的助理，请先创建或恢复一位助理')
      return
    }
    setPrompt('')
    onAssign(target, text)
  }

  const openCreate = () => {
    setEditingId(null)
    setWizardOpen(true)
  }

  const openEdit = (item: ColleagueInfo) => {
    setEditingId(item.id)
    setWizardOpen(true)
    setMenuId(null)
  }

  if (wizardOpen) {
    return (
      <section className="owb-sheet owb-collab-sheet" role="dialog" aria-modal="true" aria-label="助理协作空间">
        <ColleagueWizard
          editing={editing}
          skills={skills}
          connectors={connectors}
          channels={channels}
          working={working !== null}
          onCancel={() => {
            setWizardOpen(false)
            setEditingId(null)
          }}
          onSave={save}
        />
      </section>
    )
  }

  return (
    <section className="owb-sheet owb-collab-sheet" role="dialog" aria-modal="true" aria-label="助理协作空间">
      <header className="owb-collab-header">
        <div>
          <h2>助理协作空间</h2>
          <p>选择一位助理加入任务，让专业角色帮你完成研究、分析和内容创作。</p>
        </div>
        <button className="owb-icon-btn" onClick={onClose} aria-label="关闭助理协作空间">
          <IconX size={16} />
        </button>
      </header>

      <div className="owb-collab-scroll">
        <section className="owb-collab-hero" data-testid="colleague-hero">
          <div className="owb-collab-hero__main">
            <div className="owb-collab-hero__top">
              <span className="owb-collab-hero__title">
                <IconSparkle size={15} />
                云助理
              </span>
              <div className="owb-collab-mode" role="group" aria-label="切换云助理模式">
                <button className={mode === 'local' ? 'is-on' : ''} onClick={() => setMode('local')}>
                  本地
                </button>
                <button className={mode === 'cloud' ? 'is-on' : ''} onClick={() => setMode('cloud')}>
                  云端
                </button>
              </div>
            </div>
            <h3>Hi，欢迎使用云助理</h3>
            <p>抛出想法，分配任务，就这么简单</p>
            <div className="owb-collab-hero__prompt">
              <input
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') scheduleWork()
                }}
                placeholder="抛出想法，分配任务，就这么简单"
                aria-label="安排工作内容"
                data-testid="colleague-quick-input"
              />
              <button onClick={scheduleWork} data-testid="colleague-quick-assign">
                安排工作
              </button>
            </div>
          </div>
          <img className="owb-collab-hero__art" src={illustration} alt="" aria-hidden="true" />
        </section>

        <div className="owb-collab-toolbar">
          <div className="owb-collab-toolbar__count">
            <strong>{items.length} 位</strong>
            <span>·</span>
            <span>{workingCount} 工作中</span>
          </div>
          <div className="owb-collab-filters" aria-label="筛选助理状态">
            {FILTERS.map((item) => (
              <button
                key={item.id}
                className={filter === item.id ? 'is-on' : ''}
                onClick={() => setFilter(item.id)}
                aria-pressed={filter === item.id}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="owb-collab-empty">加载中…</div>
        ) : (
          <div className="owb-collab-grid">
            {visible.map((item) => {
              const state = colleagueState(item)
              const paused = item.status === 'paused'
              return (
                <article
                  key={item.id}
                  className={`owb-collab-card owb-collab-card--${state}`}
                  data-testid="colleague-card"
                >
                  <div className="owb-collab-card__top">
                    <div className="owb-collab-card__more">
                      <button
                        className="owb-icon-btn"
                        aria-label={`更多操作 ${item.name}`}
                        aria-haspopup="menu"
                        aria-expanded={menuId === item.id}
                        onClick={() => setMenuId((prev) => (prev === item.id ? null : item.id))}
                        data-testid="colleague-more"
                      >
                        <span className="owb-collab-card__ellipsis">···</span>
                      </button>
                      {menuId === item.id ? (
                        <div className="owb-menu owb-collab-menu" role="menu" data-testid="colleague-menu">
                          <button
                            role="menuitem"
                            onClick={() => {
                              setMenuId(null)
                              void patch(
                                item,
                                { id: item.id, pinned: !item.pinnedAt },
                                item.pinnedAt ? `已取消置顶「${item.name}」` : `已置顶「${item.name}」`
                              )
                            }}
                          >
                            {item.pinnedAt ? '取消置顶' : '置顶'}
                          </button>
                          <button role="menuitem" onClick={() => openEdit(item)}>
                            编辑档案
                          </button>
                          <button
                            role="menuitem"
                            onClick={() => {
                              setMenuId(null)
                              void patch(
                                item,
                                { id: item.id, status: paused ? 'active' : 'paused' },
                                paused ? '助理已恢复，可以继续派单' : '助理已暂停，不会再响应任务'
                              )
                            }}
                          >
                            {paused ? '恢复助理' : '暂停助理'}
                          </button>
                          <button
                            role="menuitem"
                            className="owb-menu__danger"
                            onClick={() => {
                              setConfirmDeleteId(item.id)
                              setMenuId(null)
                            }}
                          >
                            删除助理
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <button
                    className="owb-collab-card__identity"
                    onClick={() => setDetailId(item.id)}
                    aria-label={`查看 ${item.name} 档案`}
                    data-testid="colleague-open-detail"
                  >
                    <ColleagueAvatar item={item} />
                    <span className="owb-collab-card__name">
                      <strong>
                        {item.name}
                        {item.pinnedAt ? <i className="owb-collab-card__pin" aria-label="已置顶">置顶</i> : null}
                      </strong>
                      <span>{item.title || '助理'}</span>
                    </span>
                  </button>

                  <span className={`owb-collab-state owb-collab-state--${state}`} data-testid="colleague-state">
                    {stateLabel(state)}
                  </span>
                  <p className="owb-collab-card__desc">{item.description || '还没有填写助理简介。'}</p>

                  <div className="owb-collab-card__tags">
                    {item.skillNames.slice(0, 2).map((name) => (
                      <span key={name} data-testid="colleague-skill">
                        {name}
                      </span>
                    ))}
                    {item.connectorNames.length > 0 ? <span>{item.connectorNames.length} 个连接器</span> : null}
                    {item.channelIds.length > 0 ? <span>{item.channelIds.length} 个频道</span> : null}
                  </div>

                  <div className="owb-collab-card__footer">
                    <span data-testid="colleague-meta">
                      {item.stats.conversationCount} 个会话 · 记忆{item.memoryEnabled ? '开启' : '关闭'}
                    </span>
                    <button
                      onClick={() => onAssign(item)}
                      disabled={paused || working !== null}
                      title={paused ? '助理已暂停，恢复后才能指派任务' : undefined}
                      data-testid="colleague-assign"
                    >
                      <IconChat size={13} />
                      对话
                    </button>
                  </div>
                </article>
              )
            })}

            <button className="owb-collab-create" onClick={openCreate} data-testid="colleague-create">
              <span>
                <IconPlus size={17} />
              </span>
              <strong>创建助理</strong>
              <small>组建你的团队</small>
            </button>
          </div>
        )}

        {!loading && visible.length === 0 && items.length > 0 ? (
          <div className="owb-collab-empty">当前筛选下没有助理</div>
        ) : null}
      </div>

      {detail ? (
        <ColleagueDetail
          colleague={detail}
          working={working !== null}
          onClose={() => setDetailId(null)}
          onEdit={() => openEdit(detail)}
          onChat={() => {
            setDetailId(null)
            onAssign(detail)
          }}
          onOpenTask={(id) => {
            setDetailId(null)
            onOpenTask(id)
          }}
          onTogglePin={() =>
            void patch(detail, { id: detail.id, pinned: !detail.pinnedAt }, detail.pinnedAt ? '已取消置顶' : '已置顶助理')
          }
          onTogglePause={() =>
            void patch(
              detail,
              { id: detail.id, status: detail.status === 'paused' ? 'active' : 'paused' },
              detail.status === 'paused' ? '助理已恢复，可以继续派单' : '助理已暂停，不会再响应任务'
            )
          }
          onDelete={() => setConfirmDeleteId(detail.id)}
          onNotify={onNotify}
          onTaskRemoved={() => void refresh()}
        />
      ) : null}

      {deleting ? (
        <div
          className="owb-modal-backdrop owb-collab-confirm-layer"
          role="presentation"
          onClick={() => setConfirmDeleteId(null)}
        >
          <div
            className="owb-modal owb-project-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="删除助理"
            onClick={(event) => event.stopPropagation()}
          >
            <h3>删除助理？</h3>
            <p className="owb-card__sub">
              删除后将无法继续指派 {deleting.name} 处理任务。此操作需要确认后才会执行。
            </p>
            <div className="owb-project-dialog__actions">
              <button className="owb-sheet__action" onClick={() => setConfirmDeleteId(null)}>
                取消
              </button>
              <button
                className="owb-sheet__primary owb-project-dialog__danger"
                onClick={() => void remove(deleting)}
                disabled={working !== null}
                data-testid="colleague-delete-confirm"
              >
                删除助理
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {menuId ? <button className="owb-menu-scrim" aria-label="关闭菜单" onClick={() => setMenuId(null)} /> : null}
    </section>
  )
}

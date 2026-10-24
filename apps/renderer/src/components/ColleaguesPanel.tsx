import { useCallback, useEffect, useState } from 'react'
import { IconCheck, IconPause, IconPin, IconPlay, IconPlus, IconRobot, IconTool, IconTrash, IconX } from './Icons'

interface ColleaguesPanelProps {
  onClose: () => void
  onNotify: (kind: 'system' | 'info', text: string) => void
  onAssign: (colleague: ColleagueInfo) => void
}

const PRESETS = [
  { name: '研究助理', title: '行业研究', description: '拆解问题、查找资料、给出有依据的结论' },
  { name: '写作助理', title: '内容创作', description: '把素材整理成结构清晰、可直接使用的文稿' },
  { name: '数据助理', title: '数据分析', description: '清洗数据、发现趋势与异常、输出结论' },
  { name: '代码助理', title: '研发协作', description: '理解代码库、定位问题、给出可验证的改动' }
]

const VISIBILITY_OPTIONS = [
  { id: 'personal' as const, name: '个人分身', desc: '仅你可见' },
  { id: 'project' as const, name: '发布到项目', desc: '项目成员可协作' },
  { id: 'public' as const, name: '公开', desc: '需审核 · 团队外可用' }
]

type FormState = {
  name: string
  title: string
  description: string
  instructions: string
  visibility: ColleagueInfo['visibility']
  memoryEnabled: boolean
  skillNames: string[]
  connectorNames: string[]
  channelIds: string[]
}

const EMPTY_FORM: FormState = {
  name: '',
  title: '',
  description: '',
  instructions: '',
  visibility: 'personal',
  memoryEnabled: true,
  skillNames: [],
  connectorNames: [],
  channelIds: []
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}

function usageText(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return String(tokens)
}

function visibilityName(value: ColleagueInfo['visibility']): string {
  return VISIBILITY_OPTIONS.find((item) => item.id === value)?.name ?? value
}

/**
 * 助理面板。
 *
 * 这里不是"角色卡片列表",而是助理的运行配置:
 * 状态决定能否派单,技能/连接器决定本轮工具边界,频道决定可被召唤的范围,
 * 记忆开关决定是否注入长期记忆。编辑后立即持久化并影响下一轮运行。
 */
export function ColleaguesPanel({ onClose, onNotify, onAssign }: ColleaguesPanelProps) {
  const [items, setItems] = useState<ColleagueInfo[]>([])
  const [skills, setSkills] = useState<Array<{ name: string; description: string }>>([])
  const [connectors, setConnectors] = useState<Array<{ name: string; displayName: string }>>([])
  const [channels, setChannels] = useState<Array<{ id: string; name: string }>>([])
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)

  const refresh = useCallback(async () => {
    try {
      const r = await window.openwb.colleagues.list()
      setItems(r.colleagues)
    } catch (err) {
      onNotify('system', `助理列表加载失败: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [onNotify])

  useEffect(() => {
    void refresh()
    void window.openwb.skills.list().then((r) => setSkills(r.skills)).catch(() => undefined)
    void window.openwb.plugins
      .list()
      .then((r) => setConnectors(r.plugins.filter((p) => p.kind === 'connector').map((p) => ({ name: p.name, displayName: p.displayName }))))
      .catch(() => undefined)
    void window.openwb.channel
      .list()
      .then((r) => setChannels(r.channels.map((c) => ({ id: c.id, name: c.name }))))
      .catch(() => undefined)
  }, [refresh])

  const openCreate = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setFormOpen(true)
  }

  const openEdit = (item: ColleagueInfo) => {
    setEditingId(item.id)
    setForm({
      name: item.name,
      title: item.title,
      description: item.description,
      instructions: item.instructions,
      visibility: item.visibility,
      memoryEnabled: item.memoryEnabled,
      skillNames: [...item.skillNames],
      connectorNames: [...item.connectorNames],
      channelIds: [...item.channelIds]
    })
    setFormOpen(true)
  }

  const save = async () => {
    if (!form.name.trim()) {
      onNotify('system', '请填写助理名称')
      return
    }
    const key = editingId ?? 'create'
    setWorking(key)
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
      setFormOpen(false)
      setEditingId(null)
      await refresh()
      onNotify('info', editingId ? '助理档案已保存' : '助理已创建')
    } catch (err) {
      onNotify('system', `保存失败: ${(err as Error).message}`)
    } finally {
      setWorking(null)
    }
  }

  const patch = async (item: ColleagueInfo, input: Partial<ColleagueInputInfo> & { id: string }, success?: string) => {
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
    if (!window.confirm(`删除助理「${item.name}」?`)) return
    setWorking(item.id)
    try {
      await window.openwb.colleagues.remove(item.id)
      await refresh()
    } catch (err) {
      onNotify('system', `删除失败: ${(err as Error).message}`)
    } finally {
      setWorking(null)
    }
  }

  return (
    <section className="owb-sheet owb-sheet--wide" role="dialog" aria-modal="true" aria-label="助理">
      <header className="owb-sheet__header">
        <div>
          <h2>
            助理 <span className="owb-beta">BETA</span>
          </h2>
          <p>选择一位助理加入任务，让专业角色帮你完成研究、分析和内容创作</p>
        </div>
        <div className="owb-sheet__header-actions">
          <button
            className="owb-sheet__primary"
            onClick={() => (formOpen ? setFormOpen(false) : openCreate())}
            data-testid="colleague-create"
          >
            <IconPlus size={14} />
            创建助理
          </button>
          <button className="owb-icon-btn" onClick={onClose} aria-label="关闭助理">
            <IconX size={16} />
          </button>
        </div>
      </header>

      <div className="owb-sheet__body">
        {formOpen ? (
          <section className="owb-form" data-testid="colleague-form">
            <div className="owb-sheet__section">
              <h3>{editingId ? '编辑档案' : '创建助理'}</h3>
              {!editingId ? (
                <div className="owb-preset-row">
                  {PRESETS.map((preset) => (
                    <button
                      key={preset.name}
                      type="button"
                      className="owb-preset"
                      onClick={() =>
                        setForm((prev) => ({
                          ...prev,
                          name: preset.name,
                          title: preset.title,
                          description: preset.description
                        }))
                      }
                    >
                      <strong>{preset.name}</strong>
                      <span>{preset.title}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="owb-colleague-grid">
              <label className="owb-field">
                <span>助理名称</span>
                <input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="例如：研究助理" maxLength={80} />
              </label>
              <label className="owb-field">
                <span>职责标签</span>
                <input value={form.title} onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))} placeholder="例如：行业研究" maxLength={120} />
              </label>
            </div>
            <label className="owb-field">
              <span>简介</span>
              <input
                value={form.description}
                onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                placeholder="一句话说明它擅长什么"
                maxLength={600}
              />
            </label>
            <label className="owb-field">
              <span>工作准则</span>
              <textarea
                value={form.instructions}
                onChange={(e) => setForm((p) => ({ ...p, instructions: e.target.value }))}
                placeholder="例如：先确认目标与范围；结论必须给出依据；不确定时明确说明。"
                rows={3}
                maxLength={4000}
              />
            </label>

            <div className="owb-sheet__section">
              <h3>权限与可见</h3>
              <div className="owb-visibility-list">
                {VISIBILITY_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`owb-visibility${form.visibility === option.id ? ' owb-visibility--on' : ''}`}
                    aria-pressed={form.visibility === option.id}
                    onClick={() => setForm((p) => ({ ...p, visibility: option.id }))}
                  >
                    <strong>{option.name}</strong>
                    <span>{option.desc}</span>
                  </button>
                ))}
              </div>
              <label className="owb-check">
                <input
                  type="checkbox"
                  checked={form.memoryEnabled}
                  onChange={(e) => setForm((p) => ({ ...p, memoryEnabled: e.target.checked }))}
                />
                <span>记忆注入</span>
                <small>关闭后，该助理后续对话不再使用你的长期记忆</small>
              </label>
            </div>

            <div className="owb-sheet__section">
              <h3>能力配置</h3>
              {skills.length === 0 ? (
                <div className="owb-card__sub">当前没有可用技能。技能加入工作区后会显示在这里。</div>
              ) : (
                <div className="owb-chip-row">
                  {skills.map((skill) => (
                    <button
                      key={skill.name}
                      type="button"
                      className={`owb-chip-button${form.skillNames.includes(skill.name) ? ' owb-chip-button--on' : ''}`}
                      aria-pressed={form.skillNames.includes(skill.name)}
                      title={skill.description}
                      onClick={() => setForm((p) => ({ ...p, skillNames: toggle(p.skillNames, skill.name) }))}
                    >
                      <IconTool size={11} />
                      {skill.name}
                    </button>
                  ))}
                </div>
              )}
              {connectors.length > 0 ? (
                <>
                  <div className="owb-card__sub">连接器</div>
                  <div className="owb-chip-row">
                    {connectors.map((connector) => (
                      <button
                        key={connector.name}
                        type="button"
                        className={`owb-chip-button${form.connectorNames.includes(connector.name) ? ' owb-chip-button--on' : ''}`}
                        aria-pressed={form.connectorNames.includes(connector.name)}
                        onClick={() => setForm((p) => ({ ...p, connectorNames: toggle(p.connectorNames, connector.name) }))}
                      >
                        {connector.displayName}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </div>

            <div className="owb-sheet__section">
              <h3>接入渠道</h3>
              <p className="owb-card__sub">绑定频道后，助理才可以在该频道的任务中被召唤。</p>
              {channels.length === 0 ? (
                <div className="owb-card__sub">还没有团队频道。在侧栏“团队频道”中创建后可在这里绑定。</div>
              ) : (
                <div className="owb-chip-row">
                  {channels.map((channel) => (
                    <button
                      key={channel.id}
                      type="button"
                      className={`owb-chip-button${form.channelIds.includes(channel.id) ? ' owb-chip-button--on' : ''}`}
                      aria-pressed={form.channelIds.includes(channel.id)}
                      onClick={() => setForm((p) => ({ ...p, channelIds: toggle(p.channelIds, channel.id) }))}
                    >
                      {channel.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="owb-form__actions">
              <button
                className="owb-sheet__action"
                onClick={() => {
                  setFormOpen(false)
                  setEditingId(null)
                }}
                disabled={working !== null}
              >
                取消
              </button>
              <button className="owb-sheet__primary" onClick={() => void save()} disabled={working !== null}>
                {working === 'create' ? '创建中…' : working ? '保存中…' : editingId ? '保存' : '创建'}
              </button>
            </div>
          </section>
        ) : null}

        {loading ? (
          <div className="owb-empty">加载中…</div>
        ) : items.length === 0 ? (
          <div className="owb-empty">
            <IconRobot size={30} />
            <strong>还没有助理</strong>
            <span>创建一个专属助理，把重复性的工作交给它。</span>
          </div>
        ) : (
          <div className="owb-card-list">
            {items.map((item) => {
              const paused = item.status === 'paused'
              return (
                <article key={item.id} className={`owb-card${paused ? ' owb-card--paused' : ''}`} data-testid="colleague-card">
                  <div className="owb-card__head">
                    <div className="owb-card__title owb-card__title--colleague">
                      <span className={`owb-avatar${paused ? ' owb-avatar--muted' : ''}`}>{item.name.slice(0, 1)}</span>
                      <span>
                        {item.name}
                        {item.title ? <span className="owb-card__tag">{item.title}</span> : null}
                        <span className={`owb-status${paused ? ' owb-status--paused' : ''}`}>{paused ? '已暂停' : '可用'}</span>
                        {item.pinnedAt ? (
                          <span className="owb-status owb-status--pinned">
                            <IconPin size={10} /> 置顶
                          </span>
                        ) : null}
                      </span>
                    </div>
                    <div className="owb-card__actions">
                      <button
                        className="owb-icon-btn"
                        onClick={() => void patch(item, { id: item.id, pinned: !item.pinnedAt }, item.pinnedAt ? '已取消置顶' : '已置顶助理')}
                        disabled={working !== null}
                        aria-label={item.pinnedAt ? `取消置顶 ${item.name}` : `置顶 ${item.name}`}
                      >
                        <IconPin size={14} />
                      </button>
                      <button className="owb-icon-btn" onClick={() => openEdit(item)} disabled={working !== null} aria-label={`编辑助理 ${item.name}`}>
                        编辑
                      </button>
                      <button
                        className="owb-icon-btn"
                        onClick={() =>
                          void patch(
                            item,
                            { id: item.id, status: paused ? 'active' : 'paused' },
                            paused ? '助理已恢复,可以继续派单' : '助理已暂停,不会再响应任务'
                          )
                        }
                        disabled={working !== null}
                        aria-label={paused ? `恢复助理 ${item.name}` : `暂停助理 ${item.name}`}
                      >
                        {paused ? <IconPlay size={14} /> : <IconPause size={14} />}
                      </button>
                      <button
                        className="owb-icon-btn owb-icon-btn--danger"
                        onClick={() => void remove(item)}
                        disabled={working !== null}
                        aria-label={`删除助理 ${item.name}`}
                      >
                        <IconTrash size={14} />
                      </button>
                    </div>
                  </div>
                  {item.description ? <p className="owb-card__text">{item.description}</p> : null}
                  {item.instructions ? <div className="owb-card__sub">准则：{item.instructions}</div> : null}
                  {item.skillNames.length > 0 || item.connectorNames.length > 0 ? (
                    <div className="owb-chip-row">
                      {item.skillNames.map((name) => (
                        <span key={name} className="owb-chip" data-testid="colleague-skill">
                          <IconTool size={11} />
                          {name}
                        </span>
                      ))}
                      {item.connectorNames.map((name) => (
                        <span key={name} className="owb-chip owb-chip--connector">
                          {name}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className="owb-card__sub owb-colleague-meta" data-testid="colleague-meta">
                    <span>{visibilityName(item.visibility)}</span>
                    <span>{item.stats.conversationCount} 个会话</span>
                    <span>用量 {usageText(item.stats.tokenUsage)}</span>
                    <span>记忆{item.memoryEnabled ? '开启' : '关闭'}</span>
                    <span>{item.channelIds.length > 0 ? `已接入 ${item.channelIds.length} 个频道` : '未接入频道'}</span>
                  </div>
                  <div className="owb-card__actions owb-card__actions--end">
                    <button
                      className="owb-sheet__primary"
                      onClick={() => onAssign(item)}
                      disabled={paused || working !== null}
                      title={paused ? '助理已暂停,恢复后才能指派任务' : undefined}
                      data-testid="colleague-assign"
                    >
                      {paused ? '已暂停' : '指派任务'}
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}

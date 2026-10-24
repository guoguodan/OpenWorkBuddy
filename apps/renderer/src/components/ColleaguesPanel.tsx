import { useCallback, useEffect, useState } from 'react'
import { IconPlus, IconRobot, IconTool, IconTrash, IconX } from './Icons'

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

/**
 * 助理面板。
 *
 * 创建表单只保留真正会影响运行时行为的字段:名称、职责、工作准则。
 * 指派任务时会新建一个会话并加载对应人设。
 */
export function ColleaguesPanel({ onClose, onNotify, onAssign }: ColleaguesPanelProps) {
  const [items, setItems] = useState<ColleagueInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')

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
  }, [refresh])

  const create = async () => {
    if (!name.trim()) {
      onNotify('system', '请填写助理名称')
      return
    }
    setWorking('create')
    try {
      await window.openwb.colleagues.create({
        name: name.trim(),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(instructions.trim() ? { instructions: instructions.trim() } : {})
      })
      setName('')
      setTitle('')
      setDescription('')
      setInstructions('')
      setCreating(false)
      await refresh()
      onNotify('info', '助理已创建')
    } catch (err) {
      onNotify('system', `创建失败: ${(err as Error).message}`)
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
          <p>选择一位助理加入任务，让专业角色帮你完成研究与创作</p>
        </div>
        <div className="owb-sheet__header-actions">
          <button className="owb-sheet__primary" onClick={() => setCreating((v) => !v)}>
            <IconPlus size={14} />
            创建助理
          </button>
          <button className="owb-icon-btn" onClick={onClose} aria-label="关闭助理">
            <IconX size={16} />
          </button>
        </div>
      </header>

      <div className="owb-sheet__body">
        {creating ? (
          <section className="owb-form">
            <div className="owb-preset-row">
              {PRESETS.map((preset) => (
                <button
                  key={preset.name}
                  type="button"
                  className="owb-preset"
                  onClick={() => {
                    setName(preset.name)
                    setTitle(preset.title)
                    setDescription(preset.description)
                  }}
                >
                  <strong>{preset.name}</strong>
                  <span>{preset.title}</span>
                </button>
              ))}
            </div>
            <label className="owb-field">
              <span>助理名称</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：研究助理" maxLength={80} />
            </label>
            <label className="owb-field">
              <span>职责标签</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：行业研究" maxLength={120} />
            </label>
            <label className="owb-field">
              <span>简介</span>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="一句话说明它擅长什么"
                maxLength={600}
              />
            </label>
            <label className="owb-field">
              <span>工作准则</span>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="例如：先确认目标与范围；结论必须给出依据；不确定时明确说明。"
                rows={4}
                maxLength={4000}
              />
            </label>
            <div className="owb-form__actions">
              <button className="owb-sheet__action" onClick={() => setCreating(false)} disabled={working !== null}>
                取消
              </button>
              <button className="owb-sheet__primary" onClick={() => void create()} disabled={working !== null}>
                {working === 'create' ? '创建中…' : '创建'}
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
            {items.map((item) => (
              <article key={item.id} className="owb-card">
                <div className="owb-card__head">
                  <div className="owb-card__title">
                    <span className="owb-avatar">{item.name.slice(0, 1)}</span>
                    <span>
                      {item.name}
                      {item.title ? <span className="owb-card__tag">{item.title}</span> : null}
                    </span>
                  </div>
                  <button
                    className="owb-icon-btn owb-icon-btn--danger"
                    onClick={() => void remove(item)}
                    disabled={working !== null}
                    aria-label={`删除助理 ${item.name}`}
                  >
                    <IconTrash size={14} />
                  </button>
                </div>
                {item.description ? <p className="owb-card__text">{item.description}</p> : null}
                {item.instructions ? <div className="owb-card__sub">准则：{item.instructions}</div> : null}
                {item.skillNames.length > 0 ? (
                  <div className="owb-card__chips">
                    {item.skillNames.map((s) => (
                      <span key={s} className="owb-chip">
                        <IconTool size={11} />
                        {s}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="owb-card__actions">
                  <button className="owb-sheet__primary" onClick={() => onAssign(item)}>
                    指派任务
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

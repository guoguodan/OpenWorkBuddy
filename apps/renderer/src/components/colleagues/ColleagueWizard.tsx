import { useState } from 'react'
import { IconCheck, IconTool, IconX } from '../Icons'
import {
  COLLEAGUE_PRESETS,
  EMPTY_COLLEAGUE_FORM,
  VISIBILITY_OPTIONS,
  toggle,
  type ColleagueFormState
} from './shared'

interface ColleagueWizardProps {
  editing: ColleagueInfo | null
  skills: Array<{ name: string; description: string }>
  connectors: Array<{ name: string; displayName: string }>
  channels: Array<{ id: string; name: string }>
  working: boolean
  onCancel: () => void
  onSave: (form: ColleagueFormState) => Promise<void>
}

function formFrom(item: ColleagueInfo): ColleagueFormState {
  return {
    name: item.name,
    title: item.title,
    description: item.description,
    instructions: item.instructions,
    visibility: item.visibility,
    memoryEnabled: item.memoryEnabled,
    skillNames: [...item.skillNames],
    connectorNames: [...item.connectorNames],
    channelIds: [...item.channelIds]
  }
}

/**
 * 两步助理向导。
 *
 * 第一步只收集"这个助理是谁",第二步才展示会影响运行的工具边界。
 * 技能、连接器和频道不是装饰项:保存后分别收窄 load_skill、第三方工具与可召唤频道。
 */
export function ColleagueWizard({
  editing,
  skills,
  connectors,
  channels,
  working,
  onCancel,
  onSave
}: ColleagueWizardProps) {
  const [step, setStep] = useState<1 | 2>(1)
  const [error, setError] = useState('')
  const [form, setForm] = useState<ColleagueFormState>(() =>
    editing ? formFrom(editing) : { ...EMPTY_COLLEAGUE_FORM }
  )
  const [showAllPresets, setShowAllPresets] = useState(false)

  const update = <K extends keyof ColleagueFormState>(key: K, value: ColleagueFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
    setError('')
  }

  const goNext = () => {
    if (!form.name.trim()) {
      setError('请填写助理名称')
      return
    }
    if (!form.title.trim()) {
      setError('请填写助理职能')
      return
    }
    setError('')
    setStep(2)
  }

  const presets = showAllPresets ? COLLEAGUE_PRESETS : COLLEAGUE_PRESETS.slice(0, 4)

  return (
    <section className="owb-collab-wizard" data-testid="colleague-form">
      <header className="owb-collab-wizard__header">
        <div>
          <h3>{editing ? '编辑档案' : '创建助理'}</h3>
          <div className="owb-collab-wizard__steps" aria-label="创建助理进度">
            <span className={step === 1 ? 'is-on' : 'is-done'}>
              <i>{step > 1 ? <IconCheck size={10} /> : 1}</i>
              基本信息
            </span>
            <span className="owb-collab-wizard__line" aria-hidden="true" />
            <span className={step === 2 ? 'is-on' : ''}>
              <i>2</i>
              能力配置
            </span>
          </div>
        </div>
        <button className="owb-icon-btn" onClick={onCancel} aria-label="关闭助理表单">
          <IconX size={16} />
        </button>
      </header>

      <div className="owb-collab-wizard__body">
        {step === 1 ? (
          <div className="owb-collab-wizard__panel" data-testid="colleague-wizard-basic">
            <label className="owb-field">
              <span>职能</span>
              <input
                value={form.title}
                onChange={(e) => update('title', e.target.value)}
                placeholder="例如：需求分析与拆解专家"
                maxLength={120}
              />
            </label>

            {!editing ? (
              <div className="owb-collab-presets">
                <div className="owb-collab-presets__head">
                  <span>助理职业快捷选项</span>
                  <button type="button" onClick={() => setShowAllPresets((prev) => !prev)}>
                    {showAllPresets ? '收起' : '查看更多'}
                  </button>
                </div>
                <div className="owb-collab-presets__grid">
                  {presets.map((preset) => (
                    <button
                      key={preset.name}
                      type="button"
                      className={`owb-collab-preset${form.name === preset.name ? ' is-on' : ''}`}
                      onClick={() => {
                        setForm((prev) => ({
                          ...prev,
                          name: preset.name,
                          title: preset.title,
                          description: preset.description
                        }))
                      }}
                    >
                      <strong>{preset.name}</strong>
                      <span>{preset.title}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <label className="owb-field">
              <span>名称</span>
              <input
                value={form.name}
                onChange={(e) => update('name', e.target.value)}
                placeholder="给他起个好听的名字~"
                maxLength={80}
              />
            </label>
            <label className="owb-field">
              <span>助理简介</span>
              <textarea
                value={form.description}
                onChange={(e) => update('description', e.target.value)}
                placeholder="描述 TA 的能力和职责..."
                rows={3}
                maxLength={600}
              />
            </label>
            <label className="owb-field">
              <span>工作准则</span>
              <textarea
                value={form.instructions}
                onChange={(e) => update('instructions', e.target.value)}
                placeholder="例如：先确认目标与范围；结论必须给出依据；不确定时明确说明。"
                rows={3}
                maxLength={4000}
              />
            </label>
          </div>
        ) : (
          <div className="owb-collab-wizard__panel" data-testid="colleague-wizard-config">
            <section className="owb-collab-advanced">
              <div className="owb-collab-advanced__head">
                <h4>能力配置（高级）</h4>
                <span>专家 / 仓库 / 资料库 / 模型</span>
              </div>

              <div className="owb-collab-block">
                <h5>助理可以连接哪些数据？</h5>
                <p>为助理绑定资料、工具或协作渠道，让 TA 在执行任务时读取正确上下文。</p>
                <div className="owb-collab-block__label">可见范围</div>
                <div className="owb-collab-visibility">
                  {VISIBILITY_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={`owb-collab-visibility__item${form.visibility === option.id ? ' is-on' : ''}`}
                      aria-pressed={form.visibility === option.id}
                      onClick={() => update('visibility', option.id)}
                    >
                      <strong>{option.name}</strong>
                      <span>{option.desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              <label className="owb-collab-switch">
                <span>
                  <strong>长期记忆</strong>
                  <small>关闭后，该助理后续对话不再注入你的长期记忆</small>
                </span>
                <input
                  type="checkbox"
                  checked={form.memoryEnabled}
                  onChange={(e) => update('memoryEnabled', e.target.checked)}
                />
              </label>

              <div className="owb-collab-block">
                <h5>技能</h5>
                <p>绑定后仅这些技能对该助理可见，技能白名单会在运行时生效。</p>
                {skills.length === 0 ? (
                  <div className="owb-collab-empty owb-collab-empty--inline">
                    当前没有可用技能。技能加入工作区后会显示在这里。
                  </div>
                ) : (
                  <div className="owb-chip-row">
                    {skills.map((skill) => (
                      <button
                        key={skill.name}
                        type="button"
                        className={`owb-chip-button${form.skillNames.includes(skill.name) ? ' owb-chip-button--on' : ''}`}
                        aria-pressed={form.skillNames.includes(skill.name)}
                        title={skill.description}
                        onClick={() => update('skillNames', toggle(form.skillNames, skill.name))}
                      >
                        <IconTool size={11} />
                        {skill.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {connectors.length > 0 ? (
                <div className="owb-collab-block">
                  <h5>连接器</h5>
                  <p>未绑定的连接器工具不会出现在助理的可用工具列表中。</p>
                  <div className="owb-chip-row">
                    {connectors.map((connector) => (
                      <button
                        key={connector.name}
                        type="button"
                        className={`owb-chip-button${form.connectorNames.includes(connector.name) ? ' owb-chip-button--on' : ''}`}
                        aria-pressed={form.connectorNames.includes(connector.name)}
                        onClick={() => update('connectorNames', toggle(form.connectorNames, connector.name))}
                      >
                        {connector.displayName}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="owb-collab-block">
                <h5>频道</h5>
                <p>绑定频道后，助理才可以在该频道中被召唤；未绑定频道会被运行时拒绝。</p>
                {channels.length === 0 ? (
                  <div className="owb-collab-empty owb-collab-empty--inline">
                    还没有团队频道。在侧栏“团队频道”中创建后可在这里绑定。
                  </div>
                ) : (
                  <div className="owb-chip-row">
                    {channels.map((channel) => (
                      <button
                        key={channel.id}
                        type="button"
                        className={`owb-chip-button${form.channelIds.includes(channel.id) ? ' owb-chip-button--on' : ''}`}
                        aria-pressed={form.channelIds.includes(channel.id)}
                        onClick={() => update('channelIds', toggle(form.channelIds, channel.id))}
                      >
                        {channel.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>
        )}
      </div>

      {error ? <p className="owb-collab-wizard__error">{error}</p> : null}

      <footer className="owb-collab-wizard__footer">
        {step === 1 ? (
          <button className="owb-sheet__action" onClick={onCancel} disabled={working}>
            取消
          </button>
        ) : (
          <button className="owb-sheet__action" onClick={() => setStep(1)} disabled={working}>
            上一步
          </button>
        )}
        {step === 1 ? (
          <button className="owb-sheet__primary" onClick={goNext} disabled={working} data-testid="colleague-next">
            下一步
          </button>
        ) : (
          <button
            className="owb-sheet__primary"
            onClick={() => void onSave(form)}
            disabled={working}
            data-testid="colleague-save"
          >
            {working ? '保存中…' : editing ? '保存' : '创建'}
          </button>
        )}
      </footer>
    </section>
  )
}

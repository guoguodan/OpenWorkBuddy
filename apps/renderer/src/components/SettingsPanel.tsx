import { useEffect, useState } from 'react'
import { IconBrain, IconFolder, IconSparkle, IconUsers, IconX } from './Icons'
import type { PermissionMode } from './Composer'

export interface WorkspaceSettingsInfo {
  permissionMode: PermissionMode
  taskTarget: 'local'
  model: string | null
  fallbackModel: string | null
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
  tokenBudget: number
  disabledSkills?: string[]
  pinnedSkills?: string[]
  openSkillsDir?: string
}

interface SettingsPanelProps {
  settings: WorkspaceSettingsInfo
  model: string
  workspace: string
  memoryCount: number
  channelCount: number
  onOpenWorkspace: () => void
  onOpenMemory: () => void
  onOpenChannels: () => void
  onOpenGrants: () => void
  onPermissionChange: (mode: PermissionMode) => Promise<void>
  /** 备用模型候选与主模型一致,来自网关真实清单。 */
  fallbackModelDraft?: string | null
  onFallbackModelChange: (name: string | null) => Promise<void>
  onTokenBudgetChange: (value: number) => Promise<void>
  onClose: () => void
}

const PERMISSIONS: Array<{ id: PermissionMode; label: string; detail: string }> = [
  { id: 'default', label: '默认权限', detail: '写入、命令、删除等敏感操作在使用前弹窗确认。' },
  {
    id: 'fullAccess',
    label: '完全访问',
    detail: '已知风险自动放行；计费类与未知风险仍会询问，模式边界不会被扩大。'
  },
  { id: 'readOnly', label: '只读', detail: '禁止写文件、执行命令、删除/移动文件与交付新文件。' }
]

/**
 * 设置面板。
 *
 * 记忆、频道、授权这些能力在真实产品里没有放在主侧栏,但底层仍然存在。
 * 把它们集中到"账号与设置"入口,既保持导航 1:1,也不丢已有能力。
 */
export function SettingsPanel({
  settings,
  model,
  workspace,
  memoryCount,
  channelCount,
  onOpenWorkspace,
  onOpenMemory,
  onOpenChannels,
  onOpenGrants,
  onPermissionChange,
  fallbackModelDraft,
  onFallbackModelChange,
  onTokenBudgetChange,
  onClose
}: SettingsPanelProps) {
  const [saving, setSaving] = useState<PermissionMode | null>(null)
  const [fallbackDraft, setFallbackDraft] = useState('')
  const [fallbackSaving, setFallbackSaving] = useState(false)
  const [budgetDraft, setBudgetDraft] = useState('')
  const [budgetSaving, setBudgetSaving] = useState(false)

  useEffect(() => {
    setFallbackDraft(settings.fallbackModel ?? '')
  }, [settings.fallbackModel])

  useEffect(() => {
    setBudgetDraft(settings.tokenBudget > 0 ? String(settings.tokenBudget) : '')
  }, [settings.tokenBudget])

  const currentFallback = (fallbackModelDraft ?? settings.fallbackModel ?? '').trim()
  const saveFallback = async (value: string | null) => {
    if (fallbackSaving) return
    setFallbackSaving(true)
    try {
      await onFallbackModelChange(value)
    } finally {
      setFallbackSaving(false)
    }
  }

  return (
    <section className="owb-sheet" role="dialog" aria-modal="true" aria-label="设置">
      <header className="owb-sheet__header">
        <div>
          <h2>账号与设置</h2>
          <p>本地运行 · 所有文件读写都在当前工作区内</p>
        </div>
        <button className="owb-icon-btn" onClick={onClose} aria-label="关闭设置">
          <IconX size={16} />
        </button>
      </header>

      <div className="owb-sheet__body">
        <section className="owb-sheet__section">
          <h3>权限档位</h3>
          <div className="owb-permission-list" role="radiogroup" aria-label="权限档位">
            {PERMISSIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={settings.permissionMode === item.id}
                className={`owb-permission${settings.permissionMode === item.id ? ' owb-permission--on' : ''}`}
                disabled={saving !== null}
                onClick={() => {
                  setSaving(item.id)
                  void onPermissionChange(item.id).finally(() => setSaving(null))
                }}
              >
                <span className="owb-permission__title">
                  {item.label}
                  {settings.permissionMode === item.id ? <span className="owb-permission__badge">当前</span> : null}
                  {saving === item.id ? <span className="owb-permission__badge">保存中…</span> : null}
                </span>
                <span className="owb-permission__detail">{item.detail}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="owb-sheet__section">
          <h3>运行环境</h3>
          <div className="owb-kv">
            <span>模型</span>
            <span>{model || '(未配置)'}</span>
          </div>
          <div className="owb-kv owb-kv--stack">
            <span>备用模型</span>
            <div className="owb-fallback-row">
              <input
                value={fallbackDraft}
                onChange={(event) => setFallbackDraft(event.target.value)}
                placeholder="主模型连续失败时使用;留空则不降级"
                aria-label="备用模型"
                data-testid="fallback-model-input"
                disabled={fallbackSaving}
              />
              <button
                type="button"
                className="owb-sheet__action"
                disabled={fallbackSaving || fallbackDraft.trim() === currentFallback}
                onClick={() => void saveFallback(fallbackDraft.trim() || null)}
                data-testid="fallback-model-save"
              >
                {fallbackSaving ? '保存中…' : '保存'}
              </button>
              {currentFallback ? (
                <button
                  type="button"
                  className="owb-sheet__action"
                  disabled={fallbackSaving}
                  data-testid="fallback-model-clear"
                  onClick={() => {
                    setFallbackDraft('')
                    void saveFallback(null)
                  }}
                >
                  清除
                </button>
              ) : null}
            </div>
            <span className="owb-settings-hint">
              仅当主模型重试耗尽、且本步尚未产生任何输出时切换;已开始的回复不会中途换模型。
            </span>
          </div>
          <div className="owb-kv">
            <span>任务位置</span>
            <span>{settings.taskTarget === 'local' ? '本地电脑' : settings.taskTarget}</span>
          </div>
          <div className="owb-kv owb-kv--stack">
            <span>单轮成本上限</span>
            <div className="owb-fallback-row">
              <input
                value={budgetDraft}
                onChange={(event) => setBudgetDraft(event.target.value.replace(/[^0-9]/g, ''))}
                placeholder="输入 token 数;留空表示不限制"
                aria-label="单轮 token 上限"
                inputMode="numeric"
                data-testid="token-budget-input"
                disabled={budgetSaving}
              />
              <button
                type="button"
                className="owb-sheet__action"
                disabled={budgetSaving || budgetDraft === (settings.tokenBudget > 0 ? String(settings.tokenBudget) : '')}
                onClick={() => {
                  setBudgetSaving(true)
                  void onTokenBudgetChange(Number(budgetDraft || 0)).finally(() => setBudgetSaving(false))
                }}
                data-testid="token-budget-save"
              >
                {budgetSaving ? '保存中…' : '保存'}
              </button>
            </div>
            <span className="owb-settings-hint">
              按网关返回的输入+输出 token 实时核算。达到上限后立即停止后续模型调用,已生成内容保留。
            </span>
          </div>
          <div className="owb-kv owb-kv--stack">
            <span>工作区</span>
            <code>{workspace || '(未知)'}</code>
          </div>
          <button className="owb-sheet__action" onClick={onOpenWorkspace}>
            <IconFolder size={14} />
            在资源管理器中打开工作区
          </button>
        </section>

        <section className="owb-sheet__section">
          <h3>更多能力</h3>
          <div className="owb-sheet__grid">
            <button className="owb-sheet__tile" onClick={onOpenMemory}>
              <IconBrain size={16} />
              <span>记忆</span>
              <small>{memoryCount} 条</small>
            </button>
            <button className="owb-sheet__tile" onClick={onOpenChannels}>
              <IconUsers size={16} />
              <span>频道与同步</span>
              <small>{channelCount} 个</small>
            </button>
            <button className="owb-sheet__tile" onClick={onOpenGrants}>
              <IconSparkle size={16} />
              <span>长期授权</span>
              <small>查看与撤销</small>
            </button>
          </div>
        </section>
      </div>
    </section>
  )
}

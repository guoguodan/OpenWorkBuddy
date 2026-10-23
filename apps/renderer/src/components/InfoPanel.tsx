import { IconSparkle, IconTool, IconX } from './Icons'

export interface SkillInfo {
  name: string
  description: string
  scope: string
}

interface InfoPanelProps {
  kind: 'skills' | 'connectors'
  skills: SkillInfo[]
  model: string
  workspace: string
  onOpenWorkspace: () => void
  onClose: () => void
}

export function InfoPanel({ kind, skills, model, workspace, onOpenWorkspace, onClose }: InfoPanelProps) {
  return (
    <div className="owb-infopanel" role="dialog" aria-label={kind === 'skills' ? '技能' : '模型与连接器'}>
      <div className="owb-infopanel__header">
        <div className="owb-infopanel__title">
          {kind === 'skills' ? <IconTool size={16} /> : <IconSparkle size={16} />}
          <span>{kind === 'skills' ? `技能 (${skills.length})` : '模型 · 连接器'}</span>
        </div>
        <button className="owb-icon-btn" onClick={onClose} aria-label="关闭面板">
          <IconX size={16} />
        </button>
      </div>

      <div className="owb-infopanel__body">
        {kind === 'skills' ? (
          skills.length > 0 ? (
            skills.map((s) => (
              <div key={s.name} className="owb-infopanel__card">
                <div className="owb-infopanel__card-head">
                  <span className="owb-infopanel__name">{s.name}</span>
                  <span className="owb-infopanel__tag">{s.scope}</span>
                </div>
                <div className="owb-infopanel__desc">{s.description}</div>
              </div>
            ))
          ) : (
            <div className="owb-infopanel__empty">未发现技能。把技能目录放到 resources/skills 下即可。</div>
          )
        ) : (
          <>
            <div className="owb-infopanel__card">
              <div className="owb-infopanel__card-head">
                <span className="owb-infopanel__name">当前模型</span>
                <span className="owb-infopanel__tag owb-infopanel__tag--brand">OpenAI 兼容</span>
              </div>
              <div className="owb-infopanel__desc">{model || '(未配置)'}</div>
              <div className="owb-infopanel__hint">通过 .env 里的 OPENWB_MODEL / OPENAI_BASE_URL 配置</div>
            </div>
            <div className="owb-infopanel__card">
              <div className="owb-infopanel__card-head">
                <span className="owb-infopanel__name">工作区</span>
              </div>
              <div className="owb-infopanel__desc owb-infopanel__desc--mono">{workspace || '(未知)'}</div>
              <div className="owb-infopanel__hint">工具读写的根目录;绝对路径不在此目录内的文件会被拒绝</div>
              <button className="owb-infopanel__action" onClick={onOpenWorkspace}>
                在资源管理器中打开
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
import { IconChat, IconFolder, IconSearch, IconSparkle, IconTool } from './Icons'
import { ModeTabs, type ModeInfo } from './ModeTabs'

interface WelcomeViewProps {
  modes: ModeInfo[]
  mode: string
  busy: boolean
  children: React.ReactNode
  onModeChange: (id: string) => void
  onQuickAction: (text: string) => void
}

const QUICK_ACTIONS = [
  { icon: IconSearch, label: '看看当前项目的结构' },
  { icon: IconTool, label: '帮我做一次代码审查' },
  { icon: IconFolder, label: '整理一份调研文档' },
  { icon: IconSparkle, label: '给我一个执行计划' },
  { icon: IconChat, label: '解释一下这段代码' }
]

export function WelcomeView({ modes, mode, busy, children, onModeChange, onQuickAction }: WelcomeViewProps) {
  return (
    <div className="owb-welcome">
      <div className="owb-welcome__body">
        <div className="owb-welcome__hero">
          <h1>今天想让我做什么?</h1>
          <p>读写本地文件、跑命令、查资料,一个对话框搞定。</p>
        </div>

        <ModeTabs modes={modes} mode={mode} busy={busy} variant="scene" onSelect={onModeChange} />

        <div className="owb-quick-actions">
          <div className="owb-quick-actions__list">
            {QUICK_ACTIONS.map((a) => (
              <button key={a.label} className="owb-quick-action" onClick={() => onQuickAction(a.label)} disabled={busy}>
                <a.icon size={14} />
                {a.label}
              </button>
            ))}
          </div>
        </div>

        {children}
      </div>
      <div className="owb-footer">内容由 AI 生成,请核实重要信息</div>
    </div>
  )
}
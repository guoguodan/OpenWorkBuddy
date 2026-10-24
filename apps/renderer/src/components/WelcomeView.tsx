import { IconBriefcase, IconBulb, IconCalendar, IconClock, IconCode, IconFile, IconMonitor, IconPalette, IconSearch, IconSparkle } from './Icons'

export type SceneId = 'working' | 'coding' | 'design'

interface WelcomeViewProps {
  scene: SceneId
  busy: boolean
  children: React.ReactNode
  onSceneChange: (id: SceneId) => void
  onQuickAction: (text: string) => void
}

const SCENES: Array<{
  id: SceneId
  label: string
  icon: typeof IconBriefcase
  subtitle: string
}> = [
  { id: 'working', label: '办公', icon: IconBriefcase, subtitle: '文档、表格、汇报，直接交付可用的成果' },
  { id: 'coding', label: '开发', icon: IconCode, subtitle: '读代码、改实现、跑测试，按工程规范推进' },
  { id: 'design', label: '设计', icon: IconPalette, subtitle: '梳理信息层级，产出页面结构与视觉方案' }
]

const CAPABILITIES = [
  { label: '文档', icon: IconFile, prompt: '帮我写一份结构完整、可直接汇报的工作文档' },
  { label: '金融服务', icon: IconSparkle, prompt: '帮我整理一份金融业务分析，梳理关键指标与风险点' },
  { label: '分析数据', icon: IconMonitor, prompt: '分析这份数据，找出趋势、异常并给出结论' },
  { label: '制作PPT', icon: IconPalette, prompt: '帮我做一份 10 页的汇报 PPT 大纲与逐页文案' },
  { label: '深度研究', icon: IconSearch, prompt: '对这个主题做一次深度研究，给出结论与依据' },
  { label: '策划方案', icon: IconBulb, prompt: '帮我策划一份可落地的活动方案，包含目标、节奏与预算' },
  { label: '定时任务', icon: IconCalendar, prompt: '帮我创建一个每天自动汇总进展的定时任务' }
]

const SUGGESTIONS: Array<{ text: string; icon: typeof IconSparkle }> = [
  { text: '最近 AI 行业变了什么，给我一份变更日志', icon: IconClock },
  { text: '期权快到期了，怎么避免白白亏钱', icon: IconSparkle },
  { text: '用一周练习提升短视频剪辑与创意', icon: IconPalette },
  { text: '做一份能展示能力的作品案例模板', icon: IconFile }
]

/**
 * 首页:与真实产品保持同一骨架。
 *
 * 场景只改变本轮的系统提示,不改变可用工具;因此切换场景不会意外扩大权限。
 * 能力胶囊与推荐问题是把用户带进具体任务的"起手式",都直接写入输入框,
 * 不做隐式发送——用户仍可以改完再按回车。
 */
export function WelcomeView({ scene, busy, children, onSceneChange, onQuickAction }: WelcomeViewProps) {
  return (
    <div className="owb-welcome" data-testid="welcome">
      <div className="owb-welcome__body">
        <div className="owb-welcome__hero">
          <h1>WorkBuddy, 我帮你</h1>
        </div>

        <div className="owb-scene-tabs" role="tablist" aria-label="工作场景">
          {SCENES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              data-scene={item.id}
              aria-selected={scene === item.id}
              title={item.subtitle}
              disabled={busy}
              onClick={() => onSceneChange(item.id)}
              className={`owb-scene-tab${scene === item.id ? ' owb-scene-tab--active' : ''}`}
            >
              <item.icon size={16} className="owb-scene-tab__icon" />
              {item.label}
            </button>
          ))}
        </div>

        <div className="owb-capabilities" aria-label="常用能力">
          {CAPABILITIES.map((item) => (
            <button
              key={item.label}
              type="button"
              className="owb-capability"
              onClick={() => onQuickAction(item.prompt)}
              disabled={busy}
            >
              <item.icon size={14} />
              {item.label}
            </button>
          ))}
        </div>

        {children}

        <div className="owb-suggestions" aria-label="推荐问题">
          {SUGGESTIONS.map((item) => (
            <button
              key={item.text}
              type="button"
              className="owb-suggestion"
              onClick={() => onQuickAction(item.text)}
              disabled={busy}
            >
              {item.text}
              <span className="owb-suggestion__arrow">↗</span>
            </button>
          ))}
        </div>
      </div>
      <div className="owb-footer">内容由 AI 生成，请核实重要信息</div>
    </div>
  )
}

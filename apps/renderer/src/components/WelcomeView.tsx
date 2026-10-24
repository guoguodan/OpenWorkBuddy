import { useEffect, useMemo, useState } from 'react'
import {
  IconBriefcase,
  IconBulb,
  IconCalendar,
  IconClock,
  IconCode,
  IconFile,
  IconMonitor,
  IconPalette,
  IconRefresh,
  IconSearch,
  IconSparkle
} from './Icons'

export type SceneId = 'working' | 'coding' | 'design'

interface WelcomeViewProps {
  scene: SceneId
  busy: boolean
  children: React.ReactNode
  onSceneChange: (id: SceneId) => void
  onQuickAction: (text: string) => void
}

interface Capability {
  label: string
  icon: typeof IconFile
  prompt: string
}

interface Suggestion {
  text: string
  icon: typeof IconSparkle
}

interface SceneConfig {
  label: string
  icon: typeof IconBriefcase
  subtitle: string
  heroSubtitle: string
  capabilities: Capability[]
  suggestionGroups: Suggestion[][]
}

const SCENES: Record<SceneId, SceneConfig> = {
  working: {
    label: '办公',
    icon: IconBriefcase,
    subtitle: '文档、表格、汇报，直接交付可用的成果',
    heroSubtitle: '你的职场超能力',
    capabilities: [
      { label: '文档', icon: IconFile, prompt: '帮我写一份结构完整、可直接汇报的工作文档' },
      { label: '金融服务', icon: IconSparkle, prompt: '帮我整理一份金融业务分析，梳理关键指标与风险点' },
      { label: '分析数据', icon: IconMonitor, prompt: '分析这份数据，找出趋势、异常并给出结论' },
      { label: '制作PPT', icon: IconPalette, prompt: '帮我做一份 10 页的汇报 PPT 大纲与逐页文案' },
      { label: '深度研究', icon: IconSearch, prompt: '对这个主题做一次深度研究，给出结论与依据' },
      { label: '策划方案', icon: IconBulb, prompt: '帮我策划一份可落地的活动方案，包含目标、节奏与预算' },
      { label: '定时任务', icon: IconCalendar, prompt: '帮我创建一个每天自动汇总进展的定时任务' }
    ],
    suggestionGroups: [
      [
        { text: '最近 AI 行业变了什么，给我一份变更日志', icon: IconClock },
        { text: '期权快到期了，怎么避免白白亏钱', icon: IconSparkle },
        { text: '用一周练习提升短视频剪辑与创意', icon: IconPalette },
        { text: '做一份能展示能力的作品案例模板', icon: IconFile }
      ],
      [
        { text: '把这份会议记录整理成纪要和待办', icon: IconFile },
        { text: '帮我写一封得体的项目延期说明邮件', icon: IconSparkle },
        { text: '分析这组销售数据，找出增长与流失原因', icon: IconMonitor },
        { text: '把这批资料提炼成一页纸汇报', icon: IconClock }
      ],
      [
        { text: '给新同事准备一份入职指引文档', icon: IconFile },
        { text: '对比两版方案，列出差异与取舍建议', icon: IconSearch },
        { text: '把长文档压缩成 5 条关键结论', icon: IconBulb },
        { text: '帮我规划下周的工作优先级', icon: IconCalendar }
      ]
    ]
  },
  coding: {
    label: '开发',
    icon: IconCode,
    subtitle: '读代码、改实现、跑测试，按工程规范推进',
    heroSubtitle: '你的开发超能力',
    capabilities: [
      { label: '代码审查', icon: IconSearch, prompt: '审查这段代码，指出正确性、安全性和可维护性问题' },
      { label: '修复缺陷', icon: IconCode, prompt: '复现并修复这个问题，说明根因和改动范围' },
      { label: '编写测试', icon: IconChecklist, prompt: '为这块逻辑补充单元测试，覆盖边界条件' },
      { label: '重构代码', icon: IconRefresh, prompt: '在不改变行为的前提下重构这段代码，并解释理由' },
      { label: '阅读仓库', icon: IconFile, prompt: '梳理这个仓库的结构，说明核心模块与调用链' },
      { label: '生成文档', icon: IconBulb, prompt: '基于现有代码生成一份开发与使用文档' },
      { label: '性能分析', icon: IconMonitor, prompt: '分析这段实现的性能瓶颈，给出可验证的优化方案' }
    ],
    suggestionGroups: [
      [
        { text: '帮我找出这个仓库最容易出问题的模块', icon: IconSearch },
        { text: '为登录流程补一组边界测试', icon: IconChecklist },
        { text: '解释这段异步代码为什么偶发超时', icon: IconClock },
        { text: '把这个脚本改造成可测试的模块', icon: IconCode }
      ],
      [
        { text: '审查最近的改动，重点看错误处理', icon: IconSearch },
        { text: '给这个接口补一份请求与响应说明', icon: IconFile },
        { text: '分析构建变慢的原因并给出优化步骤', icon: IconMonitor },
        { text: '帮我设计一个更稳妥的重试策略', icon: IconRefresh }
      ],
      [
        { text: '检查依赖里是否有已知风险版本', icon: IconSearch },
        { text: '把重复逻辑抽成公共函数并列出自测点', icon: IconRefresh },
        { text: '为这个模块补一份清晰的 README', icon: IconFile },
        { text: '梳理一次线上问题的排查路径', icon: IconBulb }
      ]
    ]
  },
  design: {
    label: '设计',
    icon: IconPalette,
    subtitle: '梳理信息层级，产出页面结构与视觉方案',
    heroSubtitle: '你的设计超能力',
    capabilities: [
      { label: '页面设计', icon: IconPalette, prompt: '为这个功能设计一个清晰的页面结构与信息层级' },
      { label: '交互梳理', icon: IconMonitor, prompt: '梳理这个流程的交互步骤，指出容易卡住的环节' },
      { label: '视觉规范', icon: IconSparkle, prompt: '整理一套可复用的视觉规范，包括颜色、字号与间距' },
      { label: '原型方案', icon: IconBulb, prompt: '给出一个可快速验证的低保真原型方案' },
      { label: '竞品分析', icon: IconSearch, prompt: '对比同类产品的关键页面，总结可借鉴的设计取舍' },
      { label: '文案润色', icon: IconFile, prompt: '把这段界面文案改得更清楚、更符合产品语气' },
      { label: '可用性检查', icon: IconChecklist, prompt: '按可用性原则检查这个页面，列出具体问题与改法' }
    ],
    suggestionGroups: [
      [
        { text: '帮我设计一个更清晰的任务首页', icon: IconPalette },
        { text: '这个表单太多字段，帮我做减法', icon: IconMonitor },
        { text: '给空状态补一套引导文案与操作', icon: IconBulb },
        { text: '整理一组适合后台产品的配色', icon: IconSparkle }
      ],
      [
        { text: '对比两种导航结构，说明各自代价', icon: IconSearch },
        { text: '把这段流程改成三步以内完成', icon: IconMonitor },
        { text: '检查这个页面的信息层级是否清楚', icon: IconPalette },
        { text: '为移动端重排这个页面', icon: IconChecklist }
      ],
      [
        { text: '给新功能设计一套首次使用引导', icon: IconBulb },
        { text: '把这个报错提示改得可行动', icon: IconFile },
        { text: '分析这个页面的视觉重点在哪里', icon: IconPalette },
        { text: '输出一份设计评审清单', icon: IconChecklist }
      ]
    ]
  }
}

const SCENE_ORDER: SceneId[] = ['working', 'coding', 'design']

/**
 * 首页:与真实产品保持同一骨架。
 *
 * 场景只改变本轮的系统提示与推荐内容,不改变可用工具;因此切换场景不会
 * 意外扩大权限。能力胶囊与推荐问题是把用户带进具体任务的"起手式",都只
 * 写入输入框,不做隐式发送——用户仍可以改完再按回车。
 */
export function WelcomeView({ scene, busy, children, onSceneChange, onQuickAction }: WelcomeViewProps) {
  const [rounds, setRounds] = useState<Record<SceneId, number>>({ working: 0, coding: 0, design: 0 })
  const config = SCENES[scene]
  const round = rounds[scene] % config.suggestionGroups.length
  const suggestions = useMemo(
    () => config.suggestionGroups[round] ?? config.suggestionGroups[0] ?? [],
    [config, round]
  )

  useEffect(() => {
    document.documentElement.dataset.scene = scene
  }, [scene])

  const refresh = () => {
    setRounds((prev) => ({
      ...prev,
      [scene]: (prev[scene] + 1) % config.suggestionGroups.length
    }))
  }

  return (
    <div className="owb-welcome" data-testid="welcome" data-scene={scene}>
      <div className="owb-welcome__body">
        <div className="owb-welcome__hero">
          <h1>WorkBuddy, 我帮你</h1>
          <p>{config.heroSubtitle}</p>
        </div>

        <div className="owb-scene-tabs" role="tablist" aria-label="场景切换">
          {SCENE_ORDER.map((id) => {
            const item = SCENES[id]
            return (
              <button
                key={id}
                type="button"
                role="tab"
                data-scene={id}
                aria-selected={scene === id}
                title={item.subtitle}
                disabled={busy}
                onClick={() => onSceneChange(id)}
                className={`owb-scene-tab${scene === id ? ' owb-scene-tab--active' : ''}`}
              >
                <item.icon size={16} className="owb-scene-tab__icon" />
                {item.label}
              </button>
            )
          })}
        </div>

        <div className="owb-capabilities" aria-label="常用能力" data-testid="capabilities">
          {config.capabilities.map((item) => (
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
          {suggestions.map((item) => (
            <button
              key={item.text}
              type="button"
              className="owb-suggestion"
              data-testid="suggestion"
              onClick={() => onQuickAction(item.text)}
              disabled={busy}
            >
              {item.text}
              <span className="owb-suggestion__arrow">↗</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="owb-suggestion-refresh"
          data-testid="refresh-suggestions"
          onClick={refresh}
          disabled={busy}
        >
          <IconRefresh size={13} />
          换一批
        </button>
      </div>
      <div className="owb-footer">内容由 AI 生成，请核实重要信息</div>
    </div>
  )
}

function IconChecklist({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="m3.5 6 1.5 1.5L7.5 5M3.5 12 5 13.5 7.5 11M3.5 18 5 19.5 7.5 17" />
    </svg>
  )
}

export type ColleagueFilter = 'all' | 'idle' | 'working' | 'abnormal'
export type ColleagueState = 'idle' | 'working' | 'abnormal' | 'disabled'

export type ColleagueFormState = {
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

export const EMPTY_COLLEAGUE_FORM: ColleagueFormState = {
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

export const COLLEAGUE_PRESETS = [
  {
    name: '需求分析师',
    title: '需求分析与拆解',
    description: '擅长理解业务背景、拆解用户诉求、梳理验收标准，并输出可执行的产品方案。'
  },
  {
    name: '行业研究员',
    title: '行业研究',
    description: '负责行业研究与趋势分析，擅长政策解读、竞争格局梳理、数据验证和洞察提炼。'
  },
  {
    name: '数据分析员',
    title: '数据分析',
    description: '负责指标体系、数据看板和专题分析，擅长发现问题、验证假设并输出决策建议。'
  },
  {
    name: '内容创作专员',
    title: '内容创作',
    description: '负责内容策划与创作产出，擅长选题挖掘、图文脚本、文案撰写和质量把控。'
  },
  {
    name: '产品经理',
    title: '产品规划',
    description: '负责需求规划、方案设计与跨团队推进，擅长拆解目标、对齐范围和保障交付。'
  },
  {
    name: '代码审查员',
    title: '研发协作',
    description: '负责代码评审与质量把关，擅长规范检查、隐患识别和改进建议。'
  },
  {
    name: '项目经理',
    title: '项目交付',
    description: '负责计划排期、资源协调和风险管理，擅长跨团队推进、进度跟踪和按期交付。'
  },
  {
    name: '文档生成员',
    title: '文档与知识沉淀',
    description: '负责技术文档、接入指南和知识沉淀，擅长结构化表达、示例编写和版本同步。'
  }
] as const

export const VISIBILITY_OPTIONS = [
  { id: 'personal' as const, name: '个人分身', desc: '仅你可见' },
  { id: 'project' as const, name: '发布到项目', desc: '项目成员可协作' },
  { id: 'public' as const, name: '公开', desc: '团队外可用' }
]

const AVATAR_COLORS = ['#c7f0e5', '#d8e6ff', '#ffe2b8', '#e7d9ff', '#ffd9df', '#d6f1c9', '#f8e7b8', '#d3ecf5']

export function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}

export function usageText(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return String(tokens)
}

export function visibilityName(value: ColleagueInfo['visibility']): string {
  return VISIBILITY_OPTIONS.find((item) => item.id === value)?.name ?? value
}

export function colleagueState(item: ColleagueInfo): ColleagueState {
  if (item.status === 'paused') return 'disabled'
  if (item.stats.runningTasks > 0) return 'working'
  if (item.stats.failedTasks > 0) return 'abnormal'
  return 'idle'
}

export function stateLabel(state: ColleagueState): string {
  if (state === 'working') return '工作中'
  if (state === 'abnormal') return '异常'
  if (state === 'disabled') return '已停用'
  return '空闲'
}

export function matchesFilter(item: ColleagueInfo, filter: ColleagueFilter): boolean {
  const state = colleagueState(item)
  if (filter === 'all') return true
  if (filter === 'abnormal') return state === 'abnormal' || state === 'disabled'
  return state === filter
}

export function formatDay(value: string | null): string {
  if (!value) return '暂无记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '暂无记录'
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function ColleagueAvatar({
  item,
  size = 57,
  className = ''
}: {
  item: Pick<ColleagueInfo, 'id' | 'name'>
  size?: number
  className?: string
}) {
  const index = [...item.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % AVATAR_COLORS.length
  return (
    <span
      className={`owb-collab-avatar ${className}`.trim()}
      style={{ width: size, height: size, background: AVATAR_COLORS[index] }}
      aria-hidden="true"
    >
      {item.name.slice(0, 1)}
    </span>
  )
}

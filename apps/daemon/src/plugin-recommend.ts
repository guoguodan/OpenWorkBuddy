/**
 * 任务匹配推荐(WM-PLUGIN-04)。
 *
 * 只根据本地已安装插件的清单与任务文本打分,不调用模型、不访问网络,
 * 因此推荐结果可测试、可复现。规则有三条硬约束:
 *   1. 已连接的连接器不再推荐;
 *   2. 当前会话正在使用的专家不再推荐;
 *   3. 最多返回 3 条,按匹配强度排序。
 */

export interface RecommendablePlugin {
  name: string
  displayName: string
  description: string
  kind: 'connector' | 'expert'
  enabled: boolean
  permissions: string[]
  tools: Array<{ name: string; description: string }>
  /** 专家专业准则;连接器为空 */
  instructions?: string
  /** 专家团队成员;连接器为空 */
  team?: Array<{ ref: string; role: string | null }>
}

export interface PluginRecommendation {
  name: string
  displayName: string
  kind: 'connector' | 'expert'
  description: string
  /** 面向用户的推荐理由,不包含插件提示词原文 */
  reason: string
  /** 命中的关键词,便于界面解释排序 */
  matched: string[]
  score: number
  permissions: string[]
}

export interface RecommendOptions {
  /** 当前会话绑定的专家;同一个专家不重复推荐 */
  activeExpertId?: string | null
}

export const MAX_RECOMMENDATIONS = 3

/**
 * 这些二元组只表达"请求语气"或通用动作,命中它们没有区分度。
 * 宁可少推,也不要把"帮我写一份"误判成插件意图。
 */
const CN_STOPWORDS = new Set([
  '帮我',
  '我一',
  '一份',
  '一个',
  '一下',
  '一些',
  '这个',
  '那个',
  '这些',
  '那些',
  '我的',
  '你的',
  '我们',
  '你们',
  '他们',
  '请你',
  '给我',
  '需要',
  '可以',
  '能否',
  '是否',
  '怎么',
  '如何',
  '什么',
  '以及',
  '并且',
  '然后',
  '还是',
  '就是',
  '如果',
  '因为',
  '所以',
  '但是',
  '进行',
  '相关',
  '有关',
  '里面',
  '上的',
  '里的',
  '中的',
  '现在',
  '今天',
  '明天',
  '想要',
  '希望',
  '请帮',
  '帮忙',
  '写一',
  '做一',
  '弄一',
  '看看',
  '看一',
  '整理',
  '处理',
  '完成',
  '支持',
  '使用',
  '通过',
  '关于',
  '对于',
  '根据',
  '按照'
])

const CN_STOP_CHARS = new Set('我你他她它的了是在和与及或把被给对从到为请帮一个些这那上下里中并而就都也还又很更最'.split(''))

const EN_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'to',
  'of',
  'in',
  'on',
  'for',
  'with',
  'please',
  'help',
  'me',
  'my',
  'our',
  'this',
  'that',
  'what',
  'how',
  'can',
  'could',
  'would',
  'should',
  'i',
  'we',
  'you',
  'it',
  'is',
  'are',
  'do',
  'does',
  'make',
  'get',
  'use',
  'using',
  'need',
  'want',
  'about',
  'from',
  'into',
  'some',
  'any'
])

/** 中文按二元组切分;英文/数字按词切分。任务很短时仍能命中"合同""jira"这类核心词。 */
export function tokenizeTask(text: string): string[] {
  const out = new Set<string>()
  const lower = text.toLowerCase()
  for (const match of lower.matchAll(/[a-z0-9][a-z0-9.+#_-]*/g)) {
    const token = match[0]
    if (token.length < 2 || EN_STOPWORDS.has(token)) continue
    out.add(token)
  }
  for (const match of lower.matchAll(/[\u3400-\u9fff]+/g)) {
    const run = match[0]
    if (run.length < 2) continue
    for (let i = 0; i < run.length - 1; i++) {
      const token = run.slice(i, i + 2)
      if (CN_STOPWORDS.has(token)) continue
      if (CN_STOP_CHARS.has(token[0]!) && CN_STOP_CHARS.has(token[1]!)) continue
      out.add(token)
    }
  }
  return [...out]
}

interface HaystackField {
  text: string
  weight: number
}

function haystackOf(plugin: RecommendablePlugin): HaystackField[] {
  const fields: HaystackField[] = [
    { text: `${plugin.name} ${plugin.displayName}`.toLowerCase(), weight: 3 },
    { text: plugin.description.toLowerCase(), weight: 2 }
  ]
  const toolText = plugin.tools
    .map((tool) => `${tool.name} ${tool.description}`)
    .join(' ')
    .toLowerCase()
    .trim()
  if (toolText) fields.push({ text: toolText, weight: 1.5 })
  if (plugin.kind === 'expert') {
    const extra = [
      plugin.instructions ?? '',
      ...(plugin.team ?? []).map((member) => `${member.ref} ${member.role ?? ''}`)
    ]
      .join(' ')
      .trim()
      .toLowerCase()
    if (extra) fields.push({ text: extra, weight: 1 })
  }
  return fields
}

function isExcluded(plugin: RecommendablePlugin, options: RecommendOptions): boolean {
  if (plugin.kind === 'connector') {
    // enabled 即代表用户已经授权并保持连接,不再推荐"去连接"。
    return plugin.enabled
  }
  if (!plugin.enabled) return true
  return plugin.name === options.activeExpertId
}

/**
 * 返回最多 3 条推荐。分数低于 4 视为不相关:两个字的中文词命中描述刚好达到阈值,
 * 单个停用词或单字不会触发。
 */
export function recommendPlugins(
  task: string,
  plugins: RecommendablePlugin[],
  options: RecommendOptions = {}
): PluginRecommendation[] {
  const text = task.trim()
  if (text.length < 2) return []
  const tokens = tokenizeTask(text)
  if (tokens.length === 0) return []

  const scored: PluginRecommendation[] = []
  for (const plugin of plugins) {
    if (isExcluded(plugin, options)) continue
    const fields = haystackOf(plugin)
    let score = 0
    const matched: string[] = []
    for (const token of tokens) {
      let bestWeight = 0
      for (const field of fields) {
        if (field.weight > bestWeight && field.text.includes(token)) bestWeight = field.weight
      }
      if (bestWeight === 0) continue
      const tokenWeight = Math.min(Math.max(token.length, 2), 12)
      score += tokenWeight * bestWeight
      matched.push(token)
    }
    if (score < 4 || matched.length === 0) continue
    const matchedSorted = [...new Set(matched)].sort((a, b) => b.length - a.length || a.localeCompare(b))
    const subject = matchedSorted.slice(0, 3).join('、')
    scored.push({
      name: plugin.name,
      displayName: plugin.displayName,
      kind: plugin.kind,
      description: plugin.description,
      reason:
        plugin.kind === 'connector'
          ? `任务涉及「${subject}」,连接后可读取对应系统的数据。`
          : `任务涉及「${subject}」,可由该专家按专业准则协作。`,
      matched: matchedSorted,
      score,
      permissions: plugin.permissions
    })
  }

  scored.sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName))
  return scored.slice(0, MAX_RECOMMENDATIONS)
}

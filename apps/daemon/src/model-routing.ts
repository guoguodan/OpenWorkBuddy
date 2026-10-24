/**
 * 多模型自动路由。
 *
 * 路由必须是确定性的纯函数:同一轮输入总是得到同一个模型与同一条原因,
 * 不额外调用模型做"判断",也不会因为网络波动改变结论。这样用户才能解释
 * "这轮为什么用这个模型",测试也能稳定覆盖每条规则。
 *
 * 优先级(从高到低):
 *   1. 用户手动指定模型——显式选择永远高于自动规则;
 *   2. 未开启自动路由——保持现状,使用默认模型;
 *   3. 快速模式——该模式不调用工具,交给轻量模型;
 *   4. 长上下文——当前消息或附件明显超出一轮普通对话的规模;
 *   5. 代码任务——开发场景或明确的工程化请求;
 *   6. 其余情况使用默认模型。
 *
 * 每一类都允许未配置专用模型;此时回落到默认模型并在原因里说明,
 * 而不是假装已经路由到某个并不存在的模型。
 */

export type RouteRule =
  | 'manual'
  | 'auto-off'
  | 'quick-mode'
  | 'long-context'
  | 'code-task'
  | 'default'

export type RouteTask = 'chat' | 'code' | 'long-context' | 'quick'

export interface ModelRouteInput {
  /** 自动路由开关;关闭时行为与历史版本完全一致。 */
  autoRoute: boolean
  /** 工作区里用户显式选择的模型;为空表示交给默认/自动。 */
  manualModel: string | null
  /** 环境变量或内置的默认模型名,作为所有规则的兜底。 */
  defaultModel: string
  /** 轻量模型:快速模式与短对话优先使用。 */
  fastModel: string | null
  /** 长上下文模型:大文档、长消息优先使用。 */
  deepModel: string | null
  /** 代码模型:开发类任务优先使用。 */
  codeModel: string | null
  modeId: string
  scene: 'working' | 'coding' | 'design' | null
  text: string
  attachmentCount: number
  hasImages: boolean
}

export interface ModelRouteDecision {
  model: string
  rule: RouteRule
  task: RouteTask
  /** 面向用户的一句话原因,直接展示在对话里。 */
  reason: string
  /** 该规则本应使用的专用模型;未配置时为 null,便于界面区分"未命中"与"未配置"。 */
  preferredModel: string | null
}

/** 超过这个字符数就按长上下文处理:中文约 6000 字已接近普通问答的舒适区上限。 */
export const LONG_CONTEXT_CHARS = 6000
/** 附件多到一定程度时,即使正文很短也需要更大的上下文窗口。 */
export const LONG_CONTEXT_ATTACHMENTS = 3

const CODE_PATTERNS: RegExp[] = [
  /```/,
  /\b(typescript|javascript|python|rust|golang|java|kotlin|swift|react|vue|node|npm|pnpm|vitest|jest)\b/i,
  /\b(git|commit|merge|rebase|docker|sql|api|sdk)\b/i,
  /(代码|编程|重构|编译|单元测试|集成测试|报错|堆栈|函数|接口|数据库|迁移|依赖|仓库|分支|脚本)/,
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|cs|cpp|c|h|sql|json|ya?ml)$/i
]

function normalized(value: string | null | undefined): string | null {
  const name = value?.trim()
  return name ? name : null
}

/** 代码任务识别只看模式、场景与正文,不猜测附件内容;附件里的代码由长上下文规则覆盖。 */
export function looksLikeCodeTask(input: Pick<ModelRouteInput, 'modeId' | 'scene' | 'text'>): boolean {
  // 开发场景是用户明确的意图,直接按代码任务处理;
  // craft 模式很常见于普通办公任务,因此仍需正文里出现工程信号。
  if (input.scene === 'coding') return true
  return CODE_PATTERNS.some((pattern) => pattern.test(input.text))
}

export function looksLikeLongContext(
  input: Pick<ModelRouteInput, 'text' | 'attachmentCount' | 'hasImages'>
): boolean {
  if (input.text.length >= LONG_CONTEXT_CHARS) return true
  if (input.attachmentCount >= LONG_CONTEXT_ATTACHMENTS) return true
  // 图片会以多模态内容进入请求,单张就足以显著抬高输入规模。
  return input.hasImages && input.attachmentCount >= 2
}

function pick(
  preferred: string | null,
  fallback: string,
  rule: RouteRule,
  task: RouteTask,
  configuredReason: string,
  fallbackReason: string
): ModelRouteDecision {
  if (preferred) {
    return { model: preferred, rule, task, reason: configuredReason, preferredModel: preferred }
  }
  return { model: fallback, rule, task, reason: fallbackReason, preferredModel: null }
}

export function routeModel(input: ModelRouteInput): ModelRouteDecision {
  const manual = normalized(input.manualModel)
  if (manual) {
    return {
      model: manual,
      rule: 'manual',
      task: 'chat',
      reason: '你手动指定了模型,本轮沿用该选择',
      preferredModel: manual
    }
  }

  const fallback = normalized(input.defaultModel) ?? input.defaultModel
  if (!input.autoRoute) {
    return {
      model: fallback,
      rule: 'auto-off',
      task: 'chat',
      reason: '自动路由未开启,使用默认模型',
      preferredModel: null
    }
  }

  if (input.modeId === 'quick') {
    return pick(
      normalized(input.fastModel),
      fallback,
      'quick-mode',
      'quick',
      '快速模式不调用工具,使用轻量模型',
      '快速模式未配置轻量模型,使用默认模型'
    )
  }

  if (looksLikeLongContext(input)) {
    return pick(
      normalized(input.deepModel),
      fallback,
      'long-context',
      'long-context',
      '本轮内容较长,使用长上下文模型',
      '本轮内容较长,但未配置长上下文模型,使用默认模型'
    )
  }

  if (looksLikeCodeTask(input)) {
    return pick(
      normalized(input.codeModel),
      fallback,
      'code-task',
      'code',
      '识别为代码任务,使用代码模型',
      '识别为代码任务,但未配置代码模型,使用默认模型'
    )
  }

  return {
    model: fallback,
    rule: 'default',
    task: 'chat',
    reason: '未命中特殊规则,使用默认模型',
    preferredModel: null
  }
}

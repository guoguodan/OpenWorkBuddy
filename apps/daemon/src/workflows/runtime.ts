import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { generateText } from 'ai'
import { modelFor } from '../model.js'
import type { ToolRegistry } from '@openwb/tools'
import {
  FileRunStore,
  WorkflowEngine,
  loadWorkflow,
  sampleForSchema,
  type PromptRequest,
  type WorkflowEvent,
  type WorkflowManifest,
  type WorkflowToolContext
} from '@openwb/workflow'
import { workflowTools } from '../tools/workflow-tools.js'

/** 工作流运行目录:内置 + 用户级 + 项目级 */
export interface WorkflowDirsConfig {
  builtin: string
  user: string
  project: string
}

export function workflowDirs(workspace: string, dataDir: string, builtin: string): WorkflowDirsConfig {
  return {
    builtin,
    user: resolve(dataDir, 'workflows'),
    project: resolve(workspace, '.openwb', 'workflows')
  }
}

/** 时间序 + 随机后缀,便于按目录排序;同时满足 runId 的字符集约束 */
export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 17)
  return `run-${stamp}-${randomBytes(4).toString('hex')}`
}

export interface MockControls {
  /** stepId -> 剩余失败次数;用于"首次失败、重试成功" */
  failOnce: Map<string, number>
  /** 这些 step 永远返回非法 JSON */
  invalidJson: Set<string>
  /** 记录 step 调用次数,供验收核对 */
  counts: Map<string, number>
  /** 记录 prompt 调用时间戳,证明 parallel phase 真的并发 */
  stamps: Array<{ stepId: string; at: number }>
}

function parseFailOnce(raw: string | undefined): Map<string, number> {
  const out = new Map<string, number>()
  if (!raw) return out
  for (const item of raw.split(',')) {
    const [id, count] = item.split(':')
    if (!id) continue
    out.set(id, Number(count ?? '1'))
  }
  return out
}

export function mockControls(): MockControls {
  return {
    failOnce: parseFailOnce(process.env.OPENWB_WORKFLOW_MOCK_FAIL),
    invalidJson: new Set(
      (process.env.OPENWB_WORKFLOW_MOCK_INVALID_JSON ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    ),
    counts: new Map<string, number>(),
    stamps: [] as Array<{ stepId: string; at: number }>
  }
}

function urlList(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s)\]"']+/g)].map((m) => m[0])
}

/**
 * mock 提示词实现。
 * 目标不是"假装模型",而是让编排、校验、重试、落盘这些真实链路都能被离线执行。
 * 因此这里按 step 的输出类型给确定性结果,并在 markdown 里保留提示词中出现的 URL,
 * 使 deep-research 的报告天然带可点击来源。
 */
function mockPrompt(controls: MockControls) {
  return async (req: PromptRequest): Promise<string> => {
    const count = (controls.counts.get(req.stepId) ?? 0) + 1
    controls.counts.set(req.stepId, count)
    controls.stamps.push({ stepId: req.stepId, at: Date.now() })
    const delay = Number(process.env.OPENWB_WORKFLOW_MOCK_DELAY_MS ?? 0)
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    const remaining = controls.failOnce.get(req.stepId) ?? 0
    if (remaining > 0) {
      controls.failOnce.set(req.stepId, remaining - 1)
      throw new Error(`mock failure at ${req.stepId}`)
    }
    if (controls.invalidJson.has(req.stepId)) return '这里没有 JSON,只有一段普通文字。'
    if (req.output === 'json') {
      // 故意加前后缀:验证 extractJson 能从自由文本中取出平衡 JSON
      const sample = sampleForSchema(req.schema ?? { type: 'object' })
      return `好的,结果如下:\n\`\`\`json\n${JSON.stringify(sample, null, 2)}\n\`\`\`\n请核对。`
    }
    const urls = urlList(req.prompt)
    if (req.output === 'markdown') {
      const sources = urls.length
        ? urls.slice(0, 15).map((url, i) => `${i + 1}. [来源 ${i + 1}](${url})`).join('\n')
        : '1. [示例来源](https://example.com)'
      return [
        `# 研究结论(${req.stepId})`,
        '',
        '本报告由离线 mock 生成,用于验证工作流编排与来源落盘。',
        '',
        '## 结论',
        `- 已处理 ${urls.length} 条来源线索。`,
        '- 结论按 supported / contradicted / unknown 标注。',
        '',
        '## 来源',
        sources,
        ''
      ].join('\n')
    }
    return `mock:${req.stepId}:${req.prompt.slice(0, 40)}`
  }
}

function realPromptFor(modelName: string | null | undefined) {
  const active = modelFor(modelName)
  return async (req: PromptRequest): Promise<string> => {
    const result = await generateText({
      model: active,
      system: '你是工作流执行器中的一个步骤。严格按用户要求的格式输出。只输出要求的 JSON 或正文,不要额外寒暄。',
      prompt: req.repair ? `${req.prompt}\n\n上一次输出不合格:${req.repair}\n请修正后重新输出。` : req.prompt,
      abortSignal: req.signal
    })
    return result.text
  }
}

export interface ToolResolverDeps {
  registry: ToolRegistry
  workspaceRoot: string
  log?: (message: string) => void
  /** 宿主注入的审批网关;工作流工具步骤不得绕过闸门 */
  executeTool?: (input: {
    name: string
    args: Record<string, unknown>
    conversationId: string
    signal?: AbortSignal
  }) => Promise<unknown>
}

export function buildToolResolver(deps: ToolResolverDeps) {
  const dedicated = new Map(workflowTools().map((tool) => [tool.name, tool]))
  return async (name: string, args: Record<string, unknown>, ctx: WorkflowToolContext): Promise<unknown> => {
    const tool = dedicated.get(name) ?? deps.registry.get(name)
    if (!tool) throw new Error(`工作流引用了未注册的工具: ${name}`)
    const parsed = tool.parameters.safeParse(args)
    if (!parsed.success) {
      throw new Error(`工具 ${name} 参数不合法: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    }
    deps.log?.(`[workflow] tool ${name} ${JSON.stringify(args).slice(0, 200)}`)
    if (deps.executeTool && !dedicated.has(name)) {
      return await deps.executeTool({
        name,
        args: parsed.data as Record<string, unknown>,
        conversationId: ctx.conversationId ?? '',
        signal: ctx.signal
      })
    }
    return await tool.execute(parsed.data, { workspaceRoot: deps.workspaceRoot, signal: ctx.signal })
  }
}

export interface RunWorkflowInput {
  manifest: WorkflowManifest
  runId: string
  /** 用户在工作区设置里选择的模型;空值表示使用环境变量默认值 */
  modelName?: string | null
  inputs: Record<string, unknown>
  workspaceRoot: string
  registry: ToolRegistry
  executeTool?: ToolResolverDeps['executeTool']
  conversationId?: string
  signal: AbortSignal
  resume: boolean
  onEvent: (event: WorkflowEvent) => void
  log: (message: string) => void
}

export async function runWorkflow(input: RunWorkflowInput) {
  const mock = process.env.OPENWB_MOCK === '1'
  const store = new FileRunStore(input.workspaceRoot)
  const controls = mockControls()
  const engine = new WorkflowEngine(input.manifest, {
    prompt: mock ? mockPrompt(controls) : realPromptFor(input.modelName),
    tool: buildToolResolver({
      registry: input.registry,
      workspaceRoot: input.workspaceRoot,
      log: input.log,
      ...(input.executeTool ? { executeTool: input.executeTool } : {})
    }),
    store,
    onEvent: input.onEvent
  })
  const outcome = await engine.run({
    runId: input.runId,
    inputs: input.inputs,
    workspaceRoot: input.workspaceRoot,
    signal: input.signal,
    resume: input.resume,
    ...(input.conversationId ? { conversationId: input.conversationId } : {})
  })
  return { outcome, controls }
}

export async function loadWorkflowById(dirs: WorkflowDirsConfig, id: string) {
  return await loadWorkflow(dirs, id)
}

/** 校验输入:required 缺失即报错,default 用于补齐 */
export function normalizeInputs(manifest: WorkflowManifest, provided: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...provided }
  for (const input of manifest.inputs) {
    const has = Object.prototype.hasOwnProperty.call(out, input.name)
    if (!has && input.default !== undefined) out[input.name] = input.default
    if ((!has || out[input.name] === undefined) && input.required) {
      throw new Error(`缺少必填输入: ${input.name}`)
    }
  }
  return out
}

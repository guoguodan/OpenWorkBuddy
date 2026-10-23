import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { streamText, tool, type CoreMessage, type Tool, type ToolExecutionOptions } from 'ai'
import { z } from 'zod'
import { model } from './model.js'
import {
  loadModes,
  assertRequiredModes,
  isToolAllowed,
  REQUIRED_MODES,
  loadFragments,
  assemble,
  buildTrace,
  writeTrace,
  type AssembledPrompt,
  type ModePolicy
} from '@openwb/prompt'
import { ToolRegistry } from '@openwb/tools'
import type { SkillRoot } from '@openwb/skills'
import { builtinTools } from './tools/builtin.js'
import { SkillRuntime, defaultSkillRoots } from './skills/runtime.js'

const WORKSPACE = resolve(process.env.OPENWB_WORKSPACE ?? process.cwd())
const MODES_DIR = process.env.OPENWB_MODES_DIR ?? resolve(WORKSPACE, 'resources/modes')
const PROMPTS_DIR = process.env.OPENWB_PROMPTS_DIR ?? resolve(WORKSPACE, 'resources/prompts')
const SKILLS_DIR = process.env.OPENWB_SKILLS_DIR
// 内置技能与模式目录同级:resources/modes -> resources/skills
const BUNDLED_SKILLS_DIR = process.env.OPENWB_BUNDLED_SKILLS_DIR ?? resolve(MODES_DIR, '../skills')
const TRACE_DIR = resolve(WORKSPACE, '.openwb/traces')
const MOCK = process.env.OPENWB_MOCK === '1'
const MAX_STEPS = 5

function emit(event: unknown) {
  process.stdout.write(JSON.stringify(event) + '\n')
}

const registry = new ToolRegistry()
for (const t of builtinTools()) registry.register(t)

function skillRoots(): SkillRoot[] {
  if (SKILLS_DIR) {
    return SKILLS_DIR.split(';')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((path) => ({ path: resolve(path), scope: 'project' as const }))
  }
  return defaultSkillRoots(WORKSPACE, BUNDLED_SKILLS_DIR)
}

const skills = new SkillRuntime(skillRoots())

const loadSkillTool = {
  name: 'load_skill',
  description:
    '按名称加载技能说明。只有在任务确实属于某个技能范围时才调用;返回值是技能正文,加载后本会话可用工具会被收窄到该技能的 allowed-tools。',
  parameters: z.object({
    name: z.string().min(1).describe('技能名,必须是技能索引中列出的名称')
  }),
  effects: { writesFilesystem: false, accessesNetwork: false, mayIncurCost: false },
  async execute({ name }: { name: string }) {
    const loaded = await skills.load(name)
    return loaded.body
  }
}

let modes: Map<string, ModePolicy>
try {
  modes = await loadModes(MODES_DIR)
  assertRequiredModes(modes)
} catch (err) {
  process.stderr.write(`[fatal] ${(err as Error).message}\n`)
  process.exit(2)
}

const discovered = await skills.refresh()
process.stderr.write(
  `[skills] ${discovered.entries.length} 个 -> [${discovered.entries.map((e) => e.name).join(',')}]\n`
)
for (const issue of discovered.issues) {
  // 技能根目录不存在是常态(用户还没装技能),不当成错误刷屏
  if (issue.reason.includes('不存在或不可读')) continue
  process.stderr.write(`[skills] 跳过 ${issue.path}: ${issue.reason}\n`)
}

/** 固定模式顺序,避免目录枚举顺序影响界面 */
function orderedModes(): ModePolicy[] {
  return REQUIRED_MODES.map((id) => modes.get(id)).filter((m): m is ModePolicy => Boolean(m))
}

function modeTools(mode: ModePolicy): string[] {
  return registry.selectFor((name) => isToolAllowed(mode, name)).map((t) => t.name)
}

async function prepareMode(
  mode: ModePolicy
): Promise<{
  system: string
  modeTools: string[]
  assembled: AssembledPrompt
}> {
  const baseTools = modeTools(mode)
  const fragments = await loadFragments(PROMPTS_DIR, mode.promptFragments)
  const assembled = assemble(fragments, { mode: mode.id, workspace: WORKSPACE })

  const index = skills.indexText()
  const canLoadSkill = baseTools.length > 0 && skills.list().length > 0
  const system = canLoadSkill && index ? `${assembled.text}\n\n${index}` : assembled.text

  return { system, modeTools: baseTools, assembled }
}

function resolveMode(requested: unknown): ModePolicy {
  const id = typeof requested === 'string' && requested.length > 0 ? requested : 'craft'
  const mode = modes.get(id)
  if (!mode) {
    throw new Error(`未知模式: ${id}。可用模式: ${[...modes.keys()].join(', ')}`)
  }
  return mode
}

/**
 * ToolSet 的 index signature 是 Tool<any, any>,其 execute 是可选的。
 * 而 AI SDK 的 ToolResultUnion 只在 execute 必定存在时才会保留 tool-result 分支,
 * 所以这里显式要求 execute 非空,否则 fullStream 会推断不出 tool-result。
 */
type ExecutableTool = Tool<any, any> & {
  execute: (args: any, options: ToolExecutionOptions) => PromiseLike<any>
}

function buildTools(mode: ModePolicy, allowedNames: string[]) {
  const allowed = new Set(allowedNames)
  const result: Record<string, ExecutableTool> = {}

  for (const descriptor of registry.selectFor((name) => allowed.has(name))) {
    result[descriptor.name] = tool({
      description: descriptor.description,
      parameters: descriptor.parameters,
      execute: async (input) => {
        if (!isToolAllowed(mode, descriptor.name)) {
          throw new Error(`当前模式(${mode.displayName})不允许使用 ${descriptor.name}`)
        }
        skills.assertAllowed(descriptor.name)
        return descriptor.execute(input, { workspaceRoot: WORKSPACE })
      }
    })
  }

  if (allowed.has('load_skill')) {
    result.load_skill = tool({
      description: loadSkillTool.description,
      parameters: loadSkillTool.parameters,
      execute: async (input) => loadSkillTool.execute(input as { name: string })
    })
  }

  return result
}

/** 本轮实际下发:模式白名单 ∩ 技能收窄,再补上技能加载器本身 */
function effectiveTools(mode: ModePolicy): string[] {
  const base = modeTools(mode)
  if (base.length === 0 || skills.list().length === 0) return base
  return [...skills.narrow(base), 'load_skill'].sort()
}

async function runMock(text: string, mode: ModePolicy) {
  emit({ type: 'text.start' })
  emit({ type: 'tools.available', names: modeTools(mode) })
  const callId = 'mock-call-1'
  const canRead = isToolAllowed(mode, 'read_file')
  if (canRead) {
    emit({ type: 'tool.started', callId, name: 'read_file' })
    try {
      const content = (await registry
        .get('read_file')!
        .execute({ path: 'package.json' }, { workspaceRoot: WORKSPACE })) as string
      emit({ type: 'tool.finished', callId, ok: true, summary: `${content.length} 字节` })
      const reply = `[mock:${mode.id}] 已读取 package.json(${content.length} 字节)。问题: ${text}`
      for (const ch of Array.from(reply)) emit({ type: 'delta', text: ch })
    } catch (err) {
      emit({ type: 'tool.finished', callId, ok: false, summary: (err as Error).message })
      emit({ type: 'error', code: 'TOOL_FAILED', message: (err as Error).message, retryable: false })
    }
  } else {
    const reply = `[mock:${mode.id}] 当前模式无工具权限,未读取任何文件。问题: ${text}`
    for (const ch of Array.from(reply)) emit({ type: 'delta', text: ch })
  }
  emit({ type: 'done', usage: { input: 0, output: 0 } })
}

const rl = createInterface({ input: process.stdin })

emit({
  type: 'ready',
  modes: orderedModes().map((m) => ({ id: m.id, displayName: m.displayName })),
  skills: skills.list().map((s) => ({ name: s.name, description: s.description }))
})

rl.on('line', async (line) => {
  if (!line.trim()) return
  let msg: { text?: string; mode?: string; cmd?: string; requestId?: string }
  try {
    msg = JSON.parse(line)
  } catch {
    return emit({ type: 'error', code: 'BAD_INPUT', message: '请求不是合法 JSON', retryable: false })
  }

  if (msg.cmd === 'modes.list') {
    return emit({
      type: 'modes.list',
      requestId: msg.requestId,
      modes: orderedModes().map((m) => ({
        id: m.id,
        displayName: m.displayName,
        description: m.description
      }))
    })
  }

  if (msg.cmd === 'skills.list') {
    return emit({
      type: 'skills.list',
      requestId: msg.requestId,
      skills: skills.list().map((s) => ({ name: s.name, description: s.description, scope: s.scope })),
      issues: skills.issues()
    })
  }

  if (!msg.text) {
    return emit({ type: 'error', code: 'EMPTY_INPUT', message: '输入为空', retryable: false })
  }

  let mode: ModePolicy
  try {
    mode = resolveMode(msg.mode)
  } catch (err) {
    return emit({ type: 'error', code: 'UNKNOWN_MODE', message: (err as Error).message, retryable: false })
  }

  emit({ type: 'mode.selected', modeId: mode.id, displayName: mode.displayName })

  let prepared: { system: string; modeTools: string[]; assembled: AssembledPrompt }
  try {
    prepared = await prepareMode(mode)
  } catch (err) {
    return emit({
      type: 'error',
      code: 'PROMPT_FAILED',
      message: (err as Error).message,
      retryable: false
    })
  }

  if (MOCK) return runMock(msg.text, mode)

  // 技能是会话级状态:每次用户请求都从未激活开始
  skills.reset()

  try {
    emit({ type: 'text.start' })
    const initialTools = effectiveTools(mode)
    emit({ type: 'tools.available', names: initialTools })

    const messages: CoreMessage[] = [{ role: 'user', content: msg.text }]
    let totalInput = 0
    let totalOutput = 0
    let activeSkill: string | undefined
    // 与"上一次真正下发的集合"比较,而不是与初始集合比较,否则收窄后每一步都会重复播报
    let lastNames = initialTools

    for (let step = 0; step < MAX_STEPS; step++) {
      const names = effectiveTools(mode)
      const tools = buildTools(mode, names)

      if (JSON.stringify(names) !== JSON.stringify(lastNames)) {
        emit({ type: 'tools.available', names })
        lastNames = names
      }

      const result = streamText({
        model,
        system: prepared.system,
        messages,
        tools,
        maxSteps: 1
      })

      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') emit({ type: 'delta', text: part.textDelta })
        else if (part.type === 'tool-call')
          emit({ type: 'tool.started', callId: part.toolCallId, name: part.toolName })
        else if (part.type === 'tool-result') {
          const payload =
            part.toolName === 'load_skill'
              ? '技能已加载'
              : JSON.stringify(part.result).slice(0, 200)
          emit({ type: 'tool.finished', callId: part.toolCallId, ok: true, summary: payload })
        } else if (part.type === 'error') {
          emit({
            type: 'error',
            code: 'STREAM_ERROR',
            message: part.error instanceof Error ? part.error.message : String(part.error),
            retryable: true
          })
        }
      }

      const usage = await result.usage
      totalInput += usage.promptTokens ?? 0
      totalOutput += usage.completionTokens ?? 0

      const response = await result.response
      messages.push(...(response.messages as CoreMessage[]))

      const active = skills.activeSkill()
      if (active && active.name !== activeSkill) {
        activeSkill = active.name
        emit({
          type: 'skill.activated',
          name: active.name,
          allowedTools: active.allowedTools ?? null
        })
        process.stderr.write(
          `[skills] 激活 ${active.name} -> tools=[${(active.allowedTools ?? []).join(',') || '(不额外收窄)'}]\n`
        )
      }

      const toolResults = await result.toolResults
      if (toolResults.length === 0) break
    }

    const finalNames = effectiveTools(mode)
    const trace = buildTrace(mode.id, prepared.assembled, finalNames, activeSkill)
    const file = await writeTrace(TRACE_DIR, trace)
    process.stderr.write(
      `[trace] ${mode.id} sha256=${trace.outputSha256.slice(0, 12)} tools=[${finalNames.join(',')}] skill=${activeSkill ?? '-'} -> ${file}\n`
    )

    // 部分 OpenAI 兼容网关不返回 usage;缺失时不要回传 null,否则界面会显示 "null"
    emit({
      type: 'done',
      usage: {
        ...(totalInput > 0 ? { input: totalInput } : {}),
        ...(totalOutput > 0 ? { output: totalOutput } : {})
      },
      ...(activeSkill ? { skill: activeSkill } : {})
    })
  } catch (err) {
    emit({ type: 'error', code: 'AGENT_FAILED', message: (err as Error).message, retryable: true })
  }
})

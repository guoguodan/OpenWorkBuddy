import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { streamText, tool, jsonSchema, type CoreMessage, type Tool, type ToolExecutionOptions } from 'ai'
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
import { ToolRegistry, type ToolDescriptor } from '@openwb/tools'
import type { SkillRoot } from '@openwb/skills'
import { FrameDecoder, encodeFrame, helloFrame } from '@openwb/protocol'
import {
  appendEvent,
  appendMessage,
  createConversation,
  createTask,
  deleteConversation,
  ensureWorkspace,
  getConversation,
  getPlugin,
  listConversations,
  listMessages,
  listPlugins,
  deletePlugin,
  migrateOrThrow,
  openDatabase,
  setPluginEnabled,
  transitionTask,
  upsertPlugin,
  eq
} from '@openwb/storage'
import {
  appendWorkspaceLog,
  buildInjection,
  deleteMemoryAndSync,
  ensureUserMemoryFile,
  ensureWorkspaceGitignore,
  listMemory
} from '@openwb/memory'
import { builtinTools } from './tools/builtin.js'
import {
  PluginRuntime,
  discoverPlugins,
  installPlugin,
  uninstallPlugin,
  PluginInstallError,
  type PluginSnapshot
} from '@openwb/plugins'
import { SkillRuntime, defaultSkillRoots } from './skills/runtime.js'

const WORKSPACE = resolve(process.env.OPENWB_WORKSPACE ?? process.cwd())
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * 资源目录解析。
 *
 * daemon 由桌面端拉起时,cwd 是 apps/desktop 而不是仓库根;
 * 只按 cwd 找 resources 会让界面在启动阶段就拿到「daemon 退出: 2」。
 * 因此按「显式环境变量 → 工作区 → 相对构建产物上溯」依次探测,
 * 全部不存在时仍返回工作区下的默认值,由加载器给出可读的报错。
 */
async function resolveResourceDir(envValue: string | undefined, name: string): Promise<string> {
  if (envValue) return resolve(envValue)
  const candidates = [
    resolve(WORKSPACE, 'resources', name),
    resolve(MODULE_DIR, '../../../resources', name),
    resolve(MODULE_DIR, '../../resources', name)
  ]
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // 继续尝试下一个候选目录
    }
  }
  return candidates[0]!
}

const MODES_DIR = await resolveResourceDir(process.env.OPENWB_MODES_DIR, 'modes')
const PROMPTS_DIR = await resolveResourceDir(process.env.OPENWB_PROMPTS_DIR, 'prompts')
const SKILLS_DIR = process.env.OPENWB_SKILLS_DIR
// 内置技能与模式目录同级:resources/modes -> resources/skills
const BUNDLED_SKILLS_DIR =
  process.env.OPENWB_BUNDLED_SKILLS_DIR ?? resolve(MODES_DIR, '..', 'skills')
const TRACE_DIR = resolve(WORKSPACE, '.openwb/traces')
const MOCK = process.env.OPENWB_MOCK === '1'
const HOST_VERSION = process.env.OPENWB_HOST_VERSION ?? '0.0.1'
const MAX_STEPS = 5
const MODEL_NAME = process.env.OPENWB_MODEL ?? 'unknown'

/**
 * dataDir 解析优先级:
 *   1. OPENWB_DATA_DIR(主进程 / 测试显式传入)
 *   2. 开发态:工作区含 pnpm-workspace.yaml 时用 <ws>/.openwb-data
 *   3. 平台默认:%APPDATA%\OpenWorkBuddy\data 等
 */
async function resolveDataDir(): Promise<string> {
  if (process.env.OPENWB_DATA_DIR) return resolve(process.env.OPENWB_DATA_DIR)
  try {
    await access(resolve(WORKSPACE, 'pnpm-workspace.yaml'))
    return resolve(WORKSPACE, '.openwb-data')
  } catch {
    // 不是仓库根,走平台默认
  }
  if (process.platform === 'win32') {
    return resolve(process.env.APPDATA ?? resolve(homedir(), 'AppData/Roaming'), 'OpenWorkBuddy/data')
  }
  if (process.platform === 'darwin') {
    return resolve(homedir(), 'Library/Application Support/OpenWorkBuddy/data')
  }
  return resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), '.config'), 'OpenWorkBuddy/data')
}

const DATA_DIR = await resolveDataDir()
const DB_PATH = resolve(DATA_DIR, 'openwb.db')
/** 已安装插件的根目录;数据库记录与磁盘目录必须同时存在 */
const PLUGINS_DIR = resolve(DATA_DIR, 'plugins')
const PLUGIN_DATA_DIR = resolve(DATA_DIR, 'plugin-data')

function emit(event: unknown) {
  process.stdout.write(encodeFrame(event))
}

const decoder = new FrameDecoder()

let fatal: string | null = null
let dbHandle: ReturnType<typeof openDatabase> | null = null
let workspaceId = ''
let activeConversationId = ''

try {
  dbHandle = openDatabase(DB_PATH)
  migrateOrThrow(dbHandle.raw, { dbPath: DB_PATH })
  const ws = ensureWorkspace(dbHandle.db, WORKSPACE)
  workspaceId = ws.id
  await ensureUserMemoryFile(DATA_DIR)
  await ensureWorkspaceGitignore(WORKSPACE)
  const recent = listConversations(dbHandle.db, ws.id)[0]
  activeConversationId = recent?.id ?? createConversation(dbHandle.db, {
    workspaceId: ws.id,
    title: '默认会话',
    modeId: 'craft'
  }).id
  process.stderr.write(`[db] ${DB_PATH} v${dbHandle.raw.pragma('user_version', { simple: true })}\n`)
} catch (err) {
  fatal = (err as Error).message
  // 迁移失败时绝不能继续用这个连接:库结构可能与代码不匹配,
  // 保留句柄会让后续请求在错误 schema 上执行。
  try {
    dbHandle?.raw.close()
  } catch {
    // 关闭失败不影响错误上报
  }
  dbHandle = null
  process.stderr.write(`[fatal] 数据库初始化失败: ${fatal}\n`)
}

const registry = new ToolRegistry()
for (const t of builtinTools()) registry.register(t)

/**
 * 插件工具与内置工具不同:它们的描述来自外部进程,且生命周期会变化。
 * 这里维护一份"当前可注册"的集合,插件就绪时注册、停止/禁用时移除。
 *
 * 只允许 craft 模式看到插件工具:
 * ask/plan/expert 是只读分析,quick 明确不调用任何工具,
 * 让第三方工具进入这些模式会直接破坏 P2 的边界。
 */
const PLUGIN_TOOL_MODE = 'craft'

function isPluginToolName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*__[a-z][a-z0-9_]*$/.test(name)
}

const pluginRuntime = new PluginRuntime({
  pluginsRoot: PLUGINS_DIR,
  pluginDataRoot: PLUGIN_DATA_DIR,
  maxFailures: Number(process.env.OPENWB_PLUGIN_MAX_FAILURES ?? 3),
  healthIntervalMs: Number(process.env.OPENWB_PLUGIN_HEALTH_MS ?? 60_000),
  backoffMs: [1000, 2000, 4000],
  onEvent: (event) => {
    if (event.type !== 'plugin.status') return
    syncPluginTools()
    emit({ type: 'plugin.status', plugin: event.plugin })
  },
  onLog: (plugin, message) => process.stderr.write(`[plugin:${plugin}] ${message}\n`)
})

function syncPluginTools() {
  const desired = new Map(pluginRuntime.availableTools().map((tool) => [tool.name, tool]))
  for (const name of registry.names()) {
    if (!isPluginToolName(name)) continue
    if (!desired.has(name)) registry.unregister(name)
  }
  for (const tool of desired.values()) {
    if (registry.has(tool.name)) continue
    const descriptor: ToolDescriptor<Record<string, unknown>, unknown> = {
      name: tool.name,
      description: tool.description,
      // MCP 的 inputSchema 本来就是 JSON Schema,直接交给模型;
      // parameters 只是注册表的占位校验,buildTools 会优先用 inputSchema。
      parameters: z.record(z.string(), z.unknown()),
      inputSchema: tool.inputSchema,
      effects: tool.effects,
      execute: async (input, ctx) => pluginRuntime.callTool(tool.name, input, ctx.signal)
    }
    registry.register(descriptor)
  }
}

/** 模式白名单之外的唯一例外:插件工具只对 craft 开放 */
function modeAllowsTool(mode: ModePolicy, name: string): boolean {
  if (isToolAllowed(mode, name)) return true
  return mode.id === PLUGIN_TOOL_MODE && isPluginToolName(name)
}

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
  emit(helloFrame())
  emit({ type: 'error', code: 'MODES_FAILED', message: (err as Error).message, retryable: false })
  process.exit(2)
}

const discovered = await skills.refresh()
process.stderr.write(
  `[skills] ${discovered.entries.length} 个 -> [${discovered.entries.map((e) => e.name).join(',')}]\n`
)
for (const issue of discovered.issues) {
  if (issue.reason.includes('不存在或不可读')) continue
  process.stderr.write(`[skills] 跳过 ${issue.path}: ${issue.reason}\n`)
}

/**
 * 启动时把磁盘上的插件与数据库对齐:
 * - 新目录 → 建库记录;
 * - 已有记录 → 以记录的 enabled 为准(用户可能手动关过);
 * - 数据库有、磁盘没有 → 不自动删库,留给 UI 显示"缺失",避免临时移动目录丢配置。
 */
const discoveredPlugins = await discoverPlugins(PLUGINS_DIR)
for (const issue of discoveredPlugins.issues) {
  process.stderr.write(`[plugins] 跳过 ${issue.path}: ${issue.reason}\n`)
}
for (const plugin of discoveredPlugins.plugins) {
  const existing = dbHandle ? getPlugin(dbHandle.db, plugin.name) : undefined
  const shell = plugin.manifest.permissions.includes('shell')
  const enabled = existing ? existing.enabled : !shell
  pluginRuntime.register(plugin, { enabled })
  if (dbHandle) {
    upsertPlugin(dbHandle.db, {
      kind: plugin.manifest.kind,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      enabled,
      permissions: plugin.manifest.permissions,
      manifest: plugin.manifest
    })
  }
}
process.stderr.write(
  `[plugins] 已发现 ${discoveredPlugins.plugins.length} 个 -> [${discoveredPlugins.plugins.map((p) => p.name).join(',')}]\n`
)

/** 插件启动失败不应阻止 daemon 就绪:失败只体现在状态里 */
try {
  await pluginRuntime.startAll()
} catch (err) {
  process.stderr.write(`[plugins] 启动阶段异常: ${(err as Error).message}\n`)
}

function pluginStatusList() {
  const snapshots = pluginRuntime.snapshot()
  const known = new Set(snapshots.map((p) => p.name))
  const missing = dbHandle
    ? listPlugins(dbHandle.db)
        .filter((row) => !known.has(row.name))
        .map((row) => ({
          name: row.name,
          displayName: row.name,
          version: row.version ?? '0.0.0',
          kind: row.kind === 'expert' ? ('expert' as const) : ('connector' as const),
          state: 'unloaded' as const,
          enabled: row.enabled,
          attempts: 0,
          lastError: '插件目录缺失',
          tools: [],
          pids: [],
          warnings: [],
          verifiedPublisher: false,
          permissions: row.permissions
        }))
    : []
  return [...snapshots, ...missing].sort((a, b) => a.name.localeCompare(b.name))
}

function orderedModes(): ModePolicy[] {
  return REQUIRED_MODES.map((id) => modes.get(id)).filter((m): m is ModePolicy => Boolean(m))
}

function modeTools(mode: ModePolicy): string[] {
  return registry.selectFor((name) => modeAllowsTool(mode, name)).map((t) => t.name)
}

async function prepareMode(
  mode: ModePolicy,
  memoryText: string
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
  let system = canLoadSkill && index ? `${assembled.text}\n\n${index}` : assembled.text
  // 模型无法从工具清单推断宿主操作系统,不说明就会在 Windows 上调用 ls/cat。
  const platformHint = process.platform === 'win32'
    ? '- 本机是 Windows:没有 ls / cat / rm / grep / find / sed 等 Unix 命令。列目录用 glob(pattern="*"),读文件用 read_file,搜索用 grep。'
    : '- 列目录用 glob(pattern="*"),读文件用 read_file,搜索用 grep。'
  system = [
    system,
    '',
    '# 运行环境',
    `- 工作区根目录: ${WORKSPACE}`,
    `- 操作系统: ${process.platform}`,
    platformHint,
    '- shell 直接 spawn 命令,不经过 shell 解释:不支持管道、重定向、通配符和 && 串联;也不要用 cmd/powershell/bash 包一层。'
  ].join('\n')
  if (memoryText) system = `${system}\n\n${memoryText}`

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

type ExecutableTool = Tool<any, any> & {
  execute: (args: any, options: ToolExecutionOptions) => PromiseLike<any>
}

/**
 * 工具失败必须是「可回填的结果」,而不是让整轮对话崩掉。
 *
 * AI SDK v4 里 execute 抛错会终止整个 streamText:模型收不到失败原因,
 * 客户端也收不到 tool.finished,工具行会永远停在转圈。这里统一包成
 * { ok: false, error } 交给模型,由它决定重试或换一种做法。
 */
export interface ToolFailure {
  ok: false
  error: string
  code: string
}

function isToolFailure(value: unknown): value is ToolFailure {
  return Boolean(
    value && typeof value === 'object' && (value as { ok?: unknown }).ok === false &&
      typeof (value as { error?: unknown }).error === 'string'
  )
}

function toToolFailure(err: unknown): ToolFailure {
  const message = err instanceof Error ? err.message : String(err)
  const code = (err as { code?: unknown })?.code
  return { ok: false, error: message, code: typeof code === 'string' ? code : 'TOOL_FAILED' }
}

/**
 * 把工具返回值压成界面能读的一行。原始 JSON 直接甩到界面上很像报错,
 * 而且 shell 的非零退出码在语义上也应当算失败。
 */
function summarizeToolResult(name: string, result: unknown): { ok: boolean; summary: string } {
  if (isToolFailure(result)) return { ok: false, summary: result.error }
  if (name === 'load_skill') return { ok: true, summary: '技能已加载' }

  if (name === 'shell' && result && typeof result === 'object') {
    const r = result as { code?: number | null; stdout?: string; stderr?: string }
    const output = (r.stdout || r.stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(0, 2).join(' / ')
    return {
      ok: r.code === 0,
      summary: `退出码 ${r.code ?? 'null'}${output ? ` · ${output.slice(0, 140)}` : ''}`
    }
  }
  if (name === 'read_file' && typeof result === 'string') {
    return { ok: true, summary: `${Buffer.byteLength(result, 'utf8')} 字节` }
  }
  if (name === 'write_file' && typeof result === 'string') return { ok: true, summary: result }
  if (Array.isArray(result)) {
    return { ok: true, summary: result.length > 0 ? `${result.length} 项` : '无结果' }
  }
  if (result && typeof result === 'object' && 'presented' in result) {
    return { ok: true, summary: `已呈现 ${(result as { presented: number }).presented} 个文件` }
  }
  return { ok: true, summary: JSON.stringify(result).slice(0, 140) }
}

function buildTools(mode: ModePolicy, allowedNames: string[]) {
  const allowed = new Set(allowedNames)
  const result: Record<string, ExecutableTool> = {}

  for (const descriptor of registry.selectFor((name) => allowed.has(name))) {
    result[descriptor.name] = tool({
      description: descriptor.description,
      parameters: descriptor.inputSchema
        ? jsonSchema<Record<string, unknown>>(descriptor.inputSchema as any)
        : descriptor.parameters,
      execute: async (input) => {
        if (!modeAllowsTool(mode, descriptor.name)) {
          return toToolFailure(new Error(`当前模式(${mode.displayName})不允许使用 ${descriptor.name}`))
        }
        try {
          skills.assertAllowed(descriptor.name)
          return await descriptor.execute(input, { workspaceRoot: WORKSPACE })
        } catch (err) {
          return toToolFailure(err)
        }
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

function effectiveTools(mode: ModePolicy): string[] {
  const base = modeTools(mode)
  if (base.length === 0 || skills.list().length === 0) return base
  return [...skills.narrow(base), 'load_skill'].sort()
}

function requireDb() {
  if (!dbHandle) throw new Error(fatal ?? '数据库未就绪')
  return dbHandle.db
}

function conversationOrThrow(id: string) {
  const conv = getConversation(requireDb(), id)
  if (!conv) throw new Error(`会话不存在: ${id}`)
  return conv
}

interface RunInput {
  text: string
  mode: ModePolicy
  clientRequestId?: string
  conversationId: string
}

/** 任务结束后的工作区日志:失败只记 stderr,绝不影响任务结果 */
async function appendRunLog(
  db: ReturnType<typeof requireDb>,
  input: { conversationId: string; text: string; modeId: string; toolCalls: number }
) {
  try {
    await appendWorkspaceLog(db, {
      workspaceId,
      workspaceRoot: WORKSPACE,
      kind: 'log',
      content: `请求: ${input.text.slice(0, 120)} | 模式: ${input.modeId} | 工具调用: ${input.toolCalls}`
    })
  } catch (err) {
    process.stderr.write(`[memory] 写入工作区日志失败: ${(err as Error).message}\n`)
  }
}

async function runMock(input: RunInput, prepared: { system: string; modeTools: string[]; assembled: AssembledPrompt }) {
  const db = requireDb()
  const taskId = createTask(db, { conversationId: input.conversationId, title: input.text.slice(0, 80) || '未命名任务' })
  transitionTask(db, taskId, 'running')
  appendEvent(db, input.conversationId, 'run.started', { taskId, mode: input.mode.id })
  emit({ type: 'text.start' })
  emit({ type: 'tools.available', names: modeTools(input.mode) })
  const callId = 'mock-call-1'
  const canRead = isToolAllowed(input.mode, 'read_file')
  let reply = ''
  if (canRead) {
    emit({ type: 'tool.started', callId, name: 'read_file' })
    try {
      const content = (await registry
        .get('read_file')!
        .execute({ path: 'package.json' }, { workspaceRoot: WORKSPACE })) as string
      emit({ type: 'tool.finished', callId, ok: true, summary: `${content.length} 字节` })
      reply = `[mock:${input.mode.id}] 已读取 package.json(${content.length} 字节)。问题: ${input.text}`
    } catch (err) {
      // 离线验收常在空目录里跑,mock 不能因为缺 package.json 就整轮失败
      emit({ type: 'tool.finished', callId, ok: false, summary: (err as Error).message })
      reply = `[mock:${input.mode.id}] 工具调用失败(${(err as Error).message})。问题: ${input.text}`
    }
  } else {
    reply = `[mock:${input.mode.id}] 当前模式无工具权限,未读取任何文件。问题: ${input.text}`
  }
  for (const ch of Array.from(reply)) emit({ type: 'delta', text: ch })
  appendMessage(db, {
    conversationId: input.conversationId,
    role: 'assistant',
    content: { text: reply },
    model: 'mock'
  })
  // mock 也要产出 trace:P2 的"提示词稳定性"验收靠它比对 sha256
  const trace = buildTrace(input.mode.id, prepared.assembled, modeTools(input.mode))
  const file = await writeTrace(TRACE_DIR, trace)
  process.stderr.write(
    `[trace] ${input.mode.id} sha256=${trace.outputSha256.slice(0, 12)} tools=[${modeTools(input.mode).join(',')}] skill=- -> ${file}\n`
  )

  transitionTask(db, taskId, 'done', { resultRef: trace.outputSha256.slice(0, 16) })
  appendEvent(db, input.conversationId, 'run.finished', { taskId, steps: canRead ? 1 : 0 })
  await appendRunLog(db, { conversationId: input.conversationId, text: input.text, modeId: input.mode.id, toolCalls: canRead ? 1 : 0 })
  emit({ type: 'done', conversationId: input.conversationId, usage: { input: 0, output: 0 } })
}

async function runAgent(input: RunInput) {
  const db = requireDb()
  const { text, mode, conversationId } = input

  emit({ type: 'mode.selected', modeId: mode.id, displayName: mode.displayName })

  const injected = await buildInjection({
    db,
    dataDir: DATA_DIR,
    workspaceId,
    ...(text ? { query: text } : {})
  })
  emit({
    type: 'memory.injected',
    blocks: injected.blocks.map((b) => ({
      scope: b.scope,
      count: b.ids.length,
      truncated: b.truncated,
      ids: b.ids
    })),
    truncatedTotal: injected.truncatedTotal
  })

  let prepared: { system: string; modeTools: string[]; assembled: AssembledPrompt }
  try {
    prepared = await prepareMode(mode, injected.text)
  } catch (err) {
    emit({ type: 'error', code: 'PROMPT_FAILED', message: (err as Error).message, retryable: false })
    return
  }

  if (MOCK) {
    await runMock(input, prepared)
    return
  }

  skills.reset()

  const taskId = createTask(db, { conversationId, title: text.slice(0, 80) || '未命名任务' })
  transitionTask(db, taskId, 'running')
  appendEvent(db, conversationId, 'run.started', { taskId, mode: mode.id })

  let reply = ''
  let totalInput = 0
  let totalOutput = 0
  let activeSkill: string | undefined
  let toolCalls = 0

  try {
    emit({ type: 'text.start' })
    const initialTools = effectiveTools(mode)
    emit({ type: 'tools.available', names: initialTools })

    const messages: CoreMessage[] = [{ role: 'user', content: text }]
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
        if (part.type === 'text-delta') {
          reply += part.textDelta
          emit({ type: 'delta', text: part.textDelta })
        } else if (part.type === 'tool-call') {
          toolCalls++
          emit({ type: 'tool.started', callId: part.toolCallId, name: part.toolName })
        } else if (part.type === 'tool-result') {
          const { ok, summary } = summarizeToolResult(part.toolName, part.result)
          emit({ type: 'tool.finished', callId: part.toolCallId, ok, summary })
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
      // 部分网关(含中转)在流式结束时不回 usage,或回 null/NaN。
      // NaN 会被 better-sqlite3 绑成 NULL,直接撞 token_in 的 NOT NULL 约束。
      const inTokens = Number(usage?.promptTokens)
      const outTokens = Number(usage?.completionTokens)
      if (Number.isFinite(inTokens)) totalInput += inTokens
      if (Number.isFinite(outTokens)) totalOutput += outTokens

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

    // 步数用尽时模型往往还在试下一步工具,此时 reply 为空,用户只看到一排失败的
    // 工具行,像"报错"。强制补一轮不带工具的收尾,把已有观测变成可读结论。
    if (!reply.trim()) {
      try {
        const wrapUp = streamText({
          model,
          system: `${prepared.system}\n\n# 收尾\n工具调用预算已用尽。不要再调用工具,直接基于目前已知的信息回答用户;拿不到的信息要明确说明没查到。`,
          messages: [
            ...messages,
            {
              role: 'user',
              content: '请立刻给出最终回答:已经查到什么、结论是什么、哪些没查到。不要再调用任何工具。'
            }
          ]
        })
        for await (const part of wrapUp.fullStream) {
          if (part.type === 'text-delta') {
            reply += part.textDelta
            emit({ type: 'delta', text: part.textDelta })
          }
        }
        const wrapUsage = await wrapUp.usage
        const wrapIn = Number(wrapUsage?.promptTokens)
        const wrapOut = Number(wrapUsage?.completionTokens)
        if (Number.isFinite(wrapIn)) totalInput += wrapIn
        if (Number.isFinite(wrapOut)) totalOutput += wrapOut
      } catch (err) {
        process.stderr.write(`[wrapup] 收尾失败: ${(err as Error).message}\n`)
        if (!reply.trim()) {
          reply = '本轮工具调用没有取得结果,已达到步数上限。请把问题拆小一些重试,或换用 ask 模式查看具体文件。'
          emit({ type: 'delta', text: reply })
        }
      }
    }

    const finalNames = effectiveTools(mode)
    const trace = buildTrace(mode.id, prepared.assembled, finalNames, activeSkill)
    const file = await writeTrace(TRACE_DIR, trace)
    process.stderr.write(
      `[trace] ${mode.id} sha256=${trace.outputSha256.slice(0, 12)} tools=[${finalNames.join(',')}] skill=${activeSkill ?? '-'} -> ${file}\n`
    )

    appendMessage(db, {
      conversationId,
      role: 'assistant',
      content: { text: reply },
      ...(activeSkill ? { model: `${MODEL_NAME}#${activeSkill}` } : { model: MODEL_NAME }),
      tokenIn: totalInput,
      tokenOut: totalOutput
    })
    transitionTask(db, taskId, 'done', { resultRef: trace.outputSha256.slice(0, 16) })
    appendEvent(db, conversationId, 'run.finished', { taskId, steps: toolCalls })

    await appendRunLog(db, { conversationId, text, modeId: mode.id, toolCalls })

    emit({
      type: 'done',
      conversationId,
      usage: {
        ...(totalInput > 0 ? { input: totalInput } : {}),
        ...(totalOutput > 0 ? { output: totalOutput } : {})
      },
      ...(activeSkill ? { skill: activeSkill } : {})
    })
  } catch (err) {
    const message = (err as Error).message
    appendMessage(db, {
      conversationId,
      role: 'assistant',
      content: { text: reply },
      status: 'interrupted'
    })
    try {
      transitionTask(db, taskId, 'failed', { errorCode: 'AGENT_FAILED' })
    } catch {
      // 若已处于终态则忽略
    }
    appendEvent(db, conversationId, 'run.failed', { taskId, message: message.slice(0, 300) })
    emit({ type: 'error', code: 'AGENT_FAILED', message, retryable: true })
  }
}

/** 串行处理,避免两个请求同时写库与写 stdout 帧 */
let queue: Promise<void> = Promise.resolve()
function enqueue(job: () => Promise<void>): void {
  queue = queue.then(job).catch((err) => {
    emit({ type: 'error', code: 'HANDLER_FAILED', message: (err as Error).message, retryable: false })
  })
}

function resolveConversationId(requested: unknown): string {
  if (typeof requested === 'string' && requested.length > 0) {
    conversationOrThrow(requested)
    return requested
  }
  return activeConversationId
}

async function handleCommand(msg: Record<string, unknown>, requestId: unknown): Promise<boolean> {
  const db = requireDb()
  const base = requestId !== undefined ? { requestId } : {}

  if (msg.cmd === 'modes.list') {
    emit({
      ...base,
      type: 'modes.list',
      modes: orderedModes().map((m) => ({
        id: m.id,
        displayName: m.displayName,
        description: m.description
      }))
    })
    return true
  }

  if (msg.cmd === 'plugins.list') {
    emit({ ...base, type: 'plugins.list', plugins: pluginStatusList() })
    return true
  }

  if (msg.cmd === 'plugins.install') {
    if (typeof msg.sourceDir !== 'string' || msg.sourceDir.length === 0) {
      throw new Error('缺少 sourceDir')
    }
    const confirmShell = msg.confirmShell === true
    const installed = await installPlugin({
      sourceDir: resolve(msg.sourceDir),
      pluginsRoot: PLUGINS_DIR,
      hostVersion: HOST_VERSION,
      ...(confirmShell ? { confirmShell: true } : {})
    })
    const shell = installed.manifest.permissions.includes('shell')
    const enabled = !shell
    upsertPlugin(db, {
      kind: installed.manifest.kind,
      name: installed.name,
      version: installed.manifest.version,
      enabled,
      permissions: installed.manifest.permissions,
      manifest: installed.manifest
    })
    pluginRuntime.register(
      { name: installed.name, dir: installed.dir, manifest: installed.manifest, warnings: installed.warnings, verifiedPublisher: installed.verifiedPublisher },
      { enabled }
    )

    if (enabled) {
      try {
        // 首次启动失败必须回滚,避免留下"装好了但永远起不来"的半装状态
        await pluginRuntime.startOrThrow(installed.name)
      } catch (err) {
        pluginRuntime.register(
          { name: installed.name, dir: installed.dir, manifest: installed.manifest, warnings: installed.warnings, verifiedPublisher: installed.verifiedPublisher },
          { enabled: false }
        )
        await pluginRuntime.remove(installed.name)
        deletePlugin(db, installed.name)
        await uninstallPlugin(PLUGINS_DIR, installed.name)
        throw new PluginInstallError('first-start', (err as Error).message)
      }
    } else {
      emit({ type: 'plugin.status', plugin: pluginRuntime.snapshotOf(installed.name) })
    }
    syncPluginTools()
    emit({
      ...base,
      type: 'plugins.installed',
      plugin: pluginRuntime.snapshotOf(installed.name) ?? null
    })
    return true
  }

  if (msg.cmd === 'plugins.uninstall') {
    if (typeof msg.name !== 'string') throw new Error('缺少 name')
    await pluginRuntime.remove(msg.name)
    await uninstallPlugin(PLUGINS_DIR, msg.name)
    deletePlugin(db, msg.name)
    syncPluginTools()
    emit({ ...base, type: 'plugins.uninstalled', name: msg.name })
    return true
  }

  if (msg.cmd === 'plugins.retry') {
    if (typeof msg.name !== 'string') throw new Error('缺少 name')
    await pluginRuntime.retry(msg.name)
    emit({ ...base, type: 'plugin.status', plugin: pluginRuntime.snapshotOf(msg.name) ?? null })
    return true
  }

  if (msg.cmd === 'plugins.setEnabled') {
    if (typeof msg.name !== 'string') throw new Error('缺少 name')
    if (typeof msg.enabled !== 'boolean') throw new Error('缺少 enabled')
    const snapshot = pluginRuntime.snapshotOf(msg.name)
    if (!snapshot) throw new Error(`插件未登记: ${msg.name}`)
    if (msg.enabled) {
      if (snapshot.permissions.includes('shell') && msg.confirmShell !== true) {
        throw new Error('该插件申请 shell 权限,启用需要二次确认(confirmShell=true)')
      }
      await pluginRuntime.setEnabled(msg.name, true)
    } else {
      await pluginRuntime.setEnabled(msg.name, false)
    }
    setPluginEnabled(db, msg.name, msg.enabled)
    syncPluginTools()
    emit({ ...base, type: 'plugin.status', plugin: pluginRuntime.snapshotOf(msg.name) ?? null })
    return true
  }

  if (msg.cmd === 'skills.list') {
    emit({
      ...base,
      type: 'skills.list',
      skills: skills.list().map((s) => ({ name: s.name, description: s.description, scope: s.scope })),
      issues: skills.issues()
    })
    return true
  }

  if (msg.cmd === 'conversation.list') {
    emit({
      ...base,
      type: 'conversation.list',
      conversationId: activeConversationId,
      conversations: listConversations(db, workspaceId).map((c) => ({
        id: c.id,
        title: c.title,
        modeId: c.modeId,
        updatedAt: c.updatedAt,
        lastSeq: c.lastSeq
      }))
    })
    return true
  }

  if (msg.cmd === 'conversation.history') {
    const id = resolveConversationId(msg.conversationId)
    emit({
      ...base,
      type: 'conversation.history',
      conversationId: id,
      messages: listMessages(db, id)
    })
    return true
  }

  if (msg.cmd === 'conversation.new') {
    const conv = createConversation(db, {
      workspaceId,
      title: typeof msg.title === 'string' && msg.title ? msg.title : '新会话',
      modeId: typeof msg.mode === 'string' ? msg.mode : 'craft'
    })
    activeConversationId = conv.id
    emit({ ...base, type: 'conversation.created', conversationId: conv.id })
    return true
  }

  if (msg.cmd === 'conversation.delete') {
    if (typeof msg.conversationId !== 'string') throw new Error('缺少 conversationId')
    deleteConversation(db, msg.conversationId)
    if (activeConversationId === msg.conversationId) {
      const next = listConversations(db, workspaceId)[0]
      activeConversationId =
        next?.id ??
        createConversation(db, { workspaceId, title: '默认会话', modeId: 'craft' }).id
    }
    emit({ ...base, type: 'conversation.deleted', conversationId: msg.conversationId })
    return true
  }

  if (msg.cmd === 'memory.list') {
    const scope = typeof msg.scope === 'string' ? (msg.scope as 'cloud' | 'user' | 'workspace') : undefined
    const items = listMemory(db, {
      ...(scope ? { scope } : {}),
      ...(scope === 'workspace' ? { workspaceId } : scope === 'user' ? { workspaceId: null } : {})
    })
    emit({ ...base, type: 'memory.list', items })
    return true
  }

  if (msg.cmd === 'memory.delete') {
    if (typeof msg.id !== 'string') throw new Error('缺少 id')
    // 必须在这里 await:删除要同时改库和 MEMORY.md,
    // 若 fire-and-forget,stdin 关闭时进程会先退出,造成"报成功但没删"。
    await deleteMemoryAndSync(db, DATA_DIR, msg.id)
    emit({ ...base, type: 'memory.deleted', id: msg.id })
    return true
  }

  return false
}

async function handleFrame(value: unknown) {
  const msg = value as Record<string, unknown>
  const requestId = msg.requestId

  if (!dbHandle) {
    emit({
      ...(requestId !== undefined ? { requestId } : {}),
      type: 'error',
      code: 'DB_UNAVAILABLE',
      message: fatal ?? '数据库未就绪',
      retryable: false
    })
    return
  }

  if (await handleCommand(msg, requestId)) return

  if (typeof msg.text !== 'string' || msg.text.length === 0) {
    emit({ type: 'error', code: 'EMPTY_INPUT', message: '输入为空', retryable: false })
    return
  }

  let mode: ModePolicy
  try {
    mode = resolveMode(msg.mode)
  } catch (err) {
    emit({ type: 'error', code: 'UNKNOWN_MODE', message: (err as Error).message, retryable: false })
    return
  }

  let conversationId: string
  try {
    conversationId = resolveConversationId(msg.conversationId)
  } catch (err) {
    emit({ type: 'error', code: 'UNKNOWN_CONVERSATION', message: (err as Error).message, retryable: false })
    return
  }

  const clientRequestId =
    typeof msg.clientRequestId === 'string' && msg.clientRequestId.length > 0
      ? msg.clientRequestId
      : undefined

  const db = requireDb()
  const saved = appendMessage(db, {
    conversationId,
    role: 'user',
    content: { text: msg.text },
    ...(clientRequestId ? { clientRequestId } : {})
  })

  if (saved.deduped) {
    // 幂等重放:不再调用模型,直接把已有历史回给客户端
    emit({
      type: 'deduped',
      conversationId,
      clientRequestId,
      messages: listMessages(db, conversationId)
    })
    return
  }

  emit({ type: 'conversation.ready', conversationId, seq: saved.record.seq })
  await runAgent({ text: msg.text, mode, conversationId, ...(clientRequestId ? { clientRequestId } : {}) })
}

process.stdin.on('data', (chunk: Buffer) => {
  let frames: unknown[]
  try {
    frames = decoder.push(chunk)
  } catch (err) {
    emit({ type: 'error', code: 'BAD_FRAME', message: (err as Error).message, retryable: false })
    process.exit(4)
  }
  for (const frame of frames) enqueue(() => handleFrame(frame))
})

process.stdin.on('end', () => {
  try {
    decoder.finish()
  } catch {
    // 对端半关闭属于正常退出路径,不视为错误
  }
  void queue
    .finally(async () => {
      await pluginRuntime.stopAll()
      dbHandle?.raw.close()
    })
    .finally(() => process.exit(0))
})

emit(helloFrame())
if (!dbHandle) {
  emit({ type: 'error', code: 'DB_UNAVAILABLE', message: fatal ?? '数据库未就绪', retryable: false })
}

emit({
  type: 'ready',
  protocolVersion: 2,
  dataDir: DATA_DIR,
  // 界面上"工作区"必须显示真实路径:工具读写的是这个目录,不是应用安装目录。
  workspace: WORKSPACE,
  conversationId: activeConversationId,
  modes: orderedModes().map((m) => ({ id: m.id, displayName: m.displayName })),
  skills: skills.list().map((s) => ({ name: s.name, description: s.description })),
  plugins: pluginStatusList()
})
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { access, cp, mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  generateText,
  streamText,
  tool,
  jsonSchema,
  type CoreMessage,
  type Tool,
  type ToolExecutionOptions
} from 'ai'
import { z } from 'zod'
import { listRemoteModels, modelFor, resolveModelName } from './model.js'
import { probeServiceEndpoint } from './service-probe.js'
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
import { ToolError, ToolRegistry, type ToolDescriptor } from '@openwb/tools'
import type { SkillRoot } from '@openwb/skills'
import { validateSkillDir } from '@openwb/skills'
import { FrameDecoder, encodeFrame, helloFrame } from '@openwb/protocol'
import {
  appendEvent,
  appendMessage,
  insertArtifacts,
  countArtifactsByTask,
  listArtifactsByConversation,
  createChannel,
  deleteChannel,
  enqueuePending,
  listChannelArtifacts,
  listChannels,
  listPending,
  resetPendingBackoff,
  shareArtifactToChannel,
  search,
  createConversation,
  createTask,
  deleteConversation,
  ensureWorkspace,
  getConversation,
  getPlugin,
  listConversationSummaries,
  listConversations,
  renameConversation,
  setConversationAutoTitle,
  conversationDisplayTitle,
  reorderPinnedConversations,
  setConversationColleague,
  setConversationExpert,
  setConversationPinned,
  listMessages,
  getMessage,
  setMessageFeedback,
  truncateConversationFrom,
  listPlugins,
  deletePlugin,
  migrateOrThrow,
  openDatabase,
  setPluginEnabled,
  transitionTask,
  upsertPlugin,
  hasActiveApprovalGrant,
  listApprovalGrants,
  pruneExpiredApprovalGrants,
  upsertApprovalGrant,
  deleteApprovalGrant,
  getWorkspaceSettings,
  setWorkspaceSetting,
  setDisabledSkills,
  setPinnedSkills,
  listLibraryArtifacts,
  listColleagues,
  getColleague,
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  assertProjectInWorkspace,
  setConversationProject,
  listConnections,
  setConnection,
  disconnectService,
  isServiceProvider,
  listInspirations,
  createInspiration,
  setInspirationFavorite,
  deleteInspiration,
  createColleague,
  updateColleague,
  deleteColleague,
  assertColleagueAssignable,
  type AppDatabase,
  type ConversationRecord,
  createNotification,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  unreadNotificationCount,
  type WorkspaceSettings,
  type SettingKey,
  type ColleagueInput,
  type PermissionMode,
  getConversationSummary,
  upsertConversationSummary,
  invalidateConversationSummaryFrom,
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
import { builtinTools, configureDestructiveTools, resolveInsideWorkspace } from './tools/builtin.js'
import {
  PluginRuntime,
  discoverPlugins,
  installPlugin,
  uninstallPlugin,
  PluginInstallError
} from '@openwb/plugins'
import { SkillRuntime, defaultSkillRoots } from './skills/runtime.js'
import { summarizeToolResult, toToolFailure } from './tool-summary.js'
import {
  DEFAULT_HISTORY_LIMITS,
  historyNotice,
  trimHistoryMessages,
  type HistoryLimits,
  type HistoryMessage
} from './history.js'
import {
  buildSummaryPrompt,
  fallbackSummary,
  planCompression,
  summaryContextText,
  toHistoryMessages
} from './context-summary.js'
import {
  DEFAULT_MAX_STREAM_ATTEMPTS,
  DEFAULT_RETRY_BASE_MS,
  decideModelFallback,
  decideStreamRetry,
  isRetryableStreamError,
  retryDelayMs,
  sleepWithAbort
} from './retry.js'
import { WorkflowService } from './workflows/service.js'
import { flushPending, normalizeSyncUrl, startSyncLoop, SyncError } from './sync/client.js'
import {
  InMemorySessionGrants,
  MAX_DESTRUCTIVE_BATCH,
  MemoryTrashAdapter,
  SecurityError,
  builtinRisk,
  classifyPath,
  classifyRisk,
  decide,
  destructiveRequestFromTool,
  inspectDestructiveRequest,
  platformTrashAdapter,
  type ApprovalPlan,
  type ApprovalRequest,
  type DestructivePlan,
  type GateContext,
  type RiskAssessment
} from '@openwb/security'
import { ApprovalBridge, ApprovalUnavailableError } from './security/approval-bridge.js'
import { CheckpointStore } from './checkpoint-store.js'

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
const WORKFLOWS_DIR = await resolveResourceDir(process.env.OPENWB_WORKFLOWS_DIR, 'workflows')
const SKILLS_DIR = process.env.OPENWB_SKILLS_DIR
// 内置技能与模式目录同级:resources/modes -> resources/skills
const BUNDLED_SKILLS_DIR =
  process.env.OPENWB_BUNDLED_SKILLS_DIR ?? resolve(MODES_DIR, '..', 'skills')
const TRACE_DIR = resolve(WORKSPACE, '.openwb/traces')
const MOCK = process.env.OPENWB_MOCK === '1'
const HOST_VERSION = process.env.OPENWB_HOST_VERSION ?? '0.0.1'
const MAX_STEPS = 5
const STREAM_MAX_ATTEMPTS_RAW = Number(process.env.OPENWB_STREAM_MAX_ATTEMPTS ?? DEFAULT_MAX_STREAM_ATTEMPTS)
const STREAM_MAX_ATTEMPTS =
  Number.isFinite(STREAM_MAX_ATTEMPTS_RAW) && STREAM_MAX_ATTEMPTS_RAW >= 1
    ? Math.floor(STREAM_MAX_ATTEMPTS_RAW)
    : DEFAULT_MAX_STREAM_ATTEMPTS
const STREAM_RETRY_BASE_RAW = Number(process.env.OPENWB_STREAM_RETRY_BASE_MS ?? DEFAULT_RETRY_BASE_MS)
const STREAM_RETRY_BASE_MS =
  Number.isFinite(STREAM_RETRY_BASE_RAW) && STREAM_RETRY_BASE_RAW >= 0
    ? STREAM_RETRY_BASE_RAW
    : DEFAULT_RETRY_BASE_MS
/** 历史上下文预算;E2E 用较小的值强制触发压缩,生产保持默认。 */
const HISTORY_MAX_CHARS_RAW = Number(process.env.OPENWB_HISTORY_MAX_CHARS ?? DEFAULT_HISTORY_LIMITS.maxChars)
const HISTORY_MAX_CHARS =
  Number.isFinite(HISTORY_MAX_CHARS_RAW) && HISTORY_MAX_CHARS_RAW >= 500
    ? Math.floor(HISTORY_MAX_CHARS_RAW)
    : DEFAULT_HISTORY_LIMITS.maxChars
const HISTORY_MAX_MESSAGES_RAW = Number(
  process.env.OPENWB_HISTORY_MAX_MESSAGES ?? DEFAULT_HISTORY_LIMITS.maxMessages
)
const HISTORY_MAX_MESSAGES =
  Number.isFinite(HISTORY_MAX_MESSAGES_RAW) && HISTORY_MAX_MESSAGES_RAW >= 2
    ? Math.floor(HISTORY_MAX_MESSAGES_RAW)
    : DEFAULT_HISTORY_LIMITS.maxMessages
const HISTORY_LIMITS: HistoryLimits = {
  maxChars: HISTORY_MAX_CHARS,
  maxMessages: HISTORY_MAX_MESSAGES
}
/** 压缩后至少保留原文的条数;低于 6 条时模型很难接上"刚才那个"这类指代。 */
const HISTORY_MIN_KEEP = 6
const SYNC_URL = process.env.OPENWB_SYNC_URL?.trim() ?? ''
const SYNC_TOKEN = process.env.OPENWB_SYNC_TOKEN?.trim() || undefined
/** 审批授权默认 30 天;显式配置用于测试与合规缩短 */
const APPROVAL_TTL_DAYS = Number(process.env.OPENWB_APPROVAL_TTL_DAYS ?? 30)
const APPROVAL_TIMEOUT_MS = Number(process.env.OPENWB_APPROVAL_TIMEOUT_MS ?? 120_000)

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
/** 破坏性操作备份:用户必须能从这里取回文件,因此放在可浏览的数据目录下。 */
const DESTRUCTIVE_BACKUP_DIR = resolve(DATA_DIR, 'backups', 'destructive')
configureDestructiveTools({
  backupRoot: DESTRUCTIVE_BACKUP_DIR,
  // 端到端测试不能真的清空开发机回收站;生产仍使用平台回收站。
  ...(process.env.OPENWB_TRASH_FAKE === '1'
    ? { trash: new MemoryTrashAdapter() }
    : { trash: platformTrashAdapter() })
})
/** 已安装插件的根目录;数据库记录与磁盘目录必须同时存在 */
const PLUGINS_DIR = resolve(DATA_DIR, 'plugins')
const PLUGIN_DATA_DIR = resolve(DATA_DIR, 'plugin-data')

function emit(event: unknown) {
  process.stdout.write(encodeFrame(event))
}

/**
 * 协议握手帧必须是 stdout 的第一帧。
 * 插件启动、审批等路径都可能提前 emit,因此这里在定义 emit 后立即握手,
 * 而不是等所有初始化完成再发——否则首帧会被 plugin.status 抢占。
 */
emit(helloFrame())

const approvalBridge = new ApprovalBridge({
  emit: (event) => emit(event),
  newId: () => `apr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  timeoutMs: APPROVAL_TIMEOUT_MS,
  onRequest: (request) => {
    if (!dbHandle) return
    try {
      createNotification(dbHandle.db, {
        workspaceId,
        biz: 'approval',
        title: `需要你确认:${request.toolName}`,
        summary: request.detail || '有一个操作正在等待授权',
        ...(typeof request.conversationId === 'string' ? { conversationId: request.conversationId } : {}),
        isPending: true,
        dedupeKey: `approval-${request.id}`
      })
    } catch (err) {
      process.stderr.write(`[notification] 审批提醒写入失败: ${(err as Error).message}\n`)
    }
  },
  log: (message) => process.stderr.write(`${message}\n`)
})
const sessionGrants = new InMemorySessionGrants()

const decoder = new FrameDecoder()

/**
 * 正在运行的会话对应的中断句柄。
 *
 * 用户点击"停止"时必须能真正取消模型流与后续工具执行,而不是只把按钮置灰。
 * 每个会话最多一个在跑的任务,重复发送在 UI 层已被挡住;这里仍然按会话隔离,
 * 避免误停到别的会话。
 */
let fatal: string | null = null
let dbHandle: ReturnType<typeof openDatabase> | null = null
let checkpointStore: CheckpointStore | null = null
let workspaceId = ''
let activeConversationId = ''
let stopSync: (() => void) | null = null

const activeRuns = new Map<string, AbortController>()
/**
 * 用户可能在一轮任务还没有建立 AbortController 时就点了停止(例如还在读上下文)。
 * 记住"这个会话下一次真正开始时要立刻停",避免这次停止被吞掉。
 */
const pendingCancels = new Set<string>()
/** 已受理、正在准备或执行中的会话:用于区分"还没开始"和"根本没在跑"。 */
const startingRuns = new Set<string>()

class RunCancelledError extends Error {
  constructor() {
    super('用户已停止本次生成')
    this.name = 'RunCancelledError'
  }
}

function cancelRun(conversationId: string | undefined): boolean {
  if (!conversationId) {
    // 没有指定会话时,按当前活跃会话取消;再兜底取消唯一在跑的任务。
    const fallback = activeRuns.has(activeConversationId)
      ? activeConversationId
      : startingRuns.has(activeConversationId)
        ? activeConversationId
        : activeRuns.size + [...startingRuns].filter((id) => !activeRuns.has(id)).length === 1
          ? ([...activeRuns.keys()][0] ?? [...startingRuns][0])
        : undefined
    if (!fallback) return false
    conversationId = fallback
  }
  const controller = activeRuns.get(conversationId)
  if (!controller) {
    if (!startingRuns.has(conversationId)) return false
    pendingCancels.add(conversationId)
    return true
  }
  controller.abort()
  // 正在等审批的工具调用不会自己观察 AbortSignal:必须让审批桥立即拒绝,
  // 否则界面已经显示"已停止",daemon 还挂着一张永不回答的审批卡。
  approvalBridge.cancelForConversation(conversationId, '用户已停止本次生成,该操作没有执行')
  return true
}


try {
  dbHandle = openDatabase(DB_PATH)
  migrateOrThrow(dbHandle.raw, { dbPath: DB_PATH })
  const ws = ensureWorkspace(dbHandle.db, WORKSPACE)
  workspaceId = ws.id
  checkpointStore = new CheckpointStore({
    db: dbHandle.db,
    workspaceRoot: WORKSPACE,
    dataDir: DATA_DIR
  })
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

/**
 * 当前工作区的权限档位。每次判定都现读,避免界面切了档位而工具闸门还拿着旧值。
 *
 * - readOnly:只读。写文件、命令、删除/移动一律拒绝(模式允许也不行)。
 * - fullAccess:已知风险(个人文件、计费、破坏性文件操作)自动放行;
 *   未知风险仍然询问,因为"完全访问"不等于"替用户决定看不懂的操作"。
 * - default:维持原有逐项审批。
 */
function currentPermissionMode(): PermissionMode {
  const db = requireDb()
  return getWorkspaceSettings(db, workspaceId).permissionMode
}

/** 只读档位下必须拒绝的工具:任何写盘、命令执行、删除/移动都在此列。 */
const READ_ONLY_FORBIDDEN_TOOLS = new Set([
  'write_file',
  'shell',
  'delete_files',
  'move_files',
  'present_files'
])

/**
 * 完全访问档位的判定:跳过"已知风险"的人工确认,但保留两条硬边界:
 *  - 模式本身不允许的工具仍然拒绝(档位不扩大模式边界);
 *  - 计费类工具仍然询问(替用户花钱不是"文件权限")。
 * 未知风险仍然走完整 decide(),避免把解析不了的调用当安全。
 */
async function decideFullAccess(
  call: { name: string; arguments: Record<string, unknown> },
  mode: ModePolicy,
  conversationId: string
): Promise<Awaited<ReturnType<typeof decide>>> {
  if (!modeAllowsTool(mode, call.name)) {
    return { action: 'deny', code: 'MODE_DENIED', message: `当前模式不允许使用 ${call.name}`, retryable: false }
  }
  const ctx = gateContextFor(mode, conversationId)
  const risk = await ctx.classifyRisk(call.name, call.arguments)
  if (!risk) return { action: 'allow' }
  if (risk.kind === 'unknown') return await decide(call, ctx)
  if (risk.kind === 'blocked-command') {
    return { action: 'deny', code: risk.code ?? 'BLOCKED_COMMAND', message: risk.detail, retryable: false }
  }
  if (risk.kind === 'system-path') {
    return { action: 'deny', code: 'PATH_SYSTEM_DENIED', message: risk.detail, retryable: false }
  }
  if (risk.kind === 'billing') return await decide(call, ctx)
  return { action: 'allow' }
}

function skillRoots(): SkillRoot[] {
  const explicitUserDir = process.env.OPENWB_USER_SKILLS_DIR
  if (SKILLS_DIR) {
    const roots: SkillRoot[] = SKILLS_DIR.split(';')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((path) => ({ path: resolve(path), scope: 'project' as const }))
    if (explicitUserDir) roots.push({ path: resolve(explicitUserDir), scope: 'user' })
    // 自定义项目技能根目录时仍需要一个可写用户目录:导入、卸载和状态持久化都依赖它。
    if (!roots.some((root) => root.scope === 'user')) {
      roots.push({ path: resolve(DATA_DIR, 'skills'), scope: 'user' })
    }
    return roots
  }
  const roots = defaultSkillRoots(WORKSPACE, BUNDLED_SKILLS_DIR)
  if (!explicitUserDir) return roots
  return roots.map((root) =>
    root.scope === 'user' ? { path: resolve(explicitUserDir), scope: 'user' as const } : root
  )
}

const skills = new SkillRuntime(skillRoots())

/** 技能读写必须落在用户级技能根目录;项目级与内置目录只读。 */
function userSkillsRoot(): string {
  const root = skillRoots().find((item) => item.scope === 'user')
  if (!root) throw new Error('未配置用户技能目录')
  return root.path
}

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
  emit({ type: 'error', code: 'MODES_FAILED', message: (err as Error).message, retryable: false })
  process.exit(2)
}

const discovered = await skills.refresh()
if (dbHandle) {
  skills.setDisabled(getWorkspaceSettings(dbHandle.db, workspaceId).disabledSkills)
}
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

interface RunToolContext {
  taskId: string
  conversationId: string
  /** 本轮是否写过文件:用于收尾时判定交付是否缺失 */
  wroteFiles?: { value: boolean }
  /** 用户停止生成时,正在执行或即将执行的工具必须立刻退出 */
  signal?: AbortSignal
}

/**
 * 构造一次工具调用所需的闸门上下文。
 *
 * 风险分类每次调用都重新读插件清单:运行期清单被改坏时必须立刻 fail-closed,
 * 不能继续用启动时的内存快照放行。
 */
function gateContextFor(
  mode: ModePolicy,
  conversationId: string,
  callId?: string,
  approvalPlan?: ApprovalPlan
): GateContext {
  const db = requireDb()
  return {
    workspaceRoot: WORKSPACE,
    conversationId,
    ...(callId ? { callId } : {}),
    ...(approvalPlan ? { approvalPlan } : {}),
    ttlDays: APPROVAL_TTL_DAYS,
    modeAllows: (name) => modeAllowsTool(mode, name),
    classifyRisk: async (name, args) =>
      await classifyRisk(
        {
          name,
          arguments: args,
          effects: { writesFilesystem: registry.get(name)?.effects.writesFilesystem === true }
        },
        {
          workspaceRoot: WORKSPACE,
          resolveManifestTool: (plugin, tool) => pluginRuntime.manifestRiskOf(plugin, tool),
          classifyPath: (target, root) => classifyPath(target, root),
          builtinRisk: (call): ReturnType<typeof builtinRisk> => builtinRisk(call)
        }
      ),
    requestApproval: (request) => approvalBridge.request(request),
    sessionGrants,
    persistentGrants: {
      has: (groupKey, now) => hasActiveApprovalGrant(db, groupKey, now),
      add: (groupKey, toolName, expiresAt) => {
        upsertApprovalGrant(db, { groupKey, toolName, expiresAt, scope: 'always' })
      }
    },
    newApprovalId: () => approvalBridge.newId(),
    log: (message) => process.stderr.write(`${message}\n`)
  }
}

/**
 * 唯一允许执行工具的内部入口:任何绕过它的调用都意味着跳过审批闸门,
 * 因此 buildTools、mock 与工作流都必须走这里。
 */
async function executeGated(
  descriptorName: string,
  input: unknown,
  mode: ModePolicy,
  conversationId: string,
  ctx: {
    taskId?: string | null
    callId?: string
    wroteFiles?: { value: boolean }
    signal?: AbortSignal
  }
): Promise<unknown> {
  // 取消必须发生在任何副作用之前:审批通过后再检查已经太晚,
  // 用户按下停止后不应再看到新的工具调用被放行。
  if (ctx.signal?.aborted) throw new RunCancelledError()

  const descriptor = registry.get(descriptorName)
  if (!descriptor) throw new ToolError('TOOL_NOT_FOUND', `工具不存在: ${descriptorName}`)
  const args =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : { value: input }

  // 只读档位必须在任何副作用发生之前生效:包括破坏性工具的清单扫描。
  const permission = currentPermissionMode()
  if (permission === 'readOnly' && READ_ONLY_FORBIDDEN_TOOLS.has(descriptorName)) {
    emit({
      type: 'approval.denied',
      ...(ctx.callId ? { callId: ctx.callId } : {}),
      toolName: descriptorName,
      code: 'READ_ONLY_MODE',
      message: `当前是只读权限,${descriptorName} 需要写入或执行能力,已被拒绝。`,
      retryable: false
    })
    throw new ToolError('READ_ONLY_MODE', `当前是只读权限,${descriptorName} 已被拒绝`)
  }

  // 破坏性文件操作必须先形成完整清单:审批卡展示的是这份清单,执行器也会重新核对它。
  let destructivePlan: DestructivePlan | undefined
  let approvalPlan: ApprovalPlan | undefined
  if (descriptorName === 'delete_files' || descriptorName === 'move_files') {
    if (!isToolAllowed(mode, descriptorName)) {
      throw new ToolError('MODE_DENIED', `当前模式不允许使用 ${descriptorName}`)
    }
    // 首轮扫描保护在"列清单"之前就生效:连计划都不允许生成,更不会触碰磁盘内容。
    assertDestructiveAllowed(conversationId)
    try {
      const request = destructiveRequestFromTool(descriptorName, args)
      destructivePlan = await inspectDestructiveRequest(request, { workspaceRoot: WORKSPACE })
      approvalPlan = {
        operation: destructivePlan.operation,
        items: destructivePlan.items.map((item) => ({
          path: item.path,
          kind: item.kind,
          size: item.size,
          ...(item.destPath ? { destPath: item.destPath } : {})
        })),
        totalBytes: destructivePlan.totalBytes,
        batchLimit: MAX_DESTRUCTIVE_BATCH
      }
    } catch (err) {
      if (err instanceof SecurityError) {
        emit({
          type: 'approval.denied',
          ...(ctx.callId ? { callId: ctx.callId } : {}),
          toolName: descriptorName,
          code: err.code,
          message: err.message,
          retryable: false
        })
        throw new ToolError(err.code, err.message)
      }
      throw err
    }
  }

  // 删除/移动在 agent 循环里可能被同一轮多次调用:每轮只允许执行一次,避免"批准后追加删除"。
  if (
    (descriptorName === 'delete_files' || descriptorName === 'move_files') &&
    destructiveCallsThisTurn.has(conversationId)
  ) {
    throw new ToolError(
      'DESTRUCTIVE_ALREADY_RAN',
      '本轮已经执行过一次删除/移动。请先向用户汇报结果,下一轮确认后再继续。'
    )
  }

  const decision =
    permission === 'fullAccess' && !descriptor.effects.mayIncurCost
      ? await decideFullAccess({ name: descriptorName, arguments: args }, mode, conversationId)
      : await decide(
          { name: descriptorName, arguments: args },
          gateContextFor(mode, conversationId, ctx.callId, approvalPlan)
        )
  if (
    (descriptorName === 'delete_files' || descriptorName === 'move_files') &&
    decision.action === 'allow' &&
    !destructiveCallsThisTurn.has(conversationId)
  ) {
    destructiveCallsThisTurn.add(conversationId)
  }
  if (decision.action === 'deny') {
    emit({
      type: 'approval.denied',
      ...(ctx.callId ? { callId: ctx.callId } : {}),
      toolName: descriptorName,
      code: decision.code,
      message: decision.message,
      retryable: decision.retryable
    })
    throw new ToolError(decision.code, decision.message)
  }

  skills.assertAllowed(descriptorName)
  if (descriptor.effects.writesFilesystem && ctx.wroteFiles) ctx.wroteFiles.value = true
  if (ctx.signal?.aborted) throw new RunCancelledError()
  return await descriptor.execute(args, {
    workspaceRoot: WORKSPACE,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(destructivePlan ? { destructivePlan } : {}),
    ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
    ...(ctx.taskId ? { conversationId } : {}),
    ...(ctx.taskId
      ? { artifactSink: artifactSinkFor(ctx.taskId, conversationId) }
      : {})
  })
}

/**
 * 交付物写入器:工具只负责校验与算哈希,落库与事件在这里完成。
 * 事件只在真正新增时发出:同一任务重复交付同一文件不会再冒一张卡片。
 */
function artifactSinkFor(taskId: string, conversationId: string) {
  const db = requireDb()
  return {
    insert: async (items: Array<{ kind: 'file' | 'html' | 'url' | 'image'; title: string; description?: string; path?: string; url?: string; size?: number; sha256?: string }>) => {
      const results = insertArtifacts(db, { taskId, conversationId, items })
      for (const r of results) {
        if (r.deduped) continue
        appendEvent(db, conversationId, 'artifact.created', { artifact: r.record })
        emit({ type: 'artifact.created', artifact: r.record })
      }
      return results.map((r) => ({ id: r.record.id, deduped: r.deduped }))
    }
  }
}

/**
 * WM-DELIVER-01 的运行时兜底。
 * 提示词能劝模型交付,但劝不住:只要写过文件而任务没有任何交付物,
 * 就必须在任务上留下 DELIVERY_MISSING,让界面明确提示"东西还没到你手上"。
 */
function checkDelivery(taskId: string, conversationId: string, wroteFiles: boolean): boolean {
  if (!wroteFiles) return false
  const db = requireDb()
  if (countArtifactsByTask(db, taskId) > 0) return false
  emit({ type: 'delivery.missing', taskId, conversationId, code: 'DELIVERY_MISSING' })
  appendEvent(db, conversationId, 'delivery.missing', { taskId, code: 'DELIVERY_MISSING' })
  return true
}

function buildTools(mode: ModePolicy, allowedNames: string[], run?: RunToolContext) {
  const allowed = new Set(allowedNames)
  const result: Record<string, ExecutableTool> = {}

  for (const descriptor of registry.selectFor((name) => allowed.has(name))) {
    result[descriptor.name] = tool({
      description: descriptor.description,
      parameters: descriptor.inputSchema
        ? jsonSchema<Record<string, unknown>>(descriptor.inputSchema as any)
        : descriptor.parameters,
      execute: async (input, options) => {
        if (!modeAllowsTool(mode, descriptor.name)) {
          return toToolFailure(new Error(`当前模式(${mode.displayName})不允许使用 ${descriptor.name}`))
        }
        try {
          return await executeGated(descriptor.name, input, mode, run?.conversationId ?? activeConversationId, {
            ...(run ? { taskId: run.taskId, wroteFiles: run.wroteFiles } : {}),
            ...(run?.signal ? { signal: run.signal } : {}),
            ...(options?.toolCallId ? { callId: options.toolCallId } : {})
          })
        } catch (err) {
          // 用户停止生成不是"工具失败":把它转成普通工具结果会让模型继续跑,
          // 必须让异常一路冒泡到本轮运行层,由那里统一收尾。
          if (run?.signal?.aborted || err instanceof RunCancelledError) throw err
          if (err instanceof ApprovalUnavailableError) {
            // 审批通道断开必须显式告知界面"没有执行、可重试",不能只当普通工具失败。
            emit({
              type: 'error',
              code: err.code,
              message: err.message,
              retryable: true
            })
          }
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

function effectiveTools(mode: ModePolicy, colleague?: { connectorNames: string[] } | null): string[] {
  const base = modeTools(mode)
  // 一旦助理参与运行,连接器就是显式白名单:未绑定任何连接器 = 看不到第三方工具。
  const narrowedBase =
    colleague
      ? base.filter((name) => {
          if (!isPluginToolName(name)) return true
          const pluginName = name.split('__')[0] ?? ''
          return colleague.connectorNames.includes(pluginName)
        })
      : base
  if (narrowedBase.length === 0 || skills.list().length === 0) return narrowedBase
  return [...skills.narrow(narrowedBase), 'load_skill'].sort()
}

function requireDb() {
  if (!dbHandle) throw new Error(fatal ?? '数据库未就绪')
  return dbHandle.db
}

/**
 * 工作流/自动化服务。
 * 放在 requireDb 之后、命令处理之前:命令只做参数校验与转发,
 * 真正的编排、落盘、调度都在服务内,避免 index.ts 继续膨胀。
 */
const workflowService: WorkflowService | null = dbHandle
  ? new WorkflowService({
      db: dbHandle.db,
      workspaceId,
      workspaceRoot: WORKSPACE,
      dataDir: DATA_DIR,
      builtinDir: WORKFLOWS_DIR,
      registry,
      emit: (event) => emit(event),
      log: (message) => process.stderr.write(`${message}\n`),
      onAutomationFinished: ({ id, name, status, conversationId }) => {
        createNotification(requireDb(), {
          workspaceId,
          biz: 'automation',
          title: `${status === 'done' ? '定时任务已完成' : '定时任务执行失败'}:${name}`,
          summary:
            status === 'done'
              ? '自动执行已结束,点开查看本次结果。'
              : '自动执行未能完成,点开后可以检查会话并重试。',
          conversationId,
          dedupeKey: `automation-${id}-${status}-${conversationId}`
        })
      },
      gateToolExecution: async ({ name, args, conversationId, signal }) => {
        const mode = modes.get('craft')
        if (!mode) throw new Error('默认模式不可用')
        return await executeGated(name, args, mode, conversationId, {
          ...(signal ? { signal } : {})
        })
      },
      runAutomationPrompt: async ({ conversationId, prompt, modeId }) => {
        // WM-AUTO-03:新会话、空上下文;不读取任何历史消息。
        // 但审计链必须完整:先把 prompt 写成 user 消息,再执行。
        appendMessage(requireDb(), {
          conversationId,
          role: 'user',
          content: { text: prompt }
        })
        const mode = resolveMode(modeId)
        const status = await runAgent({ text: prompt, mode, conversationId })
        return { status }
      }
    })
  : null

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
  /** 本轮用户消息 ID;任务据此归属到具体轮次,回退时才能精确清理。 */
  userMessageId?: string
  /** 本轮是否是该会话的第一轮;只有首轮才生成自动标题。 */
  firstTurn?: boolean
  /** 用户显式选中的技能:本轮开始时直接加载,不依赖模型自己调用 load_skill。 */
  skill?: string
  /** @ 引用的工作区相对路径,发送前注入正文。 */
  contextPaths?: string[]
  /** 助理身份:人设指令与本轮默认技能。 */
  colleagueId?: string
  /** 专家角色:来自插件清单,一个会话最多一个。 */
  expertId?: string
  /** 首页场景:办公 / 开发 / 设计。 */
  scene?: 'working' | 'coding' | 'design'
}

const SCENE_PROMPTS: Record<NonNullable<RunInput['scene']>, string> = {
  working:
    '当前是「办公」场景。优先产出可直接使用的中文办公成果(文档、表格、汇报、邮件、会议纪要);除非用户明确要求,不要写代码。',
  coding:
    '当前是「开发」场景。优先使用工程化做法:先读代码与配置,再修改;改动要可运行、可验证,并说明如何验证。',
  design:
    '当前是「设计」场景。优先关注信息层级、视觉一致性、可访问性与可落地的设计说明;需要产出页面时给出具体结构与样式方案。'
}

const MAX_CONTEXT_FILES = 20
const MAX_CONTEXT_FILE_BYTES = 64 * 1024
const MAX_CONTEXT_TOTAL_BYTES = 256 * 1024

/** trace 只记录"哪些上下文段落进入了 system",不落原文,避免把记忆/文件内容写进审计。 */
function injectedSections(
  input: RunInput,
  project?: { name: string } | null
): string[] {
  const sections: string[] = []
  if (project) sections.push('project')
  if (input.scene) sections.push('scene')
  if (input.colleagueId) sections.push('colleague')
  if (input.expertId) sections.push('expert')
  if ((input.contextPaths ?? []).length > 0) sections.push('context')
  return sections
}

/**
 * 解析本轮要使用的专家。
 *
 * 专家是插件清单资产,可能被卸载或关闭;每次发送都重新校验,
 * 避免已失效的 expert_id 继续以旧身份运行。
 */
function requireExpert(expertId: string): { id: string; name: string; description: string; instructions: string } {
  const plugin = pluginRuntime.snapshotOf(expertId)
  if (!plugin || plugin.kind !== 'expert') {
    throw new Error(`专家不存在: ${expertId}`)
  }
  if (!plugin.enabled) throw new Error(`专家已关闭: ${plugin.displayName}`)
  return {
    id: plugin.name,
    name: plugin.displayName,
    description: plugin.description,
    instructions: plugin.instructions
  }
}

/**
 * 会话已绑定专家时,插件可能在之后被关闭或卸载。
 * 这种情况不应让用户永久无法发送:解除绑定并提示一次,后续按普通会话运行。
 */
function resolveConversationExpert(db: AppDatabase, conversationId: string, requested: string | undefined, existing: ConversationRecord | undefined): string | undefined {
  const candidate = requested ?? existing?.expertId ?? undefined
  if (!candidate) return undefined
  try {
    requireExpert(candidate)
    return candidate
  } catch (err) {
    if (requested) throw err
    setConversationExpert(db, conversationId, null)
    process.stderr.write(`[expert] 已解除失效专家绑定 ${conversationId}: ${(err as Error).message}\n`)
    emit({ type: 'expert.released', conversationId, expertId: candidate, reason: (err as Error).message })
    return undefined
  }
}

function expertLabel(expertId: string | null): string | null {
  if (!expertId) return null
  const plugin = pluginRuntime.snapshotOf(expertId)
  return plugin && plugin.kind === 'expert' ? plugin.displayName : null
}

/**
 * 把首页/输入框里的隐式意图变成运行时可见的上下文。
 *
 * 这些内容必须进入 system 而不是拼进用户文本:用户消息要保持原样,
 * 重放历史与幂等去重才不会因为宿主拼接而变化。
 */
async function applyHarnessContext(
  input: RunInput,
  prepared: { system: string; modeTools: string[]; assembled: AssembledPrompt },
  project?: { name: string; description: string; instructions: string } | null
): Promise<string> {
  let system = prepared.system

  if (project) {
    const lines = [
      '',
      '# 项目上下文',
      `当前任务归属于项目「${project.name}」。`,
      project.description ? `项目简介: ${project.description}` : '',
      project.instructions ? `项目指令(优先遵守):\n${project.instructions}` : '',
      '项目内产出应服务于该项目目标;不要假设你拥有未提供的项目成员或云端权限。'
    ].filter(Boolean)
    system += `\n${lines.join('\n')}`
  }

  if (input.scene) {
    system += `\n\n# 场景\n${SCENE_PROMPTS[input.scene]}`
  }

  if (input.colleagueId) {
    const colleague = getColleague(requireDb(), input.colleagueId)
    if (!colleague || colleague.workspaceId !== workspaceId) {
      throw new Error(`助理不存在或不属于当前工作区: ${input.colleagueId}`)
    }
    const lines = [
      '',
      '# 助理身份',
      `你正在以「${colleague.name}」的身份工作${colleague.title ? `(${colleague.title})` : ''}。`,
      colleague.description ? `职责简介: ${colleague.description}` : '',
      colleague.instructions ? `必须遵守的工作准则:\n${colleague.instructions}` : '',
      '保持该身份的语气与职责边界;不要声称自己拥有未提供的权限。'
    ].filter(Boolean)
    system += `\n${lines.join('\n')}`
  }

  if (input.expertId) {
    const expert = requireExpert(input.expertId)
    const lines = [
      '',
      '# 专家角色',
      `你正在以「${expert.name}」专家身份工作。`,
      expert.description ? `专长: ${expert.description}` : '',
      expert.instructions ? `必须遵守的专业准则:\n${expert.instructions}` : '',
      '保持专业边界;不要声称拥有未提供的权限。'
    ].filter(Boolean)
    system += `\n${lines.join('\n')}`
  }

  const contextPaths = (input.contextPaths ?? []).slice(0, MAX_CONTEXT_FILES)
  if (contextPaths.length > 0) {
    const chunks: string[] = []
    let total = 0
    let injected = 0
    for (const raw of contextPaths) {
      const rel = raw.replace(/^@/, '').trim()
      if (!rel) continue
      try {
        const abs = await resolveInsideWorkspace(WORKSPACE, rel)
        const buf = await readFile(abs)
        const budget = Math.max(0, MAX_CONTEXT_TOTAL_BYTES - total)
        const limit = Math.min(MAX_CONTEXT_FILE_BYTES, budget)
        const body = buf.subarray(0, limit).toString('utf8')
        total += Buffer.byteLength(body, 'utf8')
        injected++
        chunks.push(
          `## ${rel}${buf.length > limit ? `(已截断,原文件 ${buf.length} 字节)` : ''}\n\`\`\`\n${body}\n\`\`\``
        )
      } catch (err) {
        chunks.push(`## ${rel}\n[无法读取: ${(err as Error).message}]`)
      }
      if (total >= MAX_CONTEXT_TOTAL_BYTES) break
    }
    if (chunks.length > 0) {
      system += `\n\n# 用户附加的上下文\n这些是用户通过 @ 显式附带的文件,回答时优先参考。\n\n${chunks.join('\n\n')}`
    }
    emit({ type: 'context.attached', paths: contextPaths, injected, bytes: total })
  }

  return system
}

/**
 * WM-SEC-02:扫描类请求首轮只读。
 *
 * 仅靠提示词不足以阻止模型直接删除,因此在运行时记录"该会话刚刚收到清理类请求";
 * 下一轮用户明确要求执行时解除。状态只影响破坏性文件工具,不影响正常读写。
 */
const scanOnlyTurns = new Map<string, number>()
let conversationTurn = 0
/** 当前轮用户原始输入按会话隔离:并发工作流不能把 A 会话的文本带到 B 会话。 */
const activePromptByConversation = new Map<string, { text: string; turn: number }>()
/** 每个会话每轮最多执行一次破坏性文件操作 */
const destructiveCallsThisTurn = new Set<string>()

const SCAN_INTENT = /(清理|清空|扫描|分析.*(磁盘|空间|文件)|释放.*(空间|磁盘)|找出.*(大文件|垃圾|重复)|disk\s*cleanup|free\s*(up\s*)?space)/i
const SCAN_EXECUTION = /(执行|开始|确认|删除|清空|清理吧|动手|apply|execute|go ahead)/i

export function isScanOnlyRequest(text: string): boolean {
  // 同一条消息里即使写了"并删除",只要它本身是清理/扫描请求,本轮仍只允许报告。
  // 否则模型可以用一句"清理磁盘并直接删除"绕过"首轮只读"。
  return SCAN_INTENT.test(text)
}

function markScanTurn(conversationId: string, text: string): void {
  conversationTurn++
  activePromptByConversation.set(conversationId, { text, turn: conversationTurn })
  destructiveCallsThisTurn.delete(conversationId)
  if (isScanOnlyRequest(text)) scanOnlyTurns.set(conversationId, conversationTurn)
}

function assertDestructiveAllowed(conversationId: string): void {
  const marked = scanOnlyTurns.get(conversationId)
  if (marked === undefined) return
  const active = activePromptByConversation.get(conversationId)
  const text = active?.text ?? ''
  // 只有"后续的新一轮"里明确要求执行,才解除首轮只读;
  // 首轮自己夹带"删除"不算确认,必须先生成报告给用户看。
  if (marked < conversationTurn && SCAN_EXECUTION.test(text)) {
    scanOnlyTurns.delete(conversationId)
    return
  }
  throw new ToolError(
    'SCAN_REPORT_REQUIRED',
    '这是清理/扫描类请求的第一轮:只允许产出报告,不会修改文件。请先给出完整清单,下一轮由用户明确要求后再执行。'
  )
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

/**
 * 自动标题的降级实现:不调用模型也能得到可辨识的标题。
 *
 * 真实客户端由模型压缩成短句;离线与模型不可用时必须仍有稳定结果,
 * 否则侧栏会长期停留在"新会话",用户无法区分历史任务。
 */
function fallbackConversationTitle(text: string): string {
  const firstLine = text
    .replace(/@\s*\S+/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  const compact = (firstLine ?? '').replace(/^[#>*\-\d.\s]+/, '').replace(/\s+/g, ' ').trim()
  if (!compact) return '新会话'
  // 标题只保留一个语义单元:中英文句读都截断,再兜底按长度截断。
  const sentence =
    compact
      .split(/[。！？!?；;，,]/)[0]
      ?.replace(/[、和及与并或\s]+$/, '')
      .trim() || compact
  return Array.from(sentence).slice(0, 24).join('').trim()
}

/**
 * 首轮成功后生成会话标题。
 *
 * 与真实客户端的内部模型一致:系统标题 title 与用户标题 custom_title 分离,
 * 这里只写自动标题;用户已手动改名时 setConversationAutoTitle 不会覆盖。
 * 标题生成失败不能影响本轮结果,因此所有异常都只记录到 stderr。
 */
async function maybeAutoTitle(input: {
  conversationId: string
  text: string
  firstTurn: boolean
  signal?: AbortSignal
}): Promise<void> {
  const db = requireDb()
  if (!input.firstTurn) return
  const conversation = getConversation(db, input.conversationId)
  if (!conversation || conversation.customTitle) return

  let title = fallbackConversationTitle(input.text)
  if (!MOCK) {
    try {
      // 标题生成与外层对话使用同一个模型,否则用户切换模型后标题仍由旧模型
      // 产生,在计费与一致性上都会出现难以解释的偏差。
      const titleModel = modelFor(getWorkspaceSettings(db, workspaceId).model)
      const result = await generateText({
        model: titleModel,
        system:
          '你是会话标题生成器。根据用户的第一条请求,输出一个中文短标题。要求:只输出标题本身;不超过 16 个汉字;不要标点、引号、编号或"标题:"前缀;概括任务目标,不要复述客套话。',
        prompt: input.text.slice(0, 2000),
        maxTokens: 32,
        temperature: 0.2,
        ...(input.signal ? { abortSignal: input.signal } : {})
      })
      const generated = result.text
        .replace(/^["'“”‘’#*\s]+|["'“”‘’\s]+$/g, '')
        .split(/\r?\n/)[0]
        ?.replace(/^标题[:：]\s*/, '')
        .trim()
      if (generated) title = Array.from(generated).slice(0, 24).join('')
    } catch (err) {
      process.stderr.write(`[title] 自动标题失败,使用本地摘要: ${(err as Error).message}\n`)
    }
  }

  const updated = setConversationAutoTitle(db, input.conversationId, title)
  if (!updated) return
  emit({
    type: 'conversation.updated',
    conversation: {
      id: updated.id,
      title: conversationDisplayTitle(updated),
      autoTitle: updated.title
    }
  })
}

/**
 * 任务结束通知。
 *
 * 用 taskId + 终态去重:补跑/重试不应在消息中心堆出多张“任务已完成”卡片。
 */
function notifyTaskFinished(input: {
  conversationId: string
  taskId: string
  status: 'done' | 'failed'
  title: string
  message?: string
}): void {
  const db = requireDb()
  try {
    createNotification(db, {
      workspaceId,
      biz: 'task',
      title: input.status === 'done' ? `任务已完成:${input.title}` : `任务执行失败:${input.title}`,
      summary:
        input.status === 'done'
          ? '点开即可查看本轮结果与交付物。'
          : (input.message ?? '任务执行中断,可回到会话重试。').slice(0, 300),
      conversationId: input.conversationId,
      dedupeKey: `task-${input.taskId}-${input.status}`
    })
  } catch (err) {
    process.stderr.write(`[notification] 任务提醒写入失败: ${(err as Error).message}\n`)
  }
}

interface MockRunState {
  /** 已推送给界面的部分回复;取消时用它落盘,不能丢掉用户已经看到的内容 */
  text: string
}

function isRunCancelled(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (err instanceof RunCancelledError) return true
  return err instanceof Error && (err.name === 'AbortError' || /已取消|aborted|cancelled/i.test(err.message))
}

/** mock 逐字输出也要能被中断;真实模型由 abortSignal 负责同样的语义。 */
async function emitMockText(text: string, signal: AbortSignal, state: MockRunState): Promise<void> {
  const delayRaw = Number(process.env.OPENWB_MOCK_DELAY_MS ?? 0)
  const delay = Number.isFinite(delayRaw) && delayRaw > 0 ? delayRaw : 0
  for (const ch of Array.from(text)) {
    if (signal.aborted) throw new RunCancelledError()
    state.text += ch
    emit({ type: 'delta', text: ch })
    if (delay > 0) {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
          settled = true
          signal.removeEventListener('abort', onAbort)
          resolve()
        }, delay)
        const onAbort = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(new RunCancelledError())
        }
        signal.addEventListener('abort', onAbort, { once: true })
        // abort 可能发生在上面的检查之后、监听器挂载之前;补一次检查避免漏掉。
        if (signal.aborted) onAbort()
      })
    } else {
      // 让出事件循环,确保没有延迟时 stdin 的取消帧仍有机会被处理。
      await Promise.resolve()
    }
  }
}

/**
 * 离线 mock 的可取消包装。
 *
 * 任务与 activeRuns 都必须在这里建立:测试和真实运行走的是同一套取消入口,
 * 不能只在真实模型路径上支持停止。
 */
async function runMock(
  input: RunInput,
  prepared: { system: string; modeTools: string[]; assembled: AssembledPrompt }
): Promise<'done' | 'failed' | 'interrupted'> {
  const db = requireDb()
  const colleague = input.colleagueId ? getColleague(db, input.colleagueId) : undefined
  const taskId = createTask(db, {
    conversationId: input.conversationId,
    title: input.text.slice(0, 80) || '未命名任务',
    ...(input.userMessageId ? { userMessageId: input.userMessageId } : {})
  })
  transitionTask(db, taskId, 'running')
  appendEvent(db, input.conversationId, 'run.started', { taskId, mode: input.mode.id })
  emit({ type: 'text.start' })
  emit({ type: 'tools.available', names: effectiveTools(input.mode, colleague ?? null) })

  const controller = new AbortController()
  activeRuns.set(input.conversationId, controller)
  if (pendingCancels.delete(input.conversationId)) controller.abort()
  const state: MockRunState = { text: '' }
  try {
    if (controller.signal.aborted) throw new RunCancelledError()
    return await runMockInner(input, prepared, taskId, controller.signal, state)
  } catch (err) {
    if (isRunCancelled(err, controller.signal)) {
      appendMessage(db, {
        conversationId: input.conversationId,
        role: 'assistant',
        content: { text: state.text },
        status: 'interrupted',
        model: 'mock'
      })
      try {
        transitionTask(db, taskId, 'interrupted')
      } catch {
        // 任务若已落终态则不再改写
      }
      appendEvent(db, input.conversationId, 'run.cancelled', { taskId })
      emit({ type: 'run.cancelled', conversationId: input.conversationId, taskId })
      return 'interrupted'
    }
    const message = (err as Error).message
    appendMessage(db, {
      conversationId: input.conversationId,
      role: 'assistant',
      content: { text: state.text },
      status: 'interrupted',
      model: 'mock'
    })
    try {
      transitionTask(db, taskId, 'failed', { errorCode: 'AGENT_FAILED' })
    } catch {
      // 已处于终态则忽略
    }
    appendEvent(db, input.conversationId, 'run.failed', { taskId, message: message.slice(0, 300) })
    emit({ type: 'error', code: 'AGENT_FAILED', message, retryable: true })
    return 'failed'
  } finally {
    if (activeRuns.get(input.conversationId) === controller) {
      activeRuns.delete(input.conversationId)
    }
  }
}

async function runMockInner(
  input: RunInput,
  prepared: { system: string; modeTools: string[]; assembled: AssembledPrompt },
  taskId: string,
  signal: AbortSignal,
  state: MockRunState
): Promise<'done'> {
  const db = requireDb()
  const colleague = input.colleagueId ? getColleague(db, input.colleagueId) : undefined
  const runConversation = getConversation(db, input.conversationId)
  const runProject = runConversation?.projectId ? getProject(db, runConversation.projectId) : undefined
  const runSkill = skills.activeSkill()?.name
  const callId = 'mock-call-1'
  let reply = ''

  // 所有离线分支共用同一个完成出口:标题必须在 done 之前广播,
  // 侧栏才能在本轮结束时立即显示新标题,而不是等下一次列表刷新。
  const finishMockRun = async (): Promise<'done'> => {
    await maybeAutoTitle({
      conversationId: input.conversationId,
      text: input.text,
      firstTurn: input.firstTurn === true,
      signal
    }).catch((err: Error) => process.stderr.write(`[title] 自动标题失败: ${err.message}\n`))
    // 助手消息在分支里已经落库;把真实 ID 一并交给界面,点赞/点踩才能绑定到
    // 持久化实体,而不是只存在于当前渲染进程的临时消息。
    const last = listMessages(db, input.conversationId).at(-1)
    emit({
      type: 'done',
      conversationId: input.conversationId,
      usage: { input: 0, output: 0 },
      ...(last?.role === 'assistant' ? { messageId: last.id } : {})
    })
    return 'done'
  }

  // 离线验收要覆盖"插件工具调用结果回填":mock 不做真实模型决策,
  // 优先识别文本里显式写出的 <插件>__<工具>;若只写了短名(如"调用 echo"),
  // 则按已就绪插件的原始工具名反查,且只在唯一命中时调用,避免误调同名工具。
  const explicitCall =
    input.mode.id === PLUGIN_TOOL_MODE
      ? /\b([a-z0-9][a-z0-9-]*__[a-z][a-z0-9_]*)\b/.exec(input.text)
      : null
  const tokens = new Set(input.text.toLowerCase().split(/[^a-z0-9_-]+/).filter(Boolean))
  const suffixMatches =
    explicitCall || input.mode.id !== PLUGIN_TOOL_MODE
      ? []
      : pluginRuntime
          .availableTools()
          .filter((tool) => tokens.has(tool.originalName.toLowerCase()))
  const toolName =
    explicitCall?.[1] ?? (suffixMatches.length === 1 ? suffixMatches[0]!.name : undefined)
  if (toolName) {
    emit({ type: 'tool.started', callId, name: toolName })
    try {
      const result = await executeGated(
        toolName,
        { text: 'p5-hello' },
        input.mode,
        input.conversationId,
        { taskId, callId, signal }
      )
      const { ok, summary } = summarizeToolResult(toolName, result)
      emit({ type: 'tool.finished', callId, ok, summary })
      reply = `[mock:${input.mode.id}] 插件工具 ${toolName} 返回: ${summary}`
    } catch (err) {
      if (isRunCancelled(err, signal)) throw err
      emit({ type: 'tool.finished', callId, ok: false, summary: (err as Error).message })
      reply = `[mock:${input.mode.id}] 插件工具 ${toolName} 调用失败: ${(err as Error).message}`
    }
    await emitMockText(reply, signal, state)
    appendMessage(db, {
      conversationId: input.conversationId,
      role: 'assistant',
      content: { text: reply },
      model: 'mock'
    })
    const mockTrace = buildTrace(
      input.mode.id,
      prepared.assembled,
      effectiveTools(input.mode, colleague ?? null),
      runSkill,
      runProject?.id,
      prepared.system,
      injectedSections(input, runProject)
    )
    await writeTrace(TRACE_DIR, mockTrace)
    transitionTask(db, taskId, 'done', { resultRef: mockTrace.outputSha256.slice(0, 16) })
    notifyTaskFinished({ conversationId: input.conversationId, taskId, status: 'done', title: input.text.slice(0, 80) || '未命名任务' })
    appendEvent(db, input.conversationId, 'run.finished', { taskId, steps: 1 })
    await appendRunLog(db, {
      conversationId: input.conversationId,
      text: input.text,
      modeId: input.mode.id,
      toolCalls: 1
    })
    return finishMockRun()
  }

  // 离线验收 shell 参数语义:用真实工具与闸门执行,证明 args 按数组原样传递,
  // 同时验证 rm/del 这类永久删除命令会被直接拒绝而不是弹审批。
  const shellCall = input.mode.id === 'craft'
    ? /shell\s*[:：]\s*(\{[^\n]*\})/.exec(input.text)
    : null
  if (shellCall) {
    let payload: unknown
    try {
      payload = JSON.parse(shellCall[1]!)
    } catch {
      payload = { command: '__bad_json__' }
    }
    emit({ type: 'tool.started', callId, name: 'shell' })
    try {
      const result = await executeGated('shell', payload, input.mode, input.conversationId, {
        taskId,
        callId,
        signal
      })
      const { ok, summary } = summarizeToolResult('shell', result)
      emit({ type: 'tool.finished', callId, ok, summary })
      reply = `[mock:${input.mode.id}] ${summary}`
    } catch (err) {
      if (isRunCancelled(err, signal)) throw err
      emit({ type: 'tool.finished', callId, ok: false, summary: (err as Error).message })
      reply = `[mock:${input.mode.id}] 命令未执行: ${(err as Error).message}`
    }
    await emitMockText(reply, signal, state)
    appendMessage(db, {
      conversationId: input.conversationId,
      role: 'assistant',
      content: { text: reply },
      model: 'mock'
    })
    const mockTrace = buildTrace(
      input.mode.id,
      prepared.assembled,
      modeTools(input.mode),
      runSkill,
      runProject?.id,
      prepared.system,
      injectedSections(input, runProject)
    )
    await writeTrace(TRACE_DIR, mockTrace)
    transitionTask(db, taskId, 'done', { resultRef: mockTrace.outputSha256.slice(0, 16) })
    notifyTaskFinished({ conversationId: input.conversationId, taskId, status: 'done', title: input.text.slice(0, 80) || '未命名任务' })
    appendEvent(db, input.conversationId, 'run.finished', { taskId, steps: 1 })
    await appendRunLog(db, {
      conversationId: input.conversationId,
      text: input.text,
      modeId: input.mode.id,
      toolCalls: 1
    })
    return finishMockRun()
  }

  // 离线验收破坏性链路:文本里显式给出 delete_files / move_files 时,按真实工具与闸门执行。
  const destructiveCall = input.mode.id === 'craft'
    ? /(delete_files|move_files)\s*[:,]?\s*(\[[\s\S]*\])/.exec(input.text)
    : null
  if (destructiveCall) {
    const name = destructiveCall[1] as 'delete_files' | 'move_files'
    let payload: unknown
    try {
      payload = JSON.parse(destructiveCall[2]!)
    } catch {
      payload = []
    }
    const args = name === 'delete_files' ? { paths: payload } : { items: payload }
    emit({ type: 'tool.started', callId, name })
    try {
      const result = await executeGated(name, args, input.mode, input.conversationId, {
        taskId,
        callId,
        signal
      })
      const { ok, summary } = summarizeToolResult(name, result)
      emit({ type: 'tool.finished', callId, ok, summary })
      reply = `[mock:${input.mode.id}] ${summary}`
    } catch (err) {
      if (isRunCancelled(err, signal)) throw err
      emit({ type: 'tool.finished', callId, ok: false, summary: (err as Error).message })
      reply = `[mock:${input.mode.id}] 破坏性操作未执行: ${(err as Error).message}`
    }
    await emitMockText(reply, signal, state)
    appendMessage(db, {
      conversationId: input.conversationId,
      role: 'assistant',
      content: { text: reply },
      model: 'mock'
    })
    const mockTrace = buildTrace(
      input.mode.id,
      prepared.assembled,
      modeTools(input.mode),
      runSkill,
      runProject?.id,
      prepared.system,
      injectedSections(input, runProject)
    )
    await writeTrace(TRACE_DIR, mockTrace)
    transitionTask(db, taskId, 'done', { resultRef: mockTrace.outputSha256.slice(0, 16) })
    notifyTaskFinished({ conversationId: input.conversationId, taskId, status: 'done', title: input.text.slice(0, 80) || '未命名任务' })
    appendEvent(db, input.conversationId, 'run.finished', { taskId, steps: 1 })
    await appendRunLog(db, {
      conversationId: input.conversationId,
      text: input.text,
      modeId: input.mode.id,
      toolCalls: 1
    })
    return finishMockRun()
  }

  // 离线验收交付链路:文本里明确要求"交付/报告"时,先写一个真实文件再走 present_files。
  // 走的是与真实模型完全相同的工具与落库路径,不只是发一个假事件。
  const wantsDelivery = /(交付|呈现|报告|report)/i.test(input.text) && isToolAllowed(input.mode, 'present_files')
  // 反向场景:明确要求"只写不交付",用于验证运行时兜底能抓到漏交付
  const skipDelivery = /(不要交付|不用交付|不交付)/.test(input.text) && isToolAllowed(input.mode, 'write_file')
  if (skipDelivery) {
    const rel = 'out/undelivered.md'
    await executeGated('write_file', { path: rel, content: '# 未交付\n' }, input.mode, input.conversationId, {
      taskId,
      callId,
      signal
    })
    reply = `[mock:${input.mode.id}] 已写入 ${rel},但没有交付。`
    await emitMockText(reply, signal, state)
    appendMessage(db, {
      conversationId: input.conversationId,
      role: 'assistant',
      content: { text: reply },
      model: 'mock'
    })
    const mockTrace = buildTrace(
      input.mode.id,
      prepared.assembled,
      modeTools(input.mode),
      runSkill,
      runProject?.id,
      prepared.system,
      injectedSections(input, runProject)
    )
    await writeTrace(TRACE_DIR, mockTrace)
    const missing = checkDelivery(taskId, input.conversationId, true)
    transitionTask(db, taskId, 'done', {
      resultRef: mockTrace.outputSha256.slice(0, 16),
      ...(missing ? { errorCode: 'DELIVERY_MISSING' } : {})
    })
    notifyTaskFinished({ conversationId: input.conversationId, taskId, status: 'done', title: input.text.slice(0, 80) || '未命名任务' })
    appendEvent(db, input.conversationId, 'run.finished', { taskId, steps: 1 })
    await appendRunLog(db, {
      conversationId: input.conversationId,
      text: input.text,
      modeId: input.mode.id,
      toolCalls: 1
    })
    return finishMockRun()
  }
  if (wantsDelivery) {
    const rel = 'out/mock-report.md'
    const body = `# Mock 报告\n\n请求: ${input.text}\n`
    try {
      await executeGated('write_file', { path: rel, content: body }, input.mode, input.conversationId, {
        taskId,
        callId,
        signal
      })
      emit({ type: 'tool.started', callId, name: 'present_files' })
      const result = await executeGated(
        'present_files',
        { items: [{ path: rel, title: 'Mock 报告', kind: 'file' }] },
        input.mode,
        input.conversationId,
        { taskId, callId, signal }
      )
      emit({ type: 'tool.finished', callId, ok: true, summary: `已交付 ${(result as { presented: number }).presented} 个文件` })
      reply = `[mock:${input.mode.id}] 已生成并交付报告:${rel}`
    } catch (err) {
      if (isRunCancelled(err, signal)) throw err
      emit({ type: 'tool.finished', callId, ok: false, summary: (err as Error).message })
      reply = `[mock:${input.mode.id}] 交付失败:${(err as Error).message}`
    }
    await emitMockText(reply, signal, state)
    appendMessage(db, {
      conversationId: input.conversationId,
      role: 'assistant',
      content: { text: reply },
      model: 'mock'
    })
    const mockTrace = buildTrace(
      input.mode.id,
      prepared.assembled,
      modeTools(input.mode),
      runSkill,
      runProject?.id,
      prepared.system,
      injectedSections(input, runProject)
    )
    await writeTrace(TRACE_DIR, mockTrace)
    transitionTask(db, taskId, 'done', { resultRef: mockTrace.outputSha256.slice(0, 16) })
    notifyTaskFinished({ conversationId: input.conversationId, taskId, status: 'done', title: input.text.slice(0, 80) || '未命名任务' })
    appendEvent(db, input.conversationId, 'run.finished', { taskId, steps: 1 })
    await appendRunLog(db, {
      conversationId: input.conversationId,
      text: input.text,
      modeId: input.mode.id,
      toolCalls: 1
    })
    return finishMockRun()
  }

  const canRead = isToolAllowed(input.mode, 'read_file')
  if (canRead) {
    emit({ type: 'tool.started', callId, name: 'read_file' })
    try {
      const content = (await executeGated(
        'read_file',
        { path: 'package.json' },
        input.mode,
        input.conversationId,
        { taskId, callId, signal }
      )) as string
      emit({ type: 'tool.finished', callId, ok: true, summary: `${content.length} 字节` })
      reply = `[mock:${input.mode.id}] 已读取 package.json(${content.length} 字节)。问题: ${input.text}`
    } catch (err) {
      if (isRunCancelled(err, signal)) throw err
      // 离线验收常在空目录里跑,mock 不能因为缺 package.json 就整轮失败
      emit({ type: 'tool.finished', callId, ok: false, summary: (err as Error).message })
      reply = `[mock:${input.mode.id}] 工具调用失败(${(err as Error).message})。问题: ${input.text}`
    }
  } else {
    reply = `[mock:${input.mode.id}] 当前模式无工具权限,未读取任何文件。问题: ${input.text}`
  }
  await emitMockText(reply, signal, state)
  appendMessage(db, {
    conversationId: input.conversationId,
    role: 'assistant',
    content: { text: reply },
    model: 'mock'
  })
  // mock 也要产出 trace:P2 的"提示词稳定性"验收靠它比对 sha256
  const trace = buildTrace(
    input.mode.id,
    prepared.assembled,
    effectiveTools(input.mode, colleague ?? null),
    runSkill,
    runProject?.id,
    prepared.system,
    injectedSections(input, runProject)
  )
  const file = await writeTrace(TRACE_DIR, trace)
  process.stderr.write(
    `[trace] ${input.mode.id} sha256=${trace.outputSha256.slice(0, 12)} tools=[${effectiveTools(input.mode, colleague ?? null).join(',')}] skill=- -> ${file}\n`
  )

  transitionTask(db, taskId, 'done', { resultRef: trace.outputSha256.slice(0, 16) })
  notifyTaskFinished({ conversationId: input.conversationId, taskId, status: 'done', title: input.text.slice(0, 80) || '未命名任务' })
  appendEvent(db, input.conversationId, 'run.finished', { taskId, steps: canRead ? 1 : 0 })
  await appendRunLog(db, { conversationId: input.conversationId, text: input.text, modeId: input.mode.id, toolCalls: canRead ? 1 : 0 })
  return finishMockRun()
}

/**
 * 每轮开始时记录基线,结束时记录结果。
 *
 * 快照失败不能阻断对话:检查点只是"可回退"的增强能力,主流程仍应可用。
 * 失败原因写入 stderr,恢复时会明确告诉用户没有文件检查点,而不是假装成功。
 */
async function runAgent(input: RunInput): Promise<'done' | 'failed' | 'interrupted'> {
  let checkpointId: string | null = null
  try {
    if (checkpointStore && input.userMessageId) {
      const row = getMessage(requireDb(), input.userMessageId)
      if (row) {
        const started = await checkpointStore.begin({
          conversationId: input.conversationId,
          userMessageId: input.userMessageId,
          messageSeq: row.seq
        })
        checkpointId = started.id
      }
    }
  } catch (err) {
    process.stderr.write(`[checkpoint] 基线快照失败: ${(err as Error).message}\n`)
  }
  try {
    return await runAgentInner(input)
  } finally {
    if (checkpointId) {
      await checkpointStore?.finish(checkpointId).catch((err: Error) => {
        process.stderr.write(`[checkpoint] 结果快照失败: ${err.message}\n`)
      })
    }
  }
}

/**
 * 构造本轮之前的对话上下文。
 *
 * 预算内的历史原样进入;超出预算时,把最早若干"完整问答轮"压成摘要,
 * 并保留最近原文。摘要持久化后下一轮可以直接复用,不必重复压缩同一段历史。
 * 摘要失败只降级、不中断主任务:本地兜底至少保留用户更早的提问线索。
 */
async function prepareModelHistory(input: {
  db: AppDatabase
  conversationId: string
  currentUserMessageId?: string
  signal: AbortSignal
}): Promise<{
  messages: HistoryMessage[]
  systemSuffix: string
  notice: string | null
  inputTokens: number
  outputTokens: number
}> {
  const records = listMessages(input.db, input.conversationId).filter(
    (record) => record.id !== input.currentUserMessageId
  )
  const history = toHistoryMessages(records)
  const saved = getConversationSummary(input.db, input.conversationId)
  let summary = saved?.summary ?? null
  let coveredSeq = saved?.coveredSeq ?? 0
  let coveredMessages = saved?.coveredMessages ?? 0
  let sourceChars = saved?.sourceChars ?? 0
  let inputTokens = 0
  let outputTokens = 0

  // 已经被旧摘要覆盖的消息不再重复送给模型,否则压缩等于白做。
  const candidates = history.filter((item) => (item.seq ?? 0) > coveredSeq)
  const plan = planCompression(candidates, {
    budget: HISTORY_LIMITS.maxChars,
    maxMessages: HISTORY_LIMITS.maxMessages,
    minKeep: HISTORY_MIN_KEEP
  })

  if (plan.compress.length > 0) {
    const prompt = buildSummaryPrompt({
      messages: plan.compress,
      previous: summary,
      previousCoveredSeq: coveredSeq > 0 ? coveredSeq : null
    })
    let fallback = false
    let nextSummary = ''
    try {
      const summaryModel = modelFor(getWorkspaceSettings(input.db, workspaceId).model)
      const result = await generateText({
        model: summaryModel,
        system: prompt.system,
        prompt: prompt.prompt,
        maxTokens: 800,
        temperature: 0.1,
        abortSignal: input.signal
      })
      nextSummary = result.text.trim()
      const inTokens = Number(result.usage?.promptTokens)
      const outTokens = Number(result.usage?.completionTokens)
      if (Number.isFinite(inTokens)) inputTokens += inTokens
      if (Number.isFinite(outTokens)) outputTokens += outTokens
      if (!nextSummary) throw new Error('模型返回空摘要')
    } catch (err) {
      if (isRunCancelled(err, input.signal)) throw new RunCancelledError()
      fallback = true
      nextSummary = fallbackSummary(plan.compress, summary)
      process.stderr.write(`[summary] 上下文压缩失败,使用本地兜底: ${(err as Error).message}\n`)
    }

    const lastSeq = plan.compress.at(-1)?.seq ?? coveredSeq
    const newChars = plan.compress.reduce((sum, item) => sum + item.content.length, 0)
    const persisted = upsertConversationSummary(input.db, {
      conversationId: input.conversationId,
      coveredSeq: lastSeq,
      coveredMessages: coveredMessages + plan.compress.length,
      summary: nextSummary,
      sourceChars: sourceChars + newChars
    })
    summary = persisted.summary
    coveredSeq = persisted.coveredSeq
    coveredMessages = persisted.coveredMessages
    sourceChars = persisted.sourceChars
    emit({
      type: 'context.summary',
      coveredMessages,
      coveredSeq,
      beforeChars: newChars + plan.keep.reduce((sum, item) => sum + item.content.length, 0),
      afterChars: nextSummary.length + plan.keep.reduce((sum, item) => sum + item.content.length, 0),
      fallback
    })
  }

  // 摘要之后仍可能超预算(例如单条消息本身过长),继续用尾部裁剪兜底,
  // 并明确告诉模型有内容被省略,而不是让它把"没看到"当成"没发生"。
  const kept = trimHistoryMessages(plan.keep, HISTORY_LIMITS)
  const dropped = plan.keep.length - kept.length
  const notice = dropped > 0 ? historyNotice(dropped) : null
  return {
    messages: kept,
    systemSuffix: summary
      ? summaryContextText({ summary, coveredMessages, coveredSeq })
      : '',
    notice,
    inputTokens,
    outputTokens
  }
}

async function runAgentInner(input: RunInput): Promise<'done' | 'failed' | 'interrupted'> {
  const db = requireDb()
  const { text, mode, conversationId } = input

  const conversationRow = getConversation(db, conversationId)
  const project = conversationRow?.projectId ? getProject(db, conversationRow.projectId) : undefined

  markScanTurn(conversationId, text)

  // 每一轮都从干净状态开始:上一轮模型自加载的技能不能悄悄影响新任务。
  skills.reset()
  const colleague = input.colleagueId ? getColleague(db, input.colleagueId) : undefined
  if (input.colleagueId && (!colleague || colleague.workspaceId !== workspaceId)) {
    emit({ type: 'error', code: 'COLLEAGUE_NOT_FOUND', message: '助理不存在或不属于当前工作区', retryable: false })
    return 'failed'
  }
  if (colleague?.status === 'paused') {
    emit({ type: 'error', code: 'COLLEAGUE_PAUSED', message: `助理「${colleague.name}」已暂停,恢复后才能继续执行任务`, retryable: false })
    return 'failed'
  }
  // 项目与助理都可能是技能白名单。两者同时存在时取交集:
  // 项目约束"这个项目能用什么",助理约束"这个角色能用什么",不能互相放宽。
  const colleagueSkills = colleague && colleague.skillNames.length > 0 ? colleague.skillNames : null
  const projectSkills = project && project.skillNames.length > 0 ? project.skillNames : null
  const allowedSkills =
    colleagueSkills && projectSkills
      ? colleagueSkills.filter((name) => projectSkills.includes(name))
      : (colleagueSkills ?? projectSkills)
  skills.setAllowed(allowedSkills)

  emit({ type: 'mode.selected', modeId: mode.id, displayName: mode.displayName })

  const injected = colleague?.memoryEnabled === false
    ? { text: '', blocks: [], truncatedTotal: 0 }
    : await buildInjection({
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
    return 'failed'
  }

  let explicitSkill: string | undefined
  try {
    const requested = input.skill?.trim()
    if (requested) {
      const loaded = await skills.load(requested)
      explicitSkill = loaded.name
      prepared.system += `\n\n# 用户指定技能\n${loaded.body}`
    }
    prepared.system = await applyHarnessContext(input, prepared, project ?? null)
  } catch (err) {
    emit({ type: 'error', code: 'CONTEXT_FAILED', message: (err as Error).message, retryable: false })
    return 'failed'
  }

  if (explicitSkill) {
    const active = skills.activeSkill()
    emit({
      type: 'skill.activated',
      name: explicitSkill,
      allowedTools: active?.allowedTools ?? null
    })
  }

  if (MOCK) {
    return await runMock(input, prepared)
  }

  const taskId = createTask(db, {
    conversationId,
    title: text.slice(0, 80) || '未命名任务',
    ...(input.userMessageId ? { userMessageId: input.userMessageId } : {})
  })
  transitionTask(db, taskId, 'running')
  appendEvent(db, conversationId, 'run.started', { taskId, mode: mode.id })

  // 模型在一轮开始时确定:中途改设置不能改变已经发出的请求,
  // 否则同一条回复可能前半段来自 A、后半段来自 B,日志也无法解释。
  const workspaceSettings = getWorkspaceSettings(db, workspaceId)
  const selectedModel = resolveModelName(workspaceSettings.model)
  const configuredFallback = workspaceSettings.fallbackModel?.trim() ?? ''
  const fallbackModel = configuredFallback ? resolveModelName(configuredFallback) : null
  // 备用模型与主模型相同等于没有备用,不占用一次模型轮次。
  const effectiveFallback = fallbackModel && fallbackModel !== selectedModel ? fallbackModel : null
  let usedModel = selectedModel
  let activeModel = modelFor(usedModel)
  let fallbackUsed = false

  // 从这里开始才是可取消的模型运行。准备阶段(记忆、提示词)很快,
  // 提前注册反而会让"停止"落在还没开始的请求上。
  const controller = new AbortController()
  activeRuns.set(conversationId, controller)
  if (pendingCancels.delete(conversationId)) controller.abort()
  const signal = controller.signal

  let reply = ''
  let totalInput = 0
  let totalOutput = 0
  let activeSkill: string | undefined = explicitSkill
  let toolCalls = 0
  const wroteFiles = { value: false }
  let delivered = 0

  try {
    if (signal.aborted) throw new RunCancelledError()
    emit({ type: 'text.start' })
    const initialTools = effectiveTools(mode, colleague ?? null)
    emit({ type: 'tools.available', names: initialTools })

    // 同一个会话要带上之前的问答,否则"继续/再改一下"这类追问完全失效。
    // 超出预算的更早轮次压成摘要,最近的原文仍完整保留。
    const historyResult = await prepareModelHistory({
      db,
      conversationId,
      ...(input.userMessageId ? { currentUserMessageId: input.userMessageId } : {}),
      signal
    })
    totalInput += historyResult.inputTokens
    totalOutput += historyResult.outputTokens
    const messages: CoreMessage[] = [
      ...(historyResult.messages as CoreMessage[]),
      { role: 'user', content: text }
    ]
    const notice = historyResult.notice
    if (notice) {
      emit({ type: 'context.notice', text: notice })
      prepared.system += `\n\n# 上下文提示\n${notice}`
    }
    if (historyResult.systemSuffix) prepared.system += `\n\n${historyResult.systemSuffix}`
    let lastNames = initialTools

    for (let step = 0; step < MAX_STEPS; step++) {
      const names = effectiveTools(mode, colleague ?? null)
      const tools = buildTools(mode, names, { taskId, conversationId, wroteFiles, signal })

      if (JSON.stringify(names) !== JSON.stringify(lastNames)) {
        emit({ type: 'tools.available', names })
        lastNames = names
      }

      // 一个"步"可能因为网关抖动失败。只要这一步还没吐出任何文本、也没有发起
      // 工具调用,就整体重来是安全的;一旦有可见输出就必须停下,否则会重复回答,
      // 更糟的是把已经执行过的写文件/删文件工具再跑一遍。
      let stepUsage: { promptTokens?: number; completionTokens?: number } | null = null
      let stepResponseMessages: CoreMessage[] | null = null
      let stepToolResultCount = 0
      let lastFailure: unknown = null
      // 主模型先按原有预算重试;只有重试耗尽且本步尚未产生任何输出时,
      // 才允许切换到备用模型。切换后本轮后续步骤继续使用备用模型,
      // 避免同一条回复在两个模型之间来回跳。
      const modelRounds = fallbackUsed ? 1 : effectiveFallback ? 2 : 1
      stepRequest: for (let round = 0; round < modelRounds; round++) {
        if (round === 1) {
          usedModel = effectiveFallback!
          activeModel = modelFor(usedModel)
        }
        for (let attempt = 0; attempt < STREAM_MAX_ATTEMPTS; attempt++) {
          let producedOutput = false
          try {
            const attemptResult = streamText({
              model: activeModel,
              system: prepared.system,
              messages,
              tools,
              maxSteps: 1,
              // 重试由本层统一负责:SDK 内建的静默重试不会发事件,
              // 用户只会看到界面卡住,而且两层重试会成倍放大请求次数。
              maxRetries: 0,
              abortSignal: signal
            })

            for await (const part of attemptResult.fullStream) {
              if (signal.aborted) throw new RunCancelledError()
              if (part.type === 'text-delta') {
                producedOutput = true
                reply += part.textDelta
                emit({ type: 'delta', text: part.textDelta })
              } else if (part.type === 'tool-call') {
                producedOutput = true
                toolCalls++
                emit({ type: 'tool.started', callId: part.toolCallId, name: part.toolName })
              } else if (part.type === 'tool-result') {
                const { ok, summary } = summarizeToolResult(part.toolName, part.result)
                emit({ type: 'tool.finished', callId: part.toolCallId, ok, summary })
                if (part.toolName === 'present_files' && ok) delivered++
              } else if (part.type === 'error') {
                throw part.error instanceof Error ? part.error : new Error(String(part.error))
              }
            }

            // usage/response/toolResults 也要在重试保护内读取:部分网关在流结束
            // 之后才暴露错误,提前跳出重试会让这些失败直接落到用户头上。
            stepUsage = (await attemptResult.usage) ?? null
            const response = await attemptResult.response
            stepResponseMessages = response.messages as CoreMessage[]
            stepToolResultCount = (await attemptResult.toolResults).length
            if (attempt > 0) emit({ type: 'retry.recovered', attempt, model: usedModel })
            if (round === 1) emit({ type: 'model.fallback.recovered', from: selectedModel, to: usedModel })
            break stepRequest
          } catch (err) {
            if (isRunCancelled(err, signal)) throw new RunCancelledError()
            lastFailure = err
            const decision = decideStreamRetry({
              attempt,
              producedOutput,
              aborted: signal.aborted,
              error: err,
              maxAttempts: STREAM_MAX_ATTEMPTS
            })
            if (!decision.retry) {
              // 有可见输出或工具调用时切换模型会重复回答/重复副作用,必须直接失败。
              if (!isRetryableStreamError(err) || producedOutput) throw err
              const fallbackDecision = decideModelFallback({
                attempt,
                maxAttempts: STREAM_MAX_ATTEMPTS,
                producedOutput,
                aborted: signal.aborted,
                error: err,
                primaryModel: usedModel,
                fallbackModel: effectiveFallback,
                alreadyFallenBack: fallbackUsed
              })
              if (!fallbackDecision.fallback) throw err
              usedModel = effectiveFallback!
              activeModel = modelFor(usedModel)
              fallbackUsed = true
              emit({
                type: 'model.fallback',
                from: selectedModel,
                to: usedModel,
                reason: fallbackDecision.reason
              })
              process.stderr.write(
                `[fallback] ${selectedModel} 重试耗尽,切换到备用模型 ${usedModel}: ${fallbackDecision.reason}\n`
              )
              // 退出主模型的重试循环,由下一轮使用备用模型重新执行本步。
              break
            }
            const delayMs = retryDelayMs(attempt, STREAM_RETRY_BASE_MS)
            emit({
              type: 'retry.scheduled',
              attempt: attempt + 1,
              delayMs,
              reason: decision.reason
            })
            process.stderr.write(
              `[retry] 第 ${attempt + 1} 次失败,${delayMs}ms 后重试: ${decision.reason}\n`
            )
            try {
              await sleepWithAbort(delayMs, signal)
            } catch {
              throw new RunCancelledError()
            }
          }
        }
      }

      if (!stepResponseMessages) {
        throw lastFailure instanceof Error ? lastFailure : new Error('模型请求重试后仍未取得响应')
      }
      if (signal.aborted) throw new RunCancelledError()

      // 部分网关(含中转)在流式结束时不回 usage,或回 null/NaN。
      // NaN 会被 better-sqlite3 绑成 NULL,直接撞 token_in 的 NOT NULL 约束。
      const inTokens = Number(stepUsage?.promptTokens)
      const outTokens = Number(stepUsage?.completionTokens)
      if (Number.isFinite(inTokens)) totalInput += inTokens
      if (Number.isFinite(outTokens)) totalOutput += outTokens

      messages.push(...stepResponseMessages)

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

      if (stepToolResultCount === 0) break
    }

    if (signal.aborted) throw new RunCancelledError()

    // 步数用尽时模型往往还在试下一步工具,此时 reply 为空,用户只看到一排失败的
    // 工具行,像"报错"。强制补一轮不带工具的收尾,把已有观测变成可读结论。
    if (!reply.trim()) {
      try {
        const wrapUp = streamText({
          model: activeModel,
          system: `${prepared.system}\n\n# 收尾\n工具调用预算已用尽。不要再调用工具,直接基于目前已知的信息回答用户;拿不到的信息要明确说明没查到。`,
          messages: [
            ...messages,
            {
              role: 'user',
              content: '请立刻给出最终回答:已经查到什么、结论是什么、哪些没查到。不要再调用任何工具。'
            }
          ],
          abortSignal: signal
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
        if (isRunCancelled(err, signal)) throw err
        process.stderr.write(`[wrapup] 收尾失败: ${(err as Error).message}\n`)
        if (!reply.trim()) {
          reply = '本轮工具调用没有取得结果,已达到步数上限。请把问题拆小一些重试,或换用 ask 模式查看具体文件。'
          emit({ type: 'delta', text: reply })
        }
      }
    }

    if (signal.aborted) throw new RunCancelledError()

    const finalNames = effectiveTools(mode, colleague ?? null)
    const trace = buildTrace(
      mode.id,
      prepared.assembled,
      finalNames,
      activeSkill,
      project?.id,
      prepared.system,
      injectedSections(input, project),
      usedModel
    )
    const file = await writeTrace(TRACE_DIR, trace)
    process.stderr.write(
      `[trace] ${mode.id} sha256=${trace.outputSha256.slice(0, 12)} tools=[${finalNames.join(',')}] skill=${activeSkill ?? '-'} -> ${file}\n`
    )

    const assistantSaved = appendMessage(db, {
      conversationId,
      role: 'assistant',
      content: { text: reply },
      ...(activeSkill ? { model: `${usedModel}#${activeSkill}` } : { model: usedModel }),
      tokenIn: totalInput,
      tokenOut: totalOutput
    })
    // 先判定交付缺失,再一次性把任务标成 done:状态机不允许 done 之后再补写
    const missing = checkDelivery(taskId, conversationId, wroteFiles.value)
    transitionTask(db, taskId, 'done', {
      resultRef: trace.outputSha256.slice(0, 16),
      ...(missing ? { errorCode: 'DELIVERY_MISSING' } : {})
    })
    notifyTaskFinished({ conversationId, taskId, status: 'done', title: text.slice(0, 80) || '未命名任务' })
    appendEvent(db, conversationId, 'run.finished', { taskId, steps: toolCalls })

    await appendRunLog(db, { conversationId, text, modeId: mode.id, toolCalls })

    await maybeAutoTitle({
      conversationId,
      text,
      firstTurn: input.firstTurn === true,
      signal
    }).catch((err: Error) => process.stderr.write(`[title] 自动标题失败: ${err.message}\n`))

    emit({
      type: 'done',
      conversationId,
      messageId: assistantSaved.record.id,
      usage: {
        ...(totalInput > 0 ? { input: totalInput } : {}),
        ...(totalOutput > 0 ? { output: totalOutput } : {})
      },
      ...(activeSkill ? { skill: activeSkill } : {})
    })
    return 'done'
  } catch (err) {
    const message = (err as Error).message
    if (isRunCancelled(err, signal)) {
      // 保留已经推送给用户的部分输出:停止不等于撤回答复。
      appendMessage(db, {
        conversationId,
        role: 'assistant',
        content: { text: reply },
        status: 'interrupted',
        ...(activeSkill ? { model: `${usedModel}#${activeSkill}` } : { model: usedModel }),
        tokenIn: totalInput,
        tokenOut: totalOutput
      })
      try {
        transitionTask(db, taskId, 'interrupted')
      } catch {
        // 若已处于终态则忽略
      }
      appendEvent(db, conversationId, 'run.cancelled', { taskId })
      emit({ type: 'run.cancelled', conversationId, taskId })
      return 'interrupted'
    }
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
    notifyTaskFinished({
      conversationId,
      taskId,
      status: 'failed',
      title: text.slice(0, 80) || '未命名任务',
      message
    })
    appendEvent(db, conversationId, 'run.failed', { taskId, message: message.slice(0, 300) })
    emit({ type: 'error', code: 'AGENT_FAILED', message, retryable: true })
    return 'failed'
  } finally {
    if (activeRuns.get(conversationId) === controller) activeRuns.delete(conversationId)
  }
}

/** 串行处理,避免两个请求同时写库与写 stdout 帧 */
let queue: Promise<void> = Promise.resolve()
/**
 * 串行处理,避免两个请求同时写库与写 stdout 帧。
 *
 * 出错时必须带上 requestId:主进程按 requestId 匹配应答,不带就永远等不到,
 * 调用方只能等到 10s 超时,拿到的是"请求超时"而不是真实原因。
 */
function enqueue(job: () => Promise<void>, requestId?: unknown): void {
  queue = queue.then(job).catch((err) => {
    emit({
      ...(requestId !== undefined ? { requestId } : {}),
      type: 'error',
      code: 'HANDLER_FAILED',
      message: (err as Error).message,
      retryable: false
    })
  })
}

function resolveConversationId(requested: unknown): string {
  if (typeof requested === 'string' && requested.length > 0) {
    conversationOrThrow(requested)
    return requested
  }
  return activeConversationId
}

function syncConfig() {
  if (!SYNC_URL) return null
  try {
    return { baseUrl: normalizeSyncUrl(SYNC_URL), ...(SYNC_TOKEN ? { token: SYNC_TOKEN } : {}) }
  } catch (err) {
    process.stderr.write(`[sync] 同步配置无效: ${(err as Error).message}\n`)
    return null
  }
}

function pendingStats() {
  const items = listPending(requireDb(), workspaceId)
  const unsent = items.filter((i) => !i.sentAt)
  return {
    configured: Boolean(syncConfig()),
    endpoint: SYNC_URL ? safeEndpoint(SYNC_URL) : null,
    pending: unsent.length,
    sent: items.length - unsent.length,
    failed: unsent.filter((i) => i.attempts > 0).length,
    oldest: unsent[0]?.createdAt ?? null,
    lastError: [...unsent].reverse().find((i) => i.lastError)?.lastError ?? null
  }
}

/** 状态里只暴露协议与主机,不把 token 所在 URL 原样回显到界面 */
function safeEndpoint(raw: string): string {
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}`
  } catch {
    return '(invalid)'
  }
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

  if (msg.cmd === 'settings.get') {
    const current = getWorkspaceSettings(db, workspaceId)
    emit({
      ...base,
      type: 'settings.get',
      settings: current,
      workspace: WORKSPACE,
      model: resolveModelName(current.model),
      openSkillsDir: userSkillsRoot()
    })
    return true
  }

  if (msg.cmd === 'models.list') {
    // 候选来自网关本身;失败时界面仍需能打开自定义输入,所以不抛错。
    const result = await listRemoteModels()
    emit({
      ...base,
      type: 'models.list',
      models: result.models,
      remote: result.remote,
      current: resolveModelName(getWorkspaceSettings(db, workspaceId).model),
      ...(result.error ? { error: result.error } : {})
    })
    return true
  }

  if (msg.cmd === 'settings.set') {
    const key = msg.key
    if (key !== 'permissionMode' && key !== 'taskTarget' && key !== 'model' && key !== 'fallbackModel') {
      throw new Error('未知设置项')
    }
    if (key === 'permissionMode' && msg.value !== 'default' && msg.value !== 'fullAccess' && msg.value !== 'readOnly') {
      throw new Error('permissionMode 必须是 default / fullAccess / readOnly')
    }
    if ((key === 'model' || key === 'fallbackModel') && msg.value !== null && typeof msg.value !== 'string') {
      throw new Error(`${key} 必须是字符串或 null`)
    }
    if ((key === 'model' || key === 'fallbackModel') && typeof msg.value === 'string' && msg.value.includes('\n')) {
      throw new Error(`${key} 不能包含换行`)
    }
    const value = msg.value === null ? null : typeof msg.value === 'string' ? msg.value : String(msg.value)
    const settings = setWorkspaceSetting(db, workspaceId, key as SettingKey, value)
    emit({
      ...base,
      type: 'settings.updated',
      settings,
      ...(key === 'model' ? { model: resolveModelName(settings.model) } : {}),
      ...(key === 'fallbackModel'
        ? { fallbackModel: settings.fallbackModel ? resolveModelName(settings.fallbackModel) : null }
        : {})
    })
    return true
  }

  if (msg.cmd === 'library.list') {
    emit({
      ...base,
      type: 'library.list',
      items: listLibraryArtifacts(db, {
        ...(typeof msg.limit === 'number' ? { limit: msg.limit } : {})
      })
    })
    return true
  }

  if (msg.cmd === 'colleagues.list') {
    emit({ ...base, type: 'colleagues.list', colleagues: listColleagues(db, workspaceId) })
    return true
  }

  if (msg.cmd === 'colleagues.create') {
    if (typeof msg.name !== 'string' || !msg.name.trim()) throw new Error('缺少助理名称')
    const colleague = createColleague(db, {
      workspaceId,
      name: msg.name,
      ...(typeof msg.title === 'string' ? { title: msg.title } : {}),
      ...(typeof msg.description === 'string' ? { description: msg.description } : {}),
      ...(typeof msg.instructions === 'string' ? { instructions: msg.instructions } : {}),
      ...(typeof msg.avatar === 'string' ? { avatar: msg.avatar } : {}),
      ...(Array.isArray(msg.skillNames) ? { skillNames: msg.skillNames.filter((x): x is string => typeof x === 'string') } : {}),
      ...(Array.isArray(msg.connectorNames)
        ? { connectorNames: msg.connectorNames.filter((x): x is string => typeof x === 'string') }
        : {}),
      ...(Array.isArray(msg.channelIds)
        ? { channelIds: msg.channelIds.filter((x): x is string => typeof x === 'string') }
        : {}),
      ...(msg.status === 'active' || msg.status === 'paused' ? { status: msg.status } : {}),
      ...(msg.visibility === 'personal' || msg.visibility === 'project' || msg.visibility === 'public'
        ? { visibility: msg.visibility }
        : {}),
      ...(typeof msg.memoryEnabled === 'boolean' ? { memoryEnabled: msg.memoryEnabled } : {}),
      ...(typeof msg.pinned === 'boolean' ? { pinned: msg.pinned } : {}),
      ...(typeof msg.modeId === 'string' ? { modeId: msg.modeId } : {})
    } satisfies ColleagueInput)
    emit({ ...base, type: 'colleagues.created', colleague })
    return true
  }

  if (msg.cmd === 'colleagues.update') {
    if (typeof msg.id !== 'string' || !msg.id) throw new Error('缺少助理 ID')
    const colleague = updateColleague(db, msg.id, {
      ...(typeof msg.name === 'string' ? { name: msg.name } : {}),
      ...(typeof msg.title === 'string' ? { title: msg.title } : {}),
      ...(typeof msg.description === 'string' ? { description: msg.description } : {}),
      ...(typeof msg.instructions === 'string' ? { instructions: msg.instructions } : {}),
      ...(typeof msg.avatar === 'string' ? { avatar: msg.avatar } : {}),
      ...(Array.isArray(msg.skillNames) ? { skillNames: msg.skillNames.filter((x): x is string => typeof x === 'string') } : {}),
      ...(Array.isArray(msg.connectorNames)
        ? { connectorNames: msg.connectorNames.filter((x): x is string => typeof x === 'string') }
        : {}),
      ...(Array.isArray(msg.channelIds)
        ? { channelIds: msg.channelIds.filter((x): x is string => typeof x === 'string') }
        : {}),
      ...(msg.status === 'active' || msg.status === 'paused' ? { status: msg.status } : {}),
      ...(msg.visibility === 'personal' || msg.visibility === 'project' || msg.visibility === 'public'
        ? { visibility: msg.visibility }
        : {}),
      ...(typeof msg.memoryEnabled === 'boolean' ? { memoryEnabled: msg.memoryEnabled } : {}),
      ...(typeof msg.pinned === 'boolean' ? { pinned: msg.pinned } : {}),
      ...(typeof msg.modeId === 'string' ? { modeId: msg.modeId } : {})
    })
    if (!colleague) throw new Error('助理不存在')
    emit({ ...base, type: 'colleagues.updated', colleague })
    return true
  }

  if (msg.cmd === 'colleagues.delete') {
    if (typeof msg.id !== 'string' || !msg.id) throw new Error('缺少助理 ID')
    const removed = deleteColleague(db, msg.id)
    emit({ ...base, type: 'colleagues.deleted', id: msg.id, removed })
    return true
  }

  if (msg.cmd === 'colleagues.tasks') {
    if (typeof msg.id !== 'string' || !msg.id) throw new Error('缺少助理 ID')
    // 任务列表来自真实会话与 task 行:运行中优先,其次有失败/待执行的会话算进行中,
    // 其余按最后活动时间判定为已完成或空闲。渲染层不再猜测执行状态。
    const tasks = listConversationSummaries(db, workspaceId)
      .filter((c) => c.colleagueId === msg.id)
      .map((c) => {
        const source: 'personal' | 'channel' | 'project' = c.projectId
          ? 'project'
          : c.channelId
            ? 'channel'
            : 'personal'
        const status: 'inProgress' | 'idle' | 'completed' | 'failed' =
          c.running > 0 || c.pending > 0
            ? 'inProgress'
            : c.failed > 0
              ? 'failed'
              : c.taskTotal > 0 && c.done === c.taskTotal
                ? 'completed'
                : 'idle'
        return {
          id: c.id,
          title: conversationDisplayTitle(c),
          source,
          status,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt
        }
      })
    emit({ ...base, type: 'colleagues.tasks', colleagueId: msg.id, tasks })
    return true
  }

  if (msg.cmd === 'approval.ready') {
    // UI 明确声明"我能收审批":在此之前任何风险调用都必须拒绝,而不是默默排队。
    approvalBridge.markReady()
    emit({ ...base, type: 'approval.ready', pending: approvalBridge.list() })
    return true
  }

  if (msg.cmd === 'approval.list') {
    emit({ ...base, type: 'approval.list', requests: approvalBridge.list() })
    return true
  }

  if (msg.cmd === 'notifications.list') {
    const pendingOnly = msg.pendingOnly === true
    emit({
      ...base,
      type: 'notifications.list',
      notifications: listNotifications(db, workspaceId, {
        pendingOnly,
        ...(typeof msg.limit === 'number' ? { limit: msg.limit } : {})
      }),
      unread: unreadNotificationCount(db, workspaceId)
    })
    return true
  }

  if (msg.cmd === 'notifications.read') {
    if (typeof msg.id !== 'string' || !msg.id) throw new Error('缺少通知 ID')
    const notification = markNotificationRead(db, msg.id)
    if (!notification) throw new Error('通知不存在')
    emit({ ...base, type: 'notifications.read', notification, unread: unreadNotificationCount(db, workspaceId) })
    return true
  }

  if (msg.cmd === 'notifications.readAll') {
    const changed = markAllNotificationsRead(db, workspaceId)
    emit({ ...base, type: 'notifications.readAll', changed, unread: unreadNotificationCount(db, workspaceId) })
    return true
  }

  if (msg.cmd === 'notifications.delete') {
    if (typeof msg.id !== 'string' || !msg.id) throw new Error('缺少通知 ID')
    const removed = deleteNotification(db, msg.id)
    emit({ ...base, type: 'notifications.deleted', id: msg.id, removed, unread: unreadNotificationCount(db, workspaceId) })
    return true
  }

  if (msg.cmd === 'approval.grants') {
    const includeExpired = msg.includeExpired === true
    const now = new Date()
    const grants = listApprovalGrants(db)
      .filter((row) => includeExpired || !row.expiresAt || new Date(row.expiresAt).getTime() > now.getTime())
      .map((row) => ({
        id: row.id,
        groupKey: row.groupKey,
        toolName: row.toolName,
        grantedAt: row.grantedAt,
        expiresAt: row.expiresAt
      }))
    emit({ ...base, type: 'approval.grants', grants })
    return true
  }

  if (msg.cmd === 'approval.revoke') {
    if (typeof msg.groupKey !== 'string' || !msg.groupKey) throw new Error('缺少 groupKey')
    const removed = deleteApprovalGrant(db, msg.groupKey)
    emit({ ...base, type: 'approval.revoked', groupKey: msg.groupKey, removed })
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
    try {
      upsertPlugin(db, {
        kind: installed.manifest.kind,
        name: installed.name,
        version: installed.manifest.version,
        enabled,
        permissions: installed.manifest.permissions,
        manifest: installed.manifest
      })
    } catch (err) {
      // 文件已落盘但库没写进去 = 半装状态:下次启动会被当成"数据库缺失"的孤儿目录。
      // 这里必须回滚文件,让磁盘与数据库保持同一次成功或同一次失败。
      await uninstallPlugin(PLUGINS_DIR, installed.name).catch(() => undefined)
      throw new PluginInstallError(
        'database',
        `写入插件记录失败,已回滚安装: ${(err as Error).message}`
      )
    }
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

  if (msg.cmd === 'plugins.probe') {
    if (typeof msg.name !== 'string') throw new Error('缺少 name')
    const result = await pluginRuntime.probe(msg.name)
    emit({ ...base, type: 'plugins.probed', name: msg.name, ...result })
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
      skills: skills.statusList().map((s) => ({
        name: s.name,
        description: s.description,
        scope: s.scope,
        enabled: s.enabled
      })),
      issues: skills.issues()
    })
    return true
  }

  if (msg.cmd === 'skills.setEnabled') {
    if (typeof msg.name !== 'string' || !msg.name.trim()) throw new Error('缺少技能名')
    const name = msg.name.trim()
    const known = skills.statusList().some((skill) => skill.name === name)
    if (!known) throw new Error(`未知技能: ${name}`)
    if (typeof msg.enabled !== 'boolean') throw new Error('enabled 必须是布尔值')
    const current = new Set(getWorkspaceSettings(db, workspaceId).disabledSkills)
    if (msg.enabled) current.delete(name)
    else current.add(name)
    const settings = setDisabledSkills(db, workspaceId, [...current])
    // setDisabled 会丢弃库里已不存在于磁盘的技能名;再落一次以保持库与磁盘一致。
    skills.setDisabled(settings.disabledSkills)
    setDisabledSkills(db, workspaceId, skills.disabled())
    emit({
      ...base,
      type: 'skills.list',
      skills: skills.statusList().map((s) => ({
        name: s.name,
        description: s.description,
        scope: s.scope,
        enabled: s.enabled
      })),
      issues: skills.issues()
    })
    return true
  }

  if (msg.cmd === 'skills.pin') {
    if (typeof msg.name !== 'string' || !msg.name.trim()) throw new Error('缺少技能名')
    const name = msg.name.trim()
    if (!skills.entryOf(name)) throw new Error(`未知技能: ${name}`)
    if (typeof msg.pinned !== 'boolean') throw new Error('pinned 必须是布尔值')
    const current = getWorkspaceSettings(db, workspaceId).pinnedSkills.filter((item) => item !== name)
    const next = msg.pinned ? [name, ...current] : current
    const settings = setPinnedSkills(db, workspaceId, next)
    emit({ ...base, type: 'skills.pinned', settings })
    return true
  }

  if (msg.cmd === 'skills.uninstall') {
    if (typeof msg.name !== 'string' || !msg.name.trim()) throw new Error('缺少技能名')
    const name = msg.name.trim()
    const entry = await skills.removeUserSkill(name)
    const settings = getWorkspaceSettings(db, workspaceId)
    setDisabledSkills(db, workspaceId, settings.disabledSkills.filter((item) => item !== name))
    setPinnedSkills(db, workspaceId, settings.pinnedSkills.filter((item) => item !== name))
    skills.setDisabled(getWorkspaceSettings(db, workspaceId).disabledSkills)
    emit({
      ...base,
      type: 'skills.list',
      skills: skills.statusList().map((s) => ({
        name: s.name,
        description: s.description,
        scope: s.scope,
        enabled: s.enabled
      })),
      issues: skills.issues(),
      removed: name,
      path: entry.dir
    })
    return true
  }

  if (msg.cmd === 'skills.import') {
    if (typeof msg.sourceDir !== 'string' || !msg.sourceDir.trim()) throw new Error('缺少技能目录')
    const source = resolve(msg.sourceDir)
    const manifest = await validateSkillDir(source)
    const root = userSkillsRoot()
    const target = resolve(root, manifest.name)
    if (skills.entryOf(manifest.name)) {
      throw new Error(`同名技能已存在: ${manifest.name},请先卸载后再导入`)
    }
    await mkdir(root, { recursive: true })
    // validate 已扫描过源目录;复制到用户根目录后再 refresh,以磁盘为准。
    await cp(source, target, { recursive: true, errorOnExist: true, force: false })
    await skills.refresh()
    skills.setDisabled(getWorkspaceSettings(db, workspaceId).disabledSkills)
    emit({
      ...base,
      type: 'skills.list',
      skills: skills.statusList().map((s) => ({
        name: s.name,
        description: s.description,
        scope: s.scope,
        enabled: s.enabled
      })),
      issues: skills.issues(),
      imported: manifest.name,
      path: target
    })
    return true
  }

  if (msg.cmd === 'conversation.list') {
    const colleagues = listColleagues(db, workspaceId)
    emit({
      ...base,
      type: 'conversation.list',
      conversationId: activeConversationId,
      conversations: listConversationSummaries(db, workspaceId).map((c) => ({
        id: c.id,
        title: conversationDisplayTitle(c),
        autoTitle: c.title,
        modeId: c.modeId,
        colleagueId: c.colleagueId,
        colleagueName: c.colleagueId
          ? (colleagues.find((x) => x.id === c.colleagueId)?.name ?? null)
          : null,
        expertId: c.expertId,
        expertName: expertLabel(c.expertId),
        pinnedAt: c.pinnedAt,
        pinOrder: c.pinOrder,
        projectId: c.projectId,
        projectName: c.projectId
          ? (listProjects(db, workspaceId).find((x) => x.id === c.projectId)?.name ?? null)
          : null,
        channelId: c.channelId,
        channelName: c.channelId
          ? (listChannels(db, workspaceId).find((ch) => ch.id === c.channelId)?.name ?? null)
          : null,
        updatedAt: c.updatedAt,
        lastSeq: c.lastSeq,
        taskTotal: c.taskTotal,
        pending: c.pending,
        running: c.running,
        failed: c.failed,
        done: c.done,
        artifacts: c.artifacts,
        status: c.status
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
      messages: listMessages(db, id),
      artifacts: listArtifactsByConversation(db, id)
    })
    return true
  }

  if (msg.cmd === 'search.query') {
    const query = typeof msg.query === 'string' ? msg.query.slice(0, 200) : ''
    if (query.trim().length === 0) {
      emit({ ...base, type: 'search.result', query, groups: [] })
      return true
    }
    if (!dbHandle) throw new Error('DB_UNAVAILABLE')
    emit({
      ...base,
      type: 'search.result',
      ...search(dbHandle.raw, query, workspaceId)
    })
    return true
  }

  if (msg.cmd === 'conversation.new') {
    const channelId = typeof msg.channelId === 'string' && msg.channelId ? msg.channelId : null
    if (channelId && !listChannels(db, workspaceId).some((c) => c.id === channelId)) {
      throw new Error('频道不存在')
    }
    const colleagueId =
      typeof msg.colleagueId === 'string' && msg.colleagueId.trim() ? msg.colleagueId.trim() : null
    if (colleagueId) {
      assertColleagueAssignable(db, workspaceId, colleagueId, channelId)
    }
    const projectId =
      typeof msg.projectId === 'string' && msg.projectId.trim() ? msg.projectId.trim() : null
    if (projectId) assertProjectInWorkspace(db, workspaceId, projectId)
    const expertId =
      typeof msg.expertId === 'string' && msg.expertId.trim() ? msg.expertId.trim() : null
    if (expertId) requireExpert(expertId)
    const conv = createConversation(db, {
      workspaceId,
      title: typeof msg.title === 'string' && msg.title ? msg.title : '新会话',
      modeId: typeof msg.mode === 'string' ? msg.mode : 'craft',
      channelId,
      colleagueId,
      projectId,
      expertId
    })
    activeConversationId = conv.id
    emit({ ...base, type: 'conversation.created', conversationId: conv.id })
    return true
  }

  if (msg.cmd === 'conversation.pin') {
    if (typeof msg.conversationId !== 'string' || !msg.conversationId) throw new Error('缺少 conversationId')
    if (typeof msg.pinned !== 'boolean') throw new Error('缺少 pinned')
    const updated = setConversationPinned(db, msg.conversationId, msg.pinned)
    if (!updated) throw new Error('会话不存在')
    emit({
      ...base,
      type: 'conversation.updated',
      conversation: { id: updated.id, pinnedAt: updated.pinnedAt }
    })
    return true
  }

  if (msg.cmd === 'conversation.rename') {
    if (typeof msg.conversationId !== 'string' || !msg.conversationId) throw new Error('缺少 conversationId')
    if (typeof msg.title !== 'string') throw new Error('缺少 title')
    const updated = renameConversation(db, msg.conversationId, msg.title)
    if (!updated) throw new Error('会话不存在')
    emit({
      ...base,
      type: 'conversation.updated',
      conversation: { id: updated.id, title: conversationDisplayTitle(updated), autoTitle: updated.title }
    })
    return true
  }

  if (msg.cmd === 'message.feedback') {
    if (typeof msg.messageId !== 'string' || !msg.messageId) throw new Error('缺少 messageId')
    if (msg.feedback !== null && msg.feedback !== 'like' && msg.feedback !== 'dislike') {
      throw new Error('非法反馈值')
    }
    const existing = getMessage(db, msg.messageId)
    if (!existing) throw new Error('消息不存在')
    const owner = getConversation(db, existing.conversationId)
    // 跨工作区消息不能通过猜测 ID 修改,反馈接口也必须做归属校验。
    if (!owner || owner.workspaceId !== workspaceId) throw new Error('消息不属于当前工作区')
    if (existing.role !== 'assistant') throw new Error('只能对助手消息反馈')
    const reason = typeof msg.reason === 'string' ? msg.reason : null
    const updated = setMessageFeedback(db, msg.messageId, msg.feedback, reason)
    if (!updated) throw new Error('消息不存在')
    emit({
      ...base,
      type: 'message.feedback',
      messageId: updated.id,
      conversationId: updated.conversationId,
      feedback: updated.feedback,
      feedbackReason: updated.feedbackReason
    })
    return true
  }

  if (msg.cmd === 'conversation.replay' || msg.cmd === 'conversation.revert') {
    if (typeof msg.conversationId !== 'string' || !msg.conversationId) throw new Error('缺少 conversationId')
    if (typeof msg.messageId !== 'string' || !msg.messageId) throw new Error('缺少 messageId')
    const target = getMessage(db, msg.messageId)
    if (!target) throw new Error('无法定位对应的用户消息，请重试')
    const conv = getConversation(db, target.conversationId)
    if (!conv || conv.workspaceId !== workspaceId) throw new Error('消息不属于当前工作区')
    if (target.conversationId !== msg.conversationId) throw new Error('消息不属于该会话')
    if (target.role !== 'user') throw new Error('只能对用户消息重放或回退')
    // 运行中的轮次不能被截掉:否则模型回包会写到已删除的序号上,会话被破坏。
    if (activeRuns.has(target.conversationId) || startingRuns.has(target.conversationId)) {
      throw new Error('当前会话正在生成，请先停止后再操作')
    }

    const replay = msg.cmd === 'conversation.replay'
    // 先恢复工作区,再截断会话:恢复失败时不能先删掉消息,否则用户既失去历史
    // 又得不到回滚后的文件。目标版本缺失检查点时只回退会话,并在事件里说明。
    let files: { applied: boolean; reason?: string; touched: number; restored: number; deleted: number } = {
      applied: false,
      reason: '本轮没有文件检查点',
      touched: 0,
      restored: 0,
      deleted: 0
    }
    if (checkpointStore) {
      const targetCheckpoint = checkpointStore.byMessage(target.id)
      const laterCheckpoints = targetCheckpoint
        ? checkpointStore.afterSeq(target.conversationId, target.seq)
        : []
      try {
        files = await checkpointStore.restore(
          replay ? (targetCheckpoint?.before ?? null) : (targetCheckpoint?.after ?? null),
          targetCheckpoint ? [targetCheckpoint, ...laterCheckpoints] : []
        )
      } catch (err) {
        throw new Error(`恢复工作区文件失败,会话未改动: ${(err as Error).message}`)
      }
    }
    // 回退是"回到这个版本",目标轮本身必须保留;重放则是替换目标轮。
    // 两者都从下一轮用户消息开始截断,避免把目标轮的提问和答复误删。
    const cutoff = replay
      ? target.seq
      : listMessages(db, target.conversationId, { afterSeq: target.seq }).find((m) => m.role === 'user')?.seq
    const truncated = cutoff
      ? truncateConversationFrom(db, target.conversationId, cutoff)
      : {
          fromSeq: target.seq + 1,
          lastSeq: conv.lastSeq,
          deletedMessages: 0,
          deletedTasks: 0,
          deletedArtifacts: 0
        }
    let replayed: { id: string; seq: number } | null = null
    if (replay) {
      const meta = target.meta ?? {}
      const text = (target.content as { text?: unknown } | null)?.text
      if (typeof text !== 'string' || !text) throw new Error('该消息没有可重放的内容')
      // 先写入新的用户消息,再广播快照:界面收到事件时数据库已经可查询,
      // 不会出现"事件到了、历史还没落库"的空窗。
      const saved = appendMessage(db, {
        conversationId: target.conversationId,
        role: 'user',
        content: { text },
        meta,
        clientRequestId: `replay-${target.id}-${Date.now()}`
      })
      replayed = { id: saved.record.id, seq: saved.record.seq }
    }
    emit({
      ...base,
      type: replay ? 'conversation.replayed' : 'conversation.reverted',
      conversationId: target.conversationId,
      messageId: target.id,
      ...(replayed ? { newMessageId: replayed.id, newSeq: replayed.seq } : {}),
      // 直接给快照,界面无需在事件后再发一次请求:重放会立即开始流式输出,
      // 异步刷新若晚到就会把刚出现的助手消息清掉。
      messages: listMessages(db, target.conversationId),
      artifacts: listArtifactsByConversation(db, target.conversationId),
      files,
      ...truncated
    })

    if (!replay) return true

    const meta = target.meta ?? {}
    const text = (target.content as { text?: unknown } | null)?.text
    if (typeof text !== 'string' || !text) throw new Error('该消息没有可重放的内容')
    let mode: ModePolicy
    try {
      mode = resolveMode(typeof meta.mode === 'string' ? meta.mode : conv.modeId)
    } catch (err) {
      throw new Error(`原模式不可用: ${(err as Error).message}`)
    }
    const colleagueId =
      typeof meta.colleagueId === 'string' && meta.colleagueId ? meta.colleagueId : undefined
    if (colleagueId) assertColleagueAssignable(db, workspaceId, colleagueId, conv.channelId)
    const expertId = typeof meta.expertId === 'string' && meta.expertId ? meta.expertId : undefined
    const skill = typeof meta.skill === 'string' && meta.skill ? meta.skill : undefined
    const scene =
      meta.scene === 'working' || meta.scene === 'coding' || meta.scene === 'design'
        ? meta.scene
        : undefined
    const contextPaths = Array.isArray(meta.contextPaths)
      ? meta.contextPaths.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : undefined

    if (!replayed) throw new Error('重放消息写入失败')
    emit({
      type: 'conversation.ready',
      conversationId: target.conversationId,
      seq: replayed.seq,
      messageId: replayed.id
    })
    startingRuns.add(target.conversationId)
    try {
      await runAgent({
        text,
        mode,
        conversationId: target.conversationId,
        userMessageId: replayed.id,
        firstTurn: listMessages(db, target.conversationId).filter((m) => m.role === 'user').length <= 1,
        ...(colleagueId ? { colleagueId } : {}),
        ...(expertId ? { expertId } : {}),
        ...(skill ? { skill } : {}),
        ...(scene ? { scene } : {}),
        ...(contextPaths && contextPaths.length > 0 ? { contextPaths } : {})
      })
    } finally {
      startingRuns.delete(target.conversationId)
    }
    return true
  }

  if (msg.cmd === 'conversation.reorderPinned') {
    if (!Array.isArray(msg.orderedIds) || msg.orderedIds.some((id) => typeof id !== 'string')) {
      throw new Error('缺少 orderedIds')
    }
    const ordered = reorderPinnedConversations(db, workspaceId, msg.orderedIds as string[])
    emit({
      ...base,
      type: 'conversation.reordered',
      orderedIds: ordered.map((item) => item.id)
    })
    return true
  }

  if (msg.cmd === 'channel.list') {
    const channels = listChannels(db, workspaceId).map((c) => ({
      ...c,
      artifacts: listChannelArtifacts(db, c.id).length
    }))
    emit({ ...base, type: 'channel.list', channels })
    return true
  }

  if (msg.cmd === 'channel.create') {
    if (typeof msg.name !== 'string') throw new Error('缺少频道名')
    const created = createChannel(db, {
      workspaceId,
      name: msg.name,
      ...(typeof msg.description === 'string' ? { description: msg.description } : {})
    })
    emit({ ...base, type: 'channel.created', channel: created })
    return true
  }

  if (msg.cmd === 'channel.delete') {
    if (typeof msg.channelId !== 'string' || !msg.channelId) throw new Error('缺少 channelId')
    deleteChannel(db, msg.channelId)
    emit({ ...base, type: 'channel.deleted', channelId: msg.channelId })
    return true
  }

  if (msg.cmd === 'channel.artifacts') {
    if (typeof msg.channelId !== 'string' || !msg.channelId) throw new Error('缺少 channelId')
    emit({
      ...base,
      type: 'channel.artifacts',
      channelId: msg.channelId,
      artifacts: listChannelArtifacts(db, msg.channelId)
    })
    return true
  }

  if (msg.cmd === 'channel.shareArtifact') {
    if (typeof msg.channelId !== 'string' || !msg.channelId) throw new Error('缺少 channelId')
    if (typeof msg.artifactId !== 'string' || !msg.artifactId) throw new Error('缺少 artifactId')
    const { shared } = shareArtifactToChannel(db, {
      channelId: msg.channelId,
      artifactId: msg.artifactId
    })
    const artifacts = listChannelArtifacts(db, msg.channelId)
    const artifact = artifacts.find((a) => a.id === msg.artifactId)
    if (artifact) {
      // 共享动作本身也要同步到云侧;去重由 pending_event 的唯一键负责。
      const pendingId = `share-${msg.channelId}-${msg.artifactId}`
      const existing = listPending(db, workspaceId).some((p) => p.id === pendingId)
      if (shared && !existing) {
        enqueuePending(db, {
          workspaceId,
          kind: 'artifact',
          eventId: pendingId,
          payload: {
            eventId: pendingId,
            channelId: msg.channelId,
            artifactId: artifact.id,
            title: artifact.title,
            kind: artifact.kind,
            path: artifact.path,
            url: artifact.url,
            size: artifact.size,
            sha256: artifact.sha256
          }
        })
      }
    }
    emit({ ...base, type: 'channel.artifactShared', channelId: msg.channelId, shared, artifacts })
    return true
  }

  if (msg.cmd === 'sync.status') {
    emit({ ...base, type: 'sync.status', ...pendingStats() })
    return true
  }

  if (msg.cmd === 'sync.flush') {
    const config = syncConfig()
    if (!config) {
      emit({
        ...base,
        type: 'sync.flushed',
        configured: false,
        sentEvents: 0,
        sentArtifacts: 0,
        stopped: false,
        queue: pendingStats()
      })
      return true
    }
    if (msg.retryFailed === true) resetPendingBackoff(db, workspaceId)
    try {
      const result = await flushPending(db, workspaceId, config)
      emit({ ...base, type: 'sync.flushed', configured: true, ...result, queue: pendingStats() })
    } catch (err) {
      if (!(err instanceof SyncError)) throw err
      emit({
        ...base,
        type: 'sync.flushed',
        configured: true,
        sentEvents: 0,
        sentArtifacts: 0,
        failed: listPending(db, workspaceId).filter((p) => !p.sentAt).length,
        stopped: true,
        lastError: err.message,
        queue: pendingStats()
      })
    }
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

  if (msg.cmd === 'workflow.list') {
    if (!workflowService) throw new Error(fatal ?? '数据库未就绪')
    const result = await workflowService.list()
    emit({ ...base, type: 'workflow.list', ...result })
    return true
  }

  if (msg.cmd === 'workflow.run') {
    if (!workflowService) throw new Error(fatal ?? '数据库未就绪')
    if (typeof msg.workflowId !== 'string' || msg.workflowId.length === 0) throw new Error('缺少 workflowId')
    const conversationId = resolveConversationId(msg.conversationId)
    const inputs =
      msg.inputs !== null && typeof msg.inputs === 'object' && !Array.isArray(msg.inputs)
        ? (msg.inputs as Record<string, unknown>)
        : {}
    const started = await workflowService.start({
      workflowId: msg.workflowId,
      inputs,
      conversationId,
      ...(typeof msg.runId === 'string' && msg.runId.length > 0 ? { runId: msg.runId } : {}),
      ...(msg.resume === true ? { resume: true } : {})
    })
    emit({ ...base, type: 'workflow.queued', ...started, conversationId })
    return true
  }

  if (msg.cmd === 'workflow.resume') {
    if (!workflowService) throw new Error(fatal ?? '数据库未就绪')
    if (typeof msg.runId !== 'string' || msg.runId.length === 0) throw new Error('缺少 runId')
    const conversationId = resolveConversationId(msg.conversationId)
    const started = await workflowService.resume(msg.runId, conversationId)
    emit({ ...base, type: 'workflow.queued', ...started, conversationId, resume: true })
    return true
  }

  if (msg.cmd === 'workflow.cancel') {
    if (!workflowService) throw new Error(fatal ?? '数据库未就绪')
    if (typeof msg.runId !== 'string' || msg.runId.length === 0) throw new Error('缺少 runId')
    const cancelled = workflowService.cancel(msg.runId)
    emit({ ...base, type: 'workflow.cancelled', runId: msg.runId, cancelled })
    return true
  }

  if (msg.cmd === 'projects.list') {
    emit({ ...base, type: 'projects.list', projects: listProjects(db, workspaceId) })
    return true
  }

  if (msg.cmd === 'projects.create') {
    if (typeof msg.name !== 'string' || !msg.name.trim()) throw new Error('缺少项目名称')
    const project = createProject(db, {
      workspaceId,
      name: msg.name,
      ...(typeof msg.description === 'string' ? { description: msg.description } : {}),
      ...(typeof msg.instructions === 'string' ? { instructions: msg.instructions } : {}),
      ...(Array.isArray(msg.skillNames)
        ? { skillNames: msg.skillNames.filter((x): x is string => typeof x === 'string') }
        : {}),
      ...(typeof msg.pinned === 'boolean' ? { pinned: msg.pinned } : {})
    })
    emit({ ...base, type: 'projects.created', project })
    return true
  }

  if (msg.cmd === 'projects.update') {
    if (typeof msg.id !== 'string' || !msg.id) throw new Error('缺少项目 ID')
    assertProjectInWorkspace(db, workspaceId, msg.id)
    const project = updateProject(db, msg.id, {
      ...(typeof msg.name === 'string' ? { name: msg.name } : {}),
      ...(typeof msg.description === 'string' ? { description: msg.description } : {}),
      ...(typeof msg.instructions === 'string' ? { instructions: msg.instructions } : {}),
      ...(Array.isArray(msg.skillNames)
        ? { skillNames: msg.skillNames.filter((x): x is string => typeof x === 'string') }
        : {}),
      ...(typeof msg.pinned === 'boolean' ? { pinned: msg.pinned } : {})
    })
    if (!project) throw new Error('项目不存在')
    emit({ ...base, type: 'projects.updated', project })
    return true
  }

  if (msg.cmd === 'projects.delete') {
    if (typeof msg.id !== 'string' || !msg.id) throw new Error('缺少项目 ID')
    assertProjectInWorkspace(db, workspaceId, msg.id)
    const removed = deleteProject(db, msg.id)
    emit({ ...base, type: 'projects.deleted', id: msg.id, removed })
    return true
  }

  if (msg.cmd === 'projects.tasks') {
    if (typeof msg.id !== 'string' || !msg.id) throw new Error('缺少项目 ID')
    assertProjectInWorkspace(db, workspaceId, msg.id)
    emit({
      ...base,
      type: 'projects.tasks',
      projectId: msg.id,
      tasks: listConversations(db, workspaceId)
        .filter((c) => c.projectId === msg.id)
        .map((c) => ({
          id: c.id,
          title: conversationDisplayTitle(c),
          updatedAt: c.updatedAt,
          colleagueId: c.colleagueId,
          pinnedAt: c.pinnedAt
        }))
    })
    return true
  }

  if (msg.cmd === 'connections.list') {
    emit({ ...base, type: 'connections.list', connections: listConnections(db, workspaceId) })
    return true
  }

  if (msg.cmd === 'connections.set') {
    if (!isServiceProvider(msg.provider)) throw new Error('未知服务')
    // 连接状态由 daemon 探测得出,不采信客户端声明的 connected/lastError。
    const current = listConnections(db, workspaceId).find((item) => item.provider === msg.provider)
    const endpoint =
      typeof msg.endpoint === 'string' || msg.endpoint === null
        ? msg.endpoint
        : (current?.endpoint ?? null)
    const account =
      typeof msg.account === 'string' || msg.account === null ? msg.account : undefined
    const probe = await probeServiceEndpoint(endpoint)
    const connection = setConnection(db, {
      workspaceId,
      provider: msg.provider,
      status: probe.ok ? 'connected' : 'error',
      ...(endpoint !== null || msg.endpoint === null ? { endpoint } : {}),
      ...(account !== undefined ? { account } : {}),
      lastError: probe.ok ? null : probe.error,
      check: true
    })
    emit({ ...base, type: 'connections.updated', connection })
    return true
  }

  if (msg.cmd === 'connections.disconnect') {
    if (!isServiceProvider(msg.provider)) throw new Error('未知服务')
    const connection = disconnectService(db, workspaceId, msg.provider)
    emit({ ...base, type: 'connections.updated', connection })
    return true
  }

  if (msg.cmd === 'inspiration.list') {
    emit({ ...base, type: 'inspiration.list', posts: listInspirations(db, workspaceId) })
    return true
  }

  if (msg.cmd === 'inspiration.create') {
    if (typeof msg.title !== 'string' || !msg.title.trim()) throw new Error('缺少灵感标题')
    const post = createInspiration(db, {
      workspaceId,
      title: msg.title,
      ...(typeof msg.body === 'string' ? { body: msg.body } : {}),
      ...(typeof msg.source === 'string' ? { source: msg.source } : {}),
      ...(Array.isArray(msg.tags) ? { tags: msg.tags.filter((x): x is string => typeof x === 'string') } : {})
    })
    emit({ ...base, type: 'inspiration.created', post })
    return true
  }

  if (msg.cmd === 'inspiration.favorite') {
    if (typeof msg.id !== 'string' || !msg.id) throw new Error('缺少灵感 ID')
    if (typeof msg.favorite !== 'boolean') throw new Error('缺少收藏状态')
    const post = setInspirationFavorite(db, workspaceId, msg.id, msg.favorite)
    if (!post) throw new Error('灵感不存在')
    emit({ ...base, type: 'inspiration.updated', post })
    return true
  }

  if (msg.cmd === 'inspiration.delete') {
    if (typeof msg.id !== 'string' || !msg.id) throw new Error('缺少灵感 ID')
    const removed = deleteInspiration(db, workspaceId, msg.id)
    emit({ ...base, type: 'inspiration.deleted', id: msg.id, removed })
    return true
  }

  if (msg.cmd === 'automation.list') {
    if (!workflowService) throw new Error(fatal ?? '数据库未就绪')
    emit({ ...base, type: 'automation.list', automations: workflowService.listAutomations() })
    return true
  }

  if (msg.cmd === 'automation.create') {
    if (!workflowService) throw new Error(fatal ?? '数据库未就绪')
    if (typeof msg.name !== 'string' || msg.name.length === 0) throw new Error('缺少 name')
    if (typeof msg.prompt !== 'string' || msg.prompt.length === 0) throw new Error('缺少 prompt')
    if (msg.scheduleType !== 'once' && msg.scheduleType !== 'rrule') throw new Error('scheduleType 必须是 once 或 rrule')
    const created = workflowService.createAutomation({
      workspaceId,
      name: msg.name,
      scheduleType: msg.scheduleType,
      prompt: msg.prompt,
      modeId: typeof msg.modeId === 'string' ? msg.modeId : 'craft',
      ...(typeof msg.rrule === 'string' ? { rrule: msg.rrule } : {}),
      ...(typeof msg.scheduledAt === 'string' ? { scheduledAt: msg.scheduledAt } : {}),
      ...(typeof msg.timezone === 'string' ? { timezone: msg.timezone } : {}),
      ...(typeof msg.validUntil === 'string' ? { validUntil: msg.validUntil } : {}),
      ...(typeof msg.nextRunAt === 'string' ? { nextRunAt: msg.nextRunAt } : {}),
      ...(msg.enabled === false ? { enabled: false } : {})
    })
    emit({ ...base, type: 'automation.created', automation: created })
    return true
  }

  if (msg.cmd === 'automation.toggle') {
    if (!workflowService) throw new Error(fatal ?? '数据库未就绪')
    if (typeof msg.id !== 'string') throw new Error('缺少 id')
    if (typeof msg.enabled !== 'boolean') throw new Error('缺少 enabled')
    workflowService.updateAutomation(msg.id, { enabled: msg.enabled })
    emit({ ...base, type: 'automation.updated', id: msg.id, enabled: msg.enabled })
    return true
  }

  if (msg.cmd === 'automation.delete') {
    if (!workflowService) throw new Error(fatal ?? '数据库未就绪')
    if (typeof msg.id !== 'string') throw new Error('缺少 id')
    workflowService.deleteAutomation(msg.id)
    emit({ ...base, type: 'automation.deleted', id: msg.id })
    return true
  }

  if (msg.cmd === 'automation.scan') {
    if (!workflowService) throw new Error(fatal ?? '数据库未就绪')
    const claimed = await workflowService.scan(
      typeof msg.now === 'string' ? msg.now : undefined,
      { startup: msg.startup === true }
    )
    emit({ ...base, type: 'automation.scanned', claimed })
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

  const skill =
    typeof msg.skill === 'string' && msg.skill.trim().length > 0 ? msg.skill.trim() : undefined
  const colleagueId =
    typeof msg.colleagueId === 'string' && msg.colleagueId.trim().length > 0
      ? msg.colleagueId.trim()
      : undefined
  const expertId =
    typeof msg.expertId === 'string' && msg.expertId.trim().length > 0
      ? msg.expertId.trim()
      : undefined
  const scene =
    msg.scene === 'working' || msg.scene === 'coding' || msg.scene === 'design'
      ? msg.scene
      : undefined
  const contextPaths = Array.isArray(msg.contextPaths)
    ? msg.contextPaths
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : undefined

  const db = requireDb()
  const existingConversation = getConversation(db, conversationId)
  const effectiveColleagueId = colleagueId ?? existingConversation?.colleagueId ?? undefined
  if (effectiveColleagueId) {
    assertColleagueAssignable(db, workspaceId, effectiveColleagueId, existingConversation?.channelId ?? null)
  }
  const effectiveExpertId = resolveConversationExpert(db, conversationId, expertId, existingConversation)
  // 首轮判定必须在写入本次用户消息之前取:之后历史里至少已有这一条,
  // 再数一遍会把每一轮都当成"新会话"。
  const firstTurn = listMessages(db, conversationId).every((m) => m.role !== 'user')
  const saved = appendMessage(db, {
    conversationId,
    role: 'user',
    content: { text: msg.text },
    // 记录本轮上下文:重放要复原同一模式/技能/场景/@文件,而不是只重发文本。
    meta: {
      mode: mode.id,
      ...(skill ? { skill } : {}),
      ...(effectiveColleagueId ? { colleagueId: effectiveColleagueId } : {}),
      ...(effectiveExpertId ? { expertId: effectiveExpertId } : {}),
      ...(scene ? { scene } : {}),
      ...(contextPaths && contextPaths.length > 0 ? { contextPaths } : {})
    },
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

  emit({
    type: 'conversation.ready',
    conversationId,
    seq: saved.record.seq,
    messageId: saved.record.id
  })
  startingRuns.add(conversationId)
  try {
    await runAgent({
      text: msg.text,
      mode,
      conversationId,
      userMessageId: saved.record.id,
      firstTurn,
      ...(clientRequestId ? { clientRequestId } : {}),
      ...(skill ? { skill } : {}),
      ...(effectiveColleagueId ? { colleagueId: effectiveColleagueId } : {}),
      ...(effectiveExpertId ? { expertId: effectiveExpertId } : {}),
      ...(scene ? { scene } : {}),
      ...(contextPaths && contextPaths.length > 0 ? { contextPaths } : {})
    })
  } finally {
    startingRuns.delete(conversationId)
    pendingCancels.delete(conversationId)
  }
}

process.stdin.on('data', (chunk: Buffer) => {
  let frames: unknown[]
  try {
    frames = decoder.push(chunk)
  } catch (err) {
    emit({ type: 'error', code: 'BAD_FRAME', message: (err as Error).message, retryable: false })
    process.exit(4)
  }
  for (const frame of frames) {
    const record = frame && typeof frame === 'object' ? (frame as Record<string, unknown>) : null
    // 审批回答必须绕过串行队列:发起审批的那次工具调用正占着队列等待它,
    // 若排到队尾就会形成死锁,直到超时才"拒绝"。
    if (record?.cmd === 'approval.respond') {
      const result = approvalBridge.respond(record)
      emit({
        ...(record.requestId !== undefined ? { requestId: record.requestId } : {}),
        type: 'approval.answered',
        ...result
      })
      continue
    }
    // 停止生成同理:chat 正占着串行队列,排到队尾的取消命令永远等不到执行。
    if (record?.cmd === 'conversation.cancel') {
      const conversationId =
        typeof record.conversationId === 'string' && record.conversationId
          ? record.conversationId
          : undefined
      const accepted = cancelRun(conversationId)
      emit({
        ...(record.requestId !== undefined ? { requestId: record.requestId } : {}),
        type: 'conversation.cancel',
        ...(conversationId ? { conversationId } : {}),
        accepted
      })
      continue
    }
    const requestId =
      frame && typeof frame === 'object' ? (frame as { requestId?: unknown }).requestId : undefined
    enqueue(() => handleFrame(frame), requestId)
  }
})

process.stdin.on('end', () => {
  approvalBridge.markDisconnected()
  try {
    decoder.finish()
  } catch {
    // 对端半关闭属于正常退出路径,不视为错误
  }
  void queue
    .finally(async () => {
      stopSync?.()
      // 先取消并等待后台工作流/自动化落盘,再关数据库
      await workflowService?.shutdown()
      await pluginRuntime.stopAll()
      dbHandle?.raw.close()
    })
    .finally(() => process.exit(0))
})

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

// 启动补跑放在 ready 之后:桌面端先看到可交互界面,补跑在后台进行。
// 验收脚本需要手动控制时钟,因此允许用 OPENWB_AUTOMATION_AUTOSTART=0 关闭。
if (process.env.OPENWB_AUTOMATION_AUTOSTART !== '0') workflowService?.startScheduler()

// 只有显式配置了服务端地址才启动同步:默认离线可用,不因云端不可达反复报错。
const activeSync = dbHandle ? syncConfig() : null
if (activeSync && dbHandle) {
  stopSync = startSyncLoop(dbHandle.db, workspaceId, activeSync, {
    intervalMs: Number(process.env.OPENWB_SYNC_INTERVAL_MS ?? 15_000),
    onError: (err) => process.stderr.write(`[sync] ${err.message}\n`)
  })
  process.stderr.write(`[sync] 已启用 -> ${safeEndpoint(SYNC_URL)}\n`)
}

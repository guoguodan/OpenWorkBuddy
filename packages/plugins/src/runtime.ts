import { mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { McpTool } from './mcp-client.js'
import { McpStdioClient, McpError } from './mcp-client.js'
import type { DiscoveredPlugin } from './install.js'
import type { PluginManifest, McpServerSpec } from './manifest.js'
import { buildSafeEnv, expandVars } from './env.js'

/**
 * 插件生命周期(IMPLEMENTATION §6.3)。
 *
 * 这里刻意把"状态机"和"MCP 传输"分开:
 * - McpStdioClient 只负责一条 JSON-RPC 连接;
 * - PluginRuntime 负责重试、健康检查、工具命名空间与降级。
 *
 * 单个插件失败只影响它自己:任何路径都不允许把异常抛到 daemon 主循环。
 */

export type PluginRuntimeState =
  | 'unloaded'
  | 'starting'
  | 'ready'
  | 'reconnecting'
  | 'disabled'
  | 'crashed'

export interface PluginToolDescriptor {
  /** 模型可见名:<plugin>__<tool>,必要时截断并追加哈希 */
  name: string
  pluginName: string
  serverName: string
  /** MCP server 自己声明的原始工具名 */
  originalName: string
  description: string
  inputSchema: unknown
  /** 清单 highCreditTools 是否声明了该工具(P5 只记录,P8 才接审批) */
  highCredit: boolean
  effects: {
    writesFilesystem: boolean
    accessesNetwork: boolean
    mayIncurCost: boolean
  }
}

export interface PluginSnapshot {
  name: string
  displayName: string
  version: string
  kind: 'connector' | 'expert'
  state: PluginRuntimeState
  enabled: boolean
  attempts: number
  lastError: string | null
  tools: Array<{ name: string; description: string; highCredit: boolean }>
  pids: number[]
  warnings: string[]
  verifiedPublisher: boolean
  permissions: string[]
}

export interface PluginRuntimeEvent {
  type: 'plugin.status'
  plugin: PluginSnapshot
}

export interface PluginRuntimeOptions {
  pluginsRoot: string
  pluginDataRoot: string
  /** 运行时凭据;P5 没有凭据 UI,默认空对象 */
  credentials?: Record<string, string>
  /** 启动退避,默认 1s -> 2s -> 4s */
  backoffMs?: number[]
  maxFailures?: number
  /** 健康检查间隔,测试可调小 */
  healthIntervalMs?: number
  /** 连续多少次健康检查失败按崩溃处理 */
  healthFailureThreshold?: number
  onEvent?: (event: PluginRuntimeEvent) => void
  onLog?: (plugin: string, message: string) => void
}

interface ServerHandle {
  serverName: string
  spec: McpServerSpec
  client: McpStdioClient
}

interface Instance {
  plugin: DiscoveredPlugin
  enabled: boolean
  state: PluginRuntimeState
  attempts: number
  failures: number
  healthFailures: number
  lastError: string | null
  servers: ServerHandle[]
  tools: PluginToolDescriptor[]
  retryTimer: NodeJS.Timeout | null
  healthTimer: NodeJS.Timeout | null
  stopping: boolean
}

const DEFAULT_BACKOFF = [1000, 2000, 4000]
const DEFAULT_MAX_FAILURES = 3
const DEFAULT_HEALTH_INTERVAL = 60_000
const DEFAULT_HEALTH_FAILURE_THRESHOLD = 2
const MAX_TOOL_NAME = 64

/** OpenAI/Anthropic 的函数名上限通常是 64;超长时保留可读前缀并追加稳定哈希 */
export function namespacedToolName(pluginName: string, toolName: string): string {
  const raw = `${pluginName}__${toolName}`
  if (raw.length <= MAX_TOOL_NAME) return raw
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 8)
  return `${raw.slice(0, MAX_TOOL_NAME - 9)}_${hash}`
}

/** 从 MCP 返回值里取出模型可直接阅读的文本 */
export function normalizeMcpResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result
  const record = result as { content?: unknown; isError?: boolean }
  if (record.isError === true) {
    const text = extractText(record.content)
    throw new McpError('PLUGIN_TOOL_ERROR', text || '插件工具返回错误', false)
  }
  const content = record.content
  if (Array.isArray(content)) {
    const texts = content
      .filter((item): item is { type: 'text'; text: string } =>
        Boolean(item && typeof item === 'object' && (item as { type?: string }).type === 'text' &&
          typeof (item as { text?: unknown }).text === 'string')
      )
      .map((item) => item.text)
    if (texts.length === 1) return texts[0]
    if (texts.length > 1) return texts.join('\n')
  }
  return result
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((item): item is { type: 'text'; text: string } =>
      Boolean(item && typeof item === 'object' && (item as { type?: string }).type === 'text' &&
        typeof (item as { text?: unknown }).text === 'string')
    )
    .map((item) => item.text)
    .join('\n')
}

export class PluginRuntime {
  private readonly instances = new Map<string, Instance>()
  private readonly toolCache = new Map<string, McpTool[]>()
  private readonly options: Required<Omit<PluginRuntimeOptions, 'onEvent' | 'onLog'>> & {
    onEvent?: (event: PluginRuntimeEvent) => void
    onLog?: (plugin: string, message: string) => void
  }

  constructor(options: PluginRuntimeOptions) {
    this.options = {
      pluginsRoot: options.pluginsRoot,
      pluginDataRoot: options.pluginDataRoot,
      credentials: options.credentials ?? {},
      backoffMs: options.backoffMs ?? DEFAULT_BACKOFF,
      maxFailures: options.maxFailures ?? DEFAULT_MAX_FAILURES,
      healthIntervalMs: options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL,
      healthFailureThreshold:
        options.healthFailureThreshold ?? DEFAULT_HEALTH_FAILURE_THRESHOLD,
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      ...(options.onLog ? { onLog: options.onLog } : {})
    }
  }

  register(plugin: DiscoveredPlugin, input?: { enabled?: boolean }): void {
    const existing = this.instances.get(plugin.name)
    if (existing) {
      existing.plugin = plugin
      if (input?.enabled !== undefined) existing.enabled = input.enabled
      return
    }
    const shell = plugin.manifest.permissions.includes('shell')
    this.instances.set(plugin.name, {
      plugin,
      // 声明 shell 的插件即使调用方忘记设置,也默认不启用
      enabled: input?.enabled ?? !shell,
      state: 'unloaded',
      attempts: 0,
      failures: 0,
      healthFailures: 0,
      lastError: null,
      servers: [],
      tools: [],
      retryTimer: null,
      healthTimer: null,
      stopping: false
    })
  }

  /** 启动所有已登记且启用的插件。单个失败不会让 startAll reject。 */
  async startAll(): Promise<void> {
    for (const instance of this.instances.values()) {
      if (!instance.enabled) {
        this.setState(instance, 'disabled', instance.lastError)
        continue
      }
      await this.start(instance.plugin.name)
    }
  }

  async start(name: string): Promise<void> {
    const instance = this.instances.get(name)
    if (!instance) throw new Error(`插件未登记: ${name}`)
    if (!instance.enabled) {
      this.setState(instance, 'disabled')
      return
    }
    if (instance.state === 'starting' || instance.state === 'ready') return
    this.clearTimers(instance)
    try {
      await this.startOnce(instance)
    } catch (err) {
      this.handleFailure(instance, (err as Error).message, false)
    }
  }

  /** 安装阶段使用:只尝试一次,失败立即抛出,便于 daemon 回滚安装 */
  async startOrThrow(name: string): Promise<void> {
    const instance = this.instances.get(name)
    if (!instance) throw new Error(`插件未登记: ${name}`)
    if (!instance.enabled) throw new Error(`插件 ${name} 已被禁用`)
    this.clearTimers(instance)
    await this.startOnce(instance)
  }

  private async startOnce(instance: Instance): Promise<void> {
    instance.attempts += 1
    instance.stopping = false
    this.setState(instance, 'starting')
    this.log(instance.plugin.name, `启动第 ${instance.attempts} 次`)

    const manifest = instance.plugin.manifest
    if (manifest.kind === 'expert') {
      // expert 是纯清单:没有进程,也就没有工具。技能正文的注入在后续版本接入。
      instance.servers = []
      instance.tools = []
      instance.healthFailures = 0
      instance.failures = 0
      instance.lastError = null
      this.setState(instance, 'ready')
      this.startHealthCheck(instance)
      return
    }

    await mkdir(instance.plugin.dir, { recursive: true })
    const dataDir = join(this.options.pluginDataRoot, manifest.name)
    await mkdir(dataDir, { recursive: true })

    const servers: ServerHandle[] = []
    try {
      for (const [serverName, spec] of Object.entries(manifest.mcpServers)) {
        const client = new McpStdioClient({
          command: expandVars(spec.command, {
            pluginRoot: instance.plugin.dir,
            dataDir,
            credentials: this.options.credentials
          }),
          args: spec.args.map((arg) =>
            expandVars(arg, {
              pluginRoot: instance.plugin.dir,
              dataDir,
              credentials: this.options.credentials
            })
          ),
          env: buildSafeEnv(
            manifest,
            {
              pluginRoot: instance.plugin.dir,
              dataDir,
              credentials: this.options.credentials
            },
            spec.env
          ),
          cwd: instance.plugin.dir,
          onStderr: (text) => this.log(manifest.name, `[${serverName}] ${text.trim()}`),
          onExit: (code, signal) => {
            if (instance.stopping || instance.state !== 'ready') return
            this.handleCrash(instance, `插件进程退出(code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
          }
        })
        await client.start()
        servers.push({ serverName, spec, client })
        instance.servers = servers
      }

      const collected: PluginToolDescriptor[] = []
      for (const handle of servers) {
        const serverName = handle.serverName
        const cacheKey = `${manifest.name}@${manifest.version}#${serverName}`
        let tools = this.toolCache.get(cacheKey)
        if (!tools) {
          tools = await handle.client.listTools()
          this.toolCache.set(cacheKey, tools)
        }
        for (const tool of tools) {
          if (!tool || typeof tool.name !== 'string' || tool.name.length === 0) continue
          const fullName = namespacedToolName(manifest.name, tool.name)
          const highCredit = Object.prototype.hasOwnProperty.call(manifest.highCreditTools, tool.name)
          collected.push({
            name: fullName,
            pluginName: manifest.name,
            serverName,
            originalName: tool.name,
            description: tool.description ?? `${manifest.displayName}: ${tool.name}`,
            inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
            highCredit,
            effects: {
              writesFilesystem:
                manifest.permissions.includes('filesystem:plugin-data') ||
                manifest.permissions.includes('filesystem:workspace-read'),
              accessesNetwork: manifest.permissions.includes('network'),
              mayIncurCost: highCredit
            }
          })
        }
      }

      const duplicate = collected.find(
        (tool, index) => collected.findIndex((other) => other.name === tool.name) !== index
      )
      if (duplicate) throw new Error(`插件工具命名冲突: ${duplicate.name}`)

      instance.tools = collected
      instance.healthFailures = 0
      // 成功启动必须清零失败计数:否则"崩溃-恢复-再崩溃"会很快撞到 3 次上限,
      // 与"连续失败 3 次才降级"的语义不符。
      instance.failures = 0
      instance.lastError = null
      this.setState(instance, 'ready')
      this.startHealthCheck(instance)
      this.log(manifest.name, `就绪,工具 ${collected.length} 个`)
    } catch (err) {
      await this.stopServers(servers)
      instance.servers = []
      instance.tools = []
      throw err
    }
  }

  private handleFailure(instance: Instance, message: string, crashed: boolean): void {
    instance.failures += 1
    instance.lastError = message
    this.log(instance.plugin.name, `${crashed ? '崩溃' : '启动失败'}: ${message}`)

    if (instance.failures >= this.options.maxFailures) {
      instance.enabled = false
      instance.tools = []
      instance.state = 'disabled'
      this.emit(instance)
      this.onTerminal(instance)
      return
    }

    const backoff = this.options.backoffMs[instance.failures - 1] ?? 1000
    this.setState(instance, 'reconnecting')
    instance.retryTimer = setTimeout(() => {
      instance.retryTimer = null
      if (!instance.enabled) return
      void this.start(instance.plugin.name)
    }, backoff)
  }

  private handleCrash(instance: Instance, message: string): void {
    if (instance.state === 'reconnecting' || instance.state === 'disabled') return
    this.clearTimers(instance)
    instance.stopping = true
    void this.stopServers(instance.servers).finally(() => {
      instance.servers = []
      instance.tools = []
      instance.stopping = false
      this.handleFailure(instance, message, true)
    })
  }

  private startHealthCheck(instance: Instance): void {
    this.clearHealthTimer(instance)
    instance.healthTimer = setInterval(() => {
      if (instance.state !== 'ready') return
      void (async () => {
        try {
          for (const handle of instance.servers) {
            // MCP 没有普遍实现的 ping 时,listTools 是最轻量的存活探测
            await handle.client.listTools()
          }
          instance.healthFailures = 0
        } catch (err) {
          instance.healthFailures += 1
          this.log(instance.plugin.name, `健康检查失败 ${instance.healthFailures}: ${(err as Error).message}`)
          if (instance.healthFailures >= this.options.healthFailureThreshold) {
            this.handleCrash(instance, `健康检查连续失败: ${(err as Error).message}`)
          }
        }
      })()
    }, this.options.healthIntervalMs)
    // 健康检查不应单独阻止进程退出
    instance.healthTimer.unref?.()
  }

  async stop(name: string): Promise<void> {
    const instance = this.instances.get(name)
    if (!instance) return
    this.clearTimers(instance)
    instance.stopping = true
    await this.stopServers(instance.servers)
    instance.servers = []
    instance.tools = []
    instance.stopping = false
    instance.state = instance.enabled ? 'unloaded' : 'disabled'
    this.emit(instance)
  }

  async remove(name: string): Promise<void> {
    const instance = this.instances.get(name)
    if (!instance) return
    this.clearTimers(instance)
    instance.stopping = true
    await this.stopServers(instance.servers)
    instance.servers = []
    instance.tools = []
    this.instances.delete(name)
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const instance = this.instances.get(name)
    if (!instance) throw new Error(`插件未登记: ${name}`)
    instance.enabled = enabled
    if (!enabled) {
      await this.stop(name)
      instance.state = 'disabled'
      this.emit(instance)
      return
    }
    instance.failures = 0
    instance.attempts = 0
    await this.start(name)
  }

  /**
   * 先启动一次并立即停掉,用于 UI 的"测试连接"。
   *
   * 与 setEnabled(true) 的区别:这里不改持久化的 enabled,
   * 失败也不会累加崩溃计数——它只是一次探测,不该影响插件的生命周期判定。
   */
  async probe(name: string): Promise<{ ok: boolean; tools: number; error?: string }> {
    const instance = this.instances.get(name)
    if (!instance) throw new Error(`插件未登记: ${name}`)
    const wasEnabled = instance.enabled
    const wasState = instance.state
    this.clearTimers(instance)
    instance.stopping = true
    await this.stopServers(instance.servers)
    instance.servers = []
    instance.stopping = false
    instance.enabled = true
    try {
      await this.startOnce(instance)
      const tools = instance.tools.length
      return { ok: true, tools }
    } catch (err) {
      return { ok: false, tools: 0, error: (err as Error).message }
    } finally {
      this.clearTimers(instance)
      instance.stopping = true
      await this.stopServers(instance.servers)
      instance.servers = []
      instance.stopping = false
      instance.enabled = wasEnabled
      instance.state = wasEnabled ? 'unloaded' : 'disabled'
      instance.attempts = 0
      instance.failures = 0
      instance.lastError = wasState === 'ready' ? null : instance.lastError
      this.emit(instance)
    }
  }

  async retry(name: string): Promise<void> {
    const instance = this.instances.get(name)
    if (!instance) throw new Error(`插件未登记: ${name}`)
    instance.enabled = true
    instance.failures = 0
    instance.healthFailures = 0
    instance.lastError = null
    await this.start(name)
  }

  hasTool(name: string): boolean {
    return this.availableTools().some((tool) => tool.name === name)
  }

  availableTools(): PluginToolDescriptor[] {
    const out: PluginToolDescriptor[] = []
    for (const instance of this.instances.values()) {
      if (!instance.enabled || instance.state !== 'ready') continue
      out.push(...instance.tools)
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    for (const instance of this.instances.values()) {
      if (!instance.enabled || instance.state !== 'ready') continue
      const tool = instance.tools.find((candidate) => candidate.name === name)
      if (!tool) continue
      const handle = instance.servers.find((server) => server.serverName === tool.serverName)
      if (!handle) {
        throw new McpError('PLUGIN_UNAVAILABLE', `插件工具不可用: ${name}`, true)
      }
      const result = await handle.client.callTool(tool.originalName, args, signal)
      return normalizeMcpResult(result)
    }
    throw new McpError(
      'PLUGIN_UNAVAILABLE',
      `插件工具不存在或插件已停止: ${name}`,
      false
    )
  }

  snapshot(): PluginSnapshot[] {
    return [...this.instances.values()]
      .map((instance) => this.toSnapshot(instance))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  snapshotOf(name: string): PluginSnapshot | undefined {
    const instance = this.instances.get(name)
    return instance ? this.toSnapshot(instance) : undefined
  }

  async stopAll(): Promise<void> {
    for (const name of [...this.instances.keys()]) {
      await this.stop(name).catch(() => undefined)
    }
  }

  private toSnapshot(instance: Instance): PluginSnapshot {
    const manifest: PluginManifest = instance.plugin.manifest
    return {
      name: manifest.name,
      displayName: manifest.displayName,
      version: manifest.version,
      kind: manifest.kind,
      state: instance.state,
      enabled: instance.enabled,
      attempts: instance.attempts,
      lastError: instance.lastError,
      tools: instance.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        highCredit: tool.highCredit
      })),
      pids: instance.servers
        .map((server) => server.client.pid)
        .filter((pid): pid is number => typeof pid === 'number'),
      warnings: instance.plugin.warnings,
      verifiedPublisher: instance.plugin.verifiedPublisher,
      permissions: manifest.permissions
    }
  }

  private setState(instance: Instance, state: PluginRuntimeState, error?: string | null): void {
    instance.state = state
    if (error !== undefined) instance.lastError = error
    this.emit(instance)
  }

  private emit(instance: Instance): void {
    this.options.onEvent?.({ type: 'plugin.status', plugin: this.toSnapshot(instance) })
  }

  private onTerminal(instance: Instance): void {
    this.log(instance.plugin.name, '已降级禁用')
  }

  private log(plugin: string, message: string): void {
    this.options.onLog?.(plugin, message)
  }

  private async stopServers(servers: ServerHandle[]): Promise<void> {
    await Promise.all(servers.map((server) => server.client.stop().catch(() => undefined)))
  }

  private clearTimers(instance: Instance): void {
    if (instance.retryTimer) {
      clearTimeout(instance.retryTimer)
      instance.retryTimer = null
    }
    this.clearHealthTimer(instance)
  }

  private clearHealthTimer(instance: Instance): void {
    if (instance.healthTimer) {
      clearInterval(instance.healthTimer)
      instance.healthTimer = null
    }
  }
}
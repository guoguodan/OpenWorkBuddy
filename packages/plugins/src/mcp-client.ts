import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/**
 * 最小 MCP stdio 客户端。
 *
 * 为什么不用 @modelcontextprotocol/sdk:
 * MCP 的 stdio 传输就是"一行一个 JSON-RPC 报文",协议本身很小;
 * 宿主只需要 initialize / tools/list / tools/call 三个方法。
 * 自带实现可以避免给 daemon 引入一个会拖入传输层/HTTP 依赖的大包,
 * 也便于在插件进程崩溃时精确控制生命周期。
 */

export interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: number | string
  result: unknown
}

export interface JsonRpcFailure {
  jsonrpc: '2.0'
  id: number | string | null
  error: { code: number; message: string; data?: unknown }
}

export type JsonRpcMessage = JsonRpcSuccess | JsonRpcFailure

/** 通知(无 id)与插件发起的请求(插件→宿主)都属于非响应报文 */
export interface JsonRpcNotification {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  result?: unknown
  error?: { code: number; message: string }
}

export interface McpTool {
  name: string
  description?: string
  inputSchema?: unknown
}

export class McpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message)
    this.name = 'McpError'
  }
}

export interface McpClientOptions {
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  /** 单次请求超时(毫秒) */
  requestTimeoutMs?: number
  /** 初始化超时(毫秒) */
  initTimeoutMs?: number
  onStderr?: (text: string) => void
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
}

const DEFAULT_REQUEST_TIMEOUT = 120_000
const DEFAULT_INIT_TIMEOUT = 10_000
/** 单行报文上限,防止失控插件把宿主内存吃满 */
const MAX_LINE_BYTES = 4 * 1024 * 1024

export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >()
  private buffer = ''
  private closed = false
  private exited: Promise<void> | null = null

  constructor(private readonly options: McpClientOptions) {}

  get pid(): number | undefined {
    return this.child?.pid
  }

  async start(): Promise<void> {
    if (this.child) return

    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child

    this.exited = new Promise<void>((resolve) => {
      child.on('exit', (code, signal) => {
        this.closed = true
        this.rejectAll(new McpError('PLUGIN_EXITED', `插件进程已退出(code=${code ?? 'null'})`, true))
        this.options.onExit?.(code, signal)
        resolve()
      })
    })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.options.onStderr?.(chunk))
    child.on('error', (err) => {
      this.closed = true
      this.rejectAll(new McpError('PLUGIN_SPAWN_FAILED', (err as Error).message, true))
    })

    await this.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'openwb-host', version: '0.0.1' }
      },
      this.options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT
    )
    this.notify('notifications/initialized')
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.request(
      'tools/list',
      {},
      this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT
    )) as { tools?: McpTool[] }
    return Array.isArray(result?.tools) ? result.tools : []
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args }, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT, signal)
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.closed = true
    this.rejectAll(new McpError('PLUGIN_STOPPED', '插件已停止', false))
    child.kill()
    await Promise.race([
      this.exited ?? Promise.resolve(),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000))
    ])
    this.child = null
  }

  private rejectAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
      this.pending.delete(id)
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = ''
      this.rejectAll(new McpError('PLUGIN_PROTOCOL', 'MCP 报文超过 4MB 上限', false))
      return
    }

    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const raw = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!raw) continue
      let message: JsonRpcMessage | JsonRpcNotification
      try {
        message = JSON.parse(raw) as JsonRpcMessage
      } catch {
        // 插件往 stdout 打了日志:不能让宿主崩,但也不能当作响应
        this.options.onStderr?.(`[非 JSON stdout] ${raw.slice(0, 200)}`)
        continue
      }
      this.onMessage(message)
    }
  }

  private onMessage(message: JsonRpcMessage | JsonRpcNotification): void {
    // 通知与插件发起的请求没有数字 id,宿主不处理
    if (typeof message.id !== 'number') return
    const entry = this.pending.get(message.id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(message.id)
    if ('error' in message) {
      entry.reject(
        new McpError('PLUGIN_RPC_ERROR', `${message.error.message}(code=${message.error.code})`, false)
      )
    } else {
      entry.resolve(message.result)
    }
  }

  private notify(method: string, params?: unknown): void {
    if (!this.child || this.closed) return
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`)
  }

  private request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (!this.child || this.closed) {
      return Promise.reject(new McpError('PLUGIN_UNAVAILABLE', '插件未启动或已停止', true))
    }
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new McpError('PLUGIN_TIMEOUT', `MCP 请求超时: ${method}`, true))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })

      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(new McpError('PLUGIN_CANCELLED', '调用已取消', false))
          return
        }
        signal.addEventListener(
          'abort',
          () => {
            const entry = this.pending.get(id)
            if (!entry) return
            clearTimeout(entry.timer)
            this.pending.delete(id)
            entry.reject(new McpError('PLUGIN_CANCELLED', '调用已取消', false))
          },
          { once: true }
        )
      }

      this.child!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (err) => {
        if (!err) return
        const entry = this.pending.get(id)
        if (!entry) return
        clearTimeout(entry.timer)
        this.pending.delete(id)
        entry.reject(new McpError('PLUGIN_WRITE_FAILED', (err as Error).message, true))
      })
    })
  }
}

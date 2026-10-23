import { app, BrowserWindow, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { FrameDecoder, assertHello, encodeFrame, PROTOCOL_VERSION } from '@openwb/protocol'

app.setName('OpenWorkBuddy')

let win: BrowserWindow | null = null
let daemon: ReturnType<typeof spawn> | null = null
let handshakeOk = false

interface DaemonEvent {
  type?: string
  requestId?: string
}

let resolveReady: (() => void) | null = null
let rejectReady: ((e: Error) => void) | null = null
const daemonReady = new Promise<void>((resolve, reject) => {
  resolveReady = resolve
  rejectReady = reject
})

const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
let seq = 0

/** dataDir 由主进程解析,daemon 不依赖 Electron API */
function resolveDataDir(): string {
  if (process.env.OPENWB_DATA_DIR) return path.resolve(process.env.OPENWB_DATA_DIR)
  return path.join(app.getPath('appData'), 'OpenWorkBuddy', 'data')
}

function request<T>(payload: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
  const requestId = `req-${++seq}`
  return new Promise<T>((resolve, reject) => {
    if (!daemon?.stdin?.writable) {
      reject(new Error('daemon 未就绪'))
      return
    }
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error('daemon 请求超时'))
    }, timeoutMs)
    pending.set(requestId, {
      resolve: (v) => { clearTimeout(timer); resolve(v as T) },
      reject: (e) => { clearTimeout(timer); reject(e) }
    })
    daemon.stdin.write(encodeFrame({ ...payload, requestId }))
  })
}

ipcMain.handle('modes.list', async () => {
  await daemonReady
  return request<{ modes: unknown[] }>({ cmd: 'modes.list' })
})

ipcMain.handle('conversation.list', async () => {
  await daemonReady
  return request<{ conversations: unknown[]; conversationId: string }>({ cmd: 'conversation.list' })
})

ipcMain.handle('conversation.history', async (_e, conversationId?: string) => {
  await daemonReady
  if (conversationId !== undefined && typeof conversationId !== 'string') throw new Error('非法会话 ID')
  return request<{ messages: unknown[]; conversationId: string }>(
    conversationId ? { cmd: 'conversation.history', conversationId } : { cmd: 'conversation.history' }
  )
})

ipcMain.handle('conversation.new', async (_e, input?: { title?: string; mode?: string }) => {
  await daemonReady
  return request<{ conversationId: string }>({
    cmd: 'conversation.new',
    ...(input?.title ? { title: input.title } : {}),
    ...(input?.mode ? { mode: input.mode } : {})
  })
})

ipcMain.handle('conversation.delete', async (_e, conversationId: string) => {
  await daemonReady
  if (typeof conversationId !== 'string' || !conversationId) throw new Error('非法会话 ID')
  return request<{ conversationId: string }>({ cmd: 'conversation.delete', conversationId })
})

ipcMain.handle('memory.list', async (_e, scope?: string) => {
  await daemonReady
  return request<{ items: unknown[] }>({ cmd: 'memory.list', ...(scope ? { scope } : {}) })
})

ipcMain.handle('memory.delete', async (_e, id: string) => {
  await daemonReady
  if (typeof id !== 'string' || !id) throw new Error('非法记忆 ID')
  return request<{ id: string }>({ cmd: 'memory.delete', id })
})

ipcMain.handle('conversation.send', async (_e, input: { text?: string; mode?: string; conversationId?: string }) => {
  await daemonReady
  if (!daemon?.stdin?.writable) throw new Error('daemon 未就绪')
  if (typeof input?.text !== 'string') throw new Error('非法输入')
  if (input.mode !== undefined && typeof input.mode !== 'string') throw new Error('非法模式')
  if (input.conversationId !== undefined && typeof input.conversationId !== 'string') {
    throw new Error('非法会话 ID')
  }
  // client_request_id 由渲染进程生成,主进程原样透传以支持幂等重发
  daemon.stdin.write(
    encodeFrame({
      text: input.text,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      clientRequestId: `main-${Date.now()}-${++seq}`
    })
  )
})

function attachDaemonOutput() {
  const decoder = new FrameDecoder()
  daemon!.stdout!.on('data', (chunk: Buffer) => {
    let frames: unknown[]
    try {
      frames = decoder.push(chunk)
    } catch (err) {
      console.error('[main] 帧解析失败:', (err as Error).message)
      daemon?.kill()
      rejectReady?.(new Error(`帧解析失败: ${(err as Error).message}`))
      return
    }

    for (const frame of frames) {
      const event = frame as DaemonEvent

      if (!handshakeOk) {
        try {
          assertHello(event)
          handshakeOk = true
          continue
        } catch (err) {
          console.error('[main] 握手失败:', (err as Error).message)
          daemon?.kill()
          rejectReady?.(new Error(`协议版本不一致: ${(err as Error).message}`))
          return
        }
      }

      if (event.type === 'ready') {
        resolveReady?.()
        resolveReady = null
        win?.webContents.send('agent.event', event)
        continue
      }
      const entry = event.requestId ? pending.get(event.requestId) : undefined
      if (entry && event.requestId) {
        pending.delete(event.requestId)
        entry.resolve(event)
        continue
      }
      win?.webContents.send('agent.event', event)
    }
  })

  daemon!.stdout!.on('end', () => {
    try {
      decoder.finish()
    } catch (err) {
      console.error('[main] 流结束时仍有残留帧:', (err as Error).message)
    }
  })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

function startDaemon() {
  const entry = process.env.OPENWB_DAEMON_ENTRY
  if (!entry) throw new Error('缺少 OPENWB_DAEMON_ENTRY,daemon 未构建')
  daemon = spawn(process.execPath, [path.resolve(entry)], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      OPENWB_DATA_DIR: resolveDataDir(),
      OPENWB_PROTOCOL: String(PROTOCOL_VERSION)
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const timer = setTimeout(() => {
    rejectReady?.(new Error('daemon 启动超时(15s)'))
  }, 15_000)
  void daemonReady.then(() => clearTimeout(timer), () => clearTimeout(timer))
  daemon.stderr?.on('data', (b) => console.error('[daemon]', b.toString().trimEnd()))
  daemon.on('exit', (code) => {
    rejectReady?.(new Error(`daemon 退出: ${code}`))
    console.error(`[daemon] exited: ${code}`)
  })
  attachDaemonOutput()
}

app.whenReady().then(() => {
  startDaemon()
  createWindow()
})

app.on('window-all-closed', () => {
  daemon?.kill()
  if (process.platform !== 'darwin') app.quit()
})
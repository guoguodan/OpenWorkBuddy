import { app, BrowserWindow, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import path from 'node:path'

app.setName('OpenWorkBuddy')

let win: BrowserWindow | null = null
let daemon: ReturnType<typeof spawn> | null = null

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

function request<T>(payload: Record<string, unknown>, timeoutMs = 5000): Promise<T> {
  const requestId = `req-${++seq}`
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error('daemon 请求超时'))
    }, timeoutMs)
    pending.set(requestId, {
      resolve: (v) => { clearTimeout(timer); resolve(v as T) },
      reject: (e) => { clearTimeout(timer); reject(e) }
    })
    daemon!.stdin!.write(JSON.stringify({ ...payload, requestId }) + '\n')
  })
}

ipcMain.handle('modes.list', async () => {
  await daemonReady
  return request<{ modes: unknown[] }>({ cmd: 'modes.list' })
})

ipcMain.handle('conversation.send', async (_e, input: { text?: string; mode?: string }) => {
  await daemonReady
  if (!daemon?.stdin?.writable) throw new Error('daemon 未就绪')
  if (typeof input?.text !== 'string') throw new Error('非法输入')
  if (input.mode !== undefined && typeof input.mode !== 'string') throw new Error('非法模式')
  const payload = input.mode ? { text: input.text, mode: input.mode } : { text: input.text }
  daemon.stdin.write(JSON.stringify(payload) + '\n')
})

function attachDaemonOutput() {
  let buffer = ''
  daemon!.stdout!.setEncoding('utf8')
  daemon!.stdout!.on('data', (chunk: string) => {
    buffer += chunk
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      try {
        const event = JSON.parse(line) as DaemonEvent
        if (event.type === 'ready') {
          resolveReady?.()
          resolveReady = null
          continue
        }
        const entry = event.requestId ? pending.get(event.requestId) : undefined
        if (entry && event.requestId) {
          pending.delete(event.requestId)
          entry.resolve(event)
          continue
        }
        win?.webContents.send('agent.event', event)
      } catch {
        console.error('[main] 丢弃非法事件帧:', line.slice(0, 200))
      }
    }
    if (buffer.length > 1_000_000) buffer = ''
  })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
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
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const timer = setTimeout(() => {
    rejectReady?.(new Error('daemon 启动超时(10s)'))
  }, 10_000)
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

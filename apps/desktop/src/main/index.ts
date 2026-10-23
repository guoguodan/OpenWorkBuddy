import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { FrameDecoder, assertHello, encodeFrame, PROTOCOL_VERSION } from '@openwb/protocol'
import { openExternal, openHtmlPreview, openImagePreview, openWithSystem, resolvePreview, type PreviewTarget } from './preview.js'

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

let resolvedWorkspace: string | null = null

ipcMain.handle('workspace.info', async () => {
  await daemonReady
  return { path: resolvedWorkspace ?? resolveWorkspace() }
})

ipcMain.handle('workspace.open', async () => {
  await daemonReady
  const target = resolvedWorkspace ?? resolveWorkspace()
  await shell.openPath(target)
  return { path: target }
})

ipcMain.handle('modes.list', async () => {
  await daemonReady
  return request<{ modes: unknown[] }>({ cmd: 'modes.list' })
})

ipcMain.handle('skills.list', async () => {
  await daemonReady
  return request<{ skills: unknown[]; issues: unknown[] }>({ cmd: 'skills.list' })
})

ipcMain.handle('conversation.list', async () => {
  await daemonReady
  return request<{ conversations: unknown[]; conversationId: string }>({ cmd: 'conversation.list' })
})

ipcMain.handle('conversation.history', async (_e, conversationId?: string) => {
  await daemonReady
  if (conversationId !== undefined && typeof conversationId !== 'string') throw new Error('非法会话 ID')
  return request<{ messages: unknown[]; artifacts: unknown[]; conversationId: string }>(
    conversationId ? { cmd: 'conversation.history', conversationId } : { cmd: 'conversation.history' }
  )
})

ipcMain.handle('artifact.preview', async (_e, input: PreviewTarget & { confirmedUrl?: boolean }) => {
  await daemonReady
  if (!input || typeof input.kind !== 'string') throw new Error('非法预览请求')
  const workspace = resolvedWorkspace ?? resolveWorkspace()
  const resolved = await resolvePreview(workspace, input, { confirmedUrl: input.confirmedUrl === true })
  const title = typeof input.title === 'string' && input.title ? input.title : '预览'
  switch (resolved.mode) {
    case 'html-window':
      await openHtmlPreview(resolved.absolutePath!, title, resolved.csp)
      break
    case 'image-window':
      await openImagePreview(resolved.absolutePath!, title)
      break
    case 'browser':
      await openExternal(resolved.url!)
      break
    case 'system':
      await openWithSystem(resolved.absolutePath!)
      break
  }
  return resolved
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

ipcMain.handle('plugins.list', async () => {
  await daemonReady
  return request<{ plugins: unknown[] }>({ cmd: 'plugins.list' })
})

ipcMain.handle('plugins.install', async (_e, input: { sourceDir?: string; confirmShell?: boolean }) => {
  await daemonReady
  if (typeof input?.sourceDir !== 'string' || !input.sourceDir) throw new Error('缺少插件目录')
  // 安装要复制并启动子进程,10s 默认超时不够
  return request<{ plugin: unknown }>(
    { cmd: 'plugins.install', sourceDir: input.sourceDir, ...(input.confirmShell ? { confirmShell: true } : {}) },
    120_000
  )
})

ipcMain.handle('plugins.uninstall', async (_e, name: string) => {
  await daemonReady
  if (typeof name !== 'string' || !name) throw new Error('非法插件名')
  return request<{ name: string }>({ cmd: 'plugins.uninstall', name })
})

ipcMain.handle('plugins.retry', async (_e, name: string) => {
  await daemonReady
  if (typeof name !== 'string' || !name) throw new Error('非法插件名')
  return request<{ plugin: unknown }>({ cmd: 'plugins.retry', name }, 60_000)
})

ipcMain.handle('plugins.probe', async (_e, name: string) => {
  await daemonReady
  if (typeof name !== 'string' || !name) throw new Error('非法插件名')
  return request<{ ok: boolean; tools: number; error?: string }>({ cmd: 'plugins.probe', name }, 60_000)
})

ipcMain.handle(
  'plugins.setEnabled',
  async (_e, input: { name?: string; enabled?: boolean; confirmShell?: boolean }) => {
    await daemonReady
    if (typeof input?.name !== 'string' || !input.name) throw new Error('非法插件名')
    if (typeof input.enabled !== 'boolean') throw new Error('缺少 enabled')
    return request<{ plugin: unknown }>(
      {
        cmd: 'plugins.setEnabled',
        name: input.name,
        enabled: input.enabled,
        ...(input.confirmShell ? { confirmShell: true } : {})
      },
      60_000
    )
  }
)

ipcMain.handle('plugins.pickDir', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择插件目录(需包含 plugin.json)',
    properties: ['openDirectory']
  })
  return { path: result.canceled ? null : (result.filePaths[0] ?? null) }
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
        const ws = (event as { workspace?: unknown }).workspace
        if (typeof ws === 'string' && ws) resolvedWorkspace = ws
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

/** 桌面端由 apps/desktop 启动,资源目录相对构建产物上溯到仓库根 */
function resolveBundleRoot(): string {
  if (process.env.OPENWB_BUNDLE_ROOT) return path.resolve(process.env.OPENWB_BUNDLE_ROOT)
  // __dirname = <root>/apps/desktop/out/main
  return path.resolve(__dirname, '../../../..')
}

/** 没有显式工作区时,给用户一个可写且有意义的默认目录,而不是应用安装目录 */
function resolveWorkspace(): string {
  if (process.env.OPENWB_WORKSPACE) return path.resolve(process.env.OPENWB_WORKSPACE)
  return path.join(app.getPath('documents'), 'OpenWorkBuddy')
}

function startDaemon() {
  const entry = process.env.OPENWB_DAEMON_ENTRY
  if (!entry) throw new Error('缺少 OPENWB_DAEMON_ENTRY,daemon 未构建')
  const bundleRoot = resolveBundleRoot()
  daemon = spawn(process.execPath, [path.resolve(entry)], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      OPENWB_DATA_DIR: resolveDataDir(),
      OPENWB_PROTOCOL: String(PROTOCOL_VERSION),
      // daemon 的 cwd 是 Electron 的 cwd,不能拿它当工作区;
      // 这里显式下发,避免打包后资源和数据库落到应用安装目录。
      OPENWB_WORKSPACE: resolveWorkspace(),
      OPENWB_MODES_DIR: path.join(bundleRoot, 'resources/modes'),
      OPENWB_PROMPTS_DIR: path.join(bundleRoot, 'resources/prompts'),
      OPENWB_BUNDLED_SKILLS_DIR: path.join(bundleRoot, 'resources/skills')
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

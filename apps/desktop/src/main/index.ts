import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { FrameDecoder, assertHello, encodeFrame, PROTOCOL_VERSION } from '@openwb/protocol'
import { openExternal, openHtmlPreview, openImagePreview, openWithSystem, resolvePreview, type PreviewTarget } from './preview.js'
import { listWorkspaceFiles } from './workspace-files.js'

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

ipcMain.handle('workspace.files', async (_e, input?: { limit?: number; maxDepth?: number }) => {
  await daemonReady
  const target = resolvedWorkspace ?? resolveWorkspace()
  const limit = typeof input?.limit === 'number' ? input.limit : undefined
  const maxDepth = typeof input?.maxDepth === 'number' ? input.maxDepth : undefined
  const files = await listWorkspaceFiles(target, {
    ...(limit !== undefined ? { limit } : {}),
    ...(maxDepth !== undefined ? { maxDepth } : {})
  })
  return { workspace: target, files }
})

ipcMain.handle('modes.list', async () => {
  await daemonReady
  return request<{ modes: unknown[] }>({ cmd: 'modes.list' })
})

ipcMain.handle('search.query', async (_e, query: string) => {
  await daemonReady
  if (typeof query !== 'string') throw new Error('非法搜索词')
  return request<{ query: string; groups: unknown[] }>({ cmd: 'search.query', query })
})

ipcMain.handle('skills.list', async () => {
  await daemonReady
  return request<{ skills: unknown[]; issues: unknown[] }>({ cmd: 'skills.list' })
})

ipcMain.handle('skills.setEnabled', async (_e, input: { name?: string; enabled?: boolean }) => {
  await daemonReady
  if (!input || typeof input.name !== 'string' || !input.name.trim()) throw new Error('缺少技能名')
  if (typeof input.enabled !== 'boolean') throw new Error('enabled 必须是布尔值')
  return request<{ skills: unknown[]; issues: unknown[] }>({
    cmd: 'skills.setEnabled',
    name: input.name,
    enabled: input.enabled
  })
})

ipcMain.handle('skills.pin', async (_e, input: { name?: string; pinned?: boolean }) => {
  await daemonReady
  if (!input || typeof input.name !== 'string' || !input.name.trim()) throw new Error('缺少技能名')
  if (typeof input.pinned !== 'boolean') throw new Error('pinned 必须是布尔值')
  return request<{ settings: unknown }>({ cmd: 'skills.pin', name: input.name, pinned: input.pinned })
})

ipcMain.handle('skills.uninstall', async (_e, name: string) => {
  await daemonReady
  if (typeof name !== 'string' || !name.trim()) throw new Error('缺少技能名')
  return request<{ removed: string; path: string }>({ cmd: 'skills.uninstall', name })
})

ipcMain.handle('skills.import', async (_e, input: { sourceDir?: string }) => {
  await daemonReady
  const sourceDir = input?.sourceDir
  if (typeof sourceDir !== 'string' || !sourceDir.trim()) throw new Error('缺少技能目录')
  return request<{ imported: string; path: string }>({ cmd: 'skills.import', sourceDir }, 30_000)
})

ipcMain.handle('skills.pickDir', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择技能目录(需包含 SKILL.md)',
    properties: ['openDirectory']
  })
  return { path: result.canceled ? null : (result.filePaths[0] ?? null) }
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

ipcMain.handle('conversation.new', async (_e, input?: { title?: string; mode?: string; channelId?: string; colleagueId?: string; projectId?: string; expertId?: string }) => {
  await daemonReady
  return request<{ conversationId: string }>({
    cmd: 'conversation.new',
    ...(input?.title ? { title: input.title } : {}),
    ...(input?.mode ? { mode: input.mode } : {}),
    ...(input?.channelId ? { channelId: input.channelId } : {}),
    ...(input?.colleagueId ? { colleagueId: input.colleagueId } : {}),
    ...(input?.projectId ? { projectId: input.projectId } : {}),
    ...(input?.expertId ? { expertId: input.expertId } : {})
  })
})

ipcMain.handle('conversation.pin', async (_e, input: { conversationId: string; pinned: boolean }) => {
  await daemonReady
  if (!input || typeof input.conversationId !== 'string' || !input.conversationId) throw new Error('非法会话 ID')
  if (typeof input.pinned !== 'boolean') throw new Error('非法置顶参数')
  return request<{ conversationId: string; pinnedAt: string | null }>({
    cmd: 'conversation.pin',
    conversationId: input.conversationId,
    pinned: input.pinned
  })
})

ipcMain.handle('conversation.reorderPinned', async (_e, orderedIds: string[]) => {
  await daemonReady
  if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== 'string' || !id)) {
    throw new Error('非法置顶排序')
  }
  return request<{ orderedIds: string[] }>({ cmd: 'conversation.reorderPinned', orderedIds })
})

ipcMain.handle('conversation.rename', async (_e, input: { conversationId: string; title: string }) => {
  await daemonReady
  if (!input || typeof input.conversationId !== 'string' || !input.conversationId) throw new Error('非法会话 ID')
  if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('任务标题不能为空')
  return request<{ conversationId: string; title: string }>({
    cmd: 'conversation.rename',
    conversationId: input.conversationId,
    title: input.title.trim()
  })
})

ipcMain.handle('channel.list', async () => {
  await daemonReady
  return request<{ channels: unknown[] }>({ cmd: 'channel.list' })
})

ipcMain.handle('channel.create', async (_e, input: { name: string; description?: string }) => {
  await daemonReady
  if (!input || typeof input.name !== 'string' || !input.name.trim()) throw new Error('非法频道名')
  return request<{ channel: unknown }>({
    cmd: 'channel.create',
    name: input.name,
    ...(typeof input.description === 'string' ? { description: input.description } : {})
  })
})

ipcMain.handle('channel.delete', async (_e, channelId: string) => {
  await daemonReady
  if (typeof channelId !== 'string' || !channelId) throw new Error('非法频道 ID')
  return request<{ channelId: string }>({ cmd: 'channel.delete', channelId })
})

ipcMain.handle('channel.artifacts', async (_e, channelId: string) => {
  await daemonReady
  if (typeof channelId !== 'string' || !channelId) throw new Error('非法频道 ID')
  return request<{ channelId: string; artifacts: unknown[] }>({ cmd: 'channel.artifacts', channelId })
})

ipcMain.handle('channel.shareArtifact', async (_e, input: { channelId: string; artifactId: string }) => {
  await daemonReady
  if (!input || typeof input.channelId !== 'string' || typeof input.artifactId !== 'string') {
    throw new Error('非法共享请求')
  }
  return request<{ channelId: string; shared: boolean; artifacts: unknown[] }>({
    cmd: 'channel.shareArtifact',
    channelId: input.channelId,
    artifactId: input.artifactId
  })
})

ipcMain.handle('sync.status', async () => {
  await daemonReady
  return request<Record<string, unknown>>({ cmd: 'sync.status' })
})

ipcMain.handle('sync.flush', async (_e, input?: { retryFailed?: boolean }) => {
  await daemonReady
  return request<Record<string, unknown>>({
    cmd: 'sync.flush',
    ...(input?.retryFailed === true ? { retryFailed: true } : {})
  }, 30_000)
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

ipcMain.handle('settings.get', async () => {
  await daemonReady
  return request<Record<string, unknown>>({ cmd: 'settings.get' })
})

ipcMain.handle('settings.set', async (_e, input: { key?: string; value?: string | null }) => {
  await daemonReady
  if (!input || typeof input.key !== 'string') throw new Error('缺少设置项')
  if (input.value !== null && typeof input.value !== 'string') throw new Error('非法设置值')
  return request<Record<string, unknown>>({ cmd: 'settings.set', key: input.key, value: input.value ?? null })
})

ipcMain.handle('library.list', async (_e, input?: { limit?: number }) => {
  await daemonReady
  return request<{ items: unknown[] }>({
    cmd: 'library.list',
    ...(typeof input?.limit === 'number' ? { limit: input.limit } : {})
  })
})

ipcMain.handle('colleagues.list', async () => {
  await daemonReady
  return request<{ colleagues: unknown[] }>({ cmd: 'colleagues.list' })
})

ipcMain.handle('colleagues.create', async (_e, input: Record<string, unknown>) => {
  await daemonReady
  if (!input || typeof input.name !== 'string' || !input.name.trim()) throw new Error('缺少助理名称')
  return request<{ colleague: unknown }>({ cmd: 'colleagues.create', ...input })
})

ipcMain.handle('colleagues.update', async (_e, input: Record<string, unknown>) => {
  await daemonReady
  if (!input || typeof input.id !== 'string') throw new Error('缺少助理 ID')
  return request<{ colleague: unknown }>({ cmd: 'colleagues.update', ...input })
})

ipcMain.handle('colleagues.delete', async (_e, id: string) => {
  await daemonReady
  if (typeof id !== 'string' || !id) throw new Error('非法助理 ID')
  return request<{ id: string; removed: boolean }>({ cmd: 'colleagues.delete', id })
})

ipcMain.handle('colleagues.tasks', async (_e, id: string) => {
  await daemonReady
  if (typeof id !== 'string' || !id) throw new Error('非法助理 ID')
  return request<{ colleagueId: string; tasks: unknown[] }>({ cmd: 'colleagues.tasks', id })
})

ipcMain.handle('projects.list', async () => {
  await daemonReady
  return request<{ projects: unknown[] }>({ cmd: 'projects.list' })
})

ipcMain.handle('projects.create', async (_e, input: Record<string, unknown>) => {
  await daemonReady
  if (!input || typeof input.name !== 'string' || !input.name.trim()) throw new Error('缺少项目名称')
  return request<{ project: unknown }>({ cmd: 'projects.create', ...input })
})

ipcMain.handle('projects.update', async (_e, input: Record<string, unknown>) => {
  await daemonReady
  if (!input || typeof input.id !== 'string') throw new Error('缺少项目 ID')
  return request<{ project: unknown }>({ cmd: 'projects.update', ...input })
})

ipcMain.handle('projects.delete', async (_e, id: string) => {
  await daemonReady
  if (typeof id !== 'string' || !id) throw new Error('非法项目 ID')
  return request<{ id: string; removed: boolean }>({ cmd: 'projects.delete', id })
})

ipcMain.handle('projects.tasks', async (_e, id: string) => {
  await daemonReady
  if (typeof id !== 'string' || !id) throw new Error('非法项目 ID')
  return request<{ projectId: string; tasks: unknown[] }>({ cmd: 'projects.tasks', id })
})

ipcMain.handle('connections.list', async () => {
  await daemonReady
  return request<{ connections: unknown[] }>({ cmd: 'connections.list' })
})

ipcMain.handle('connections.set', async (_e, input: Record<string, unknown>) => {
  await daemonReady
  if (!input || typeof input.provider !== 'string') throw new Error('缺少服务类型')
  return request<{ connection: unknown }>({ cmd: 'connections.set', ...input })
})

ipcMain.handle('connections.disconnect', async (_e, provider: string) => {
  await daemonReady
  if (typeof provider !== 'string' || !provider) throw new Error('缺少服务类型')
  return request<{ connection: unknown }>({ cmd: 'connections.disconnect', provider })
})

ipcMain.handle('inspiration.list', async () => {
  await daemonReady
  return request<{ posts: unknown[] }>({ cmd: 'inspiration.list' })
})

ipcMain.handle('inspiration.create', async (_e, input: Record<string, unknown>) => {
  await daemonReady
  if (!input || typeof input.title !== 'string' || !input.title.trim()) throw new Error('缺少灵感标题')
  return request<{ post: unknown }>({ cmd: 'inspiration.create', ...input })
})

ipcMain.handle('inspiration.favorite', async (_e, input: { id?: string; favorite?: boolean }) => {
  await daemonReady
  if (!input || typeof input.id !== 'string' || typeof input.favorite !== 'boolean') throw new Error('非法收藏请求')
  return request<{ post: unknown }>({ cmd: 'inspiration.favorite', id: input.id, favorite: input.favorite })
})

ipcMain.handle('inspiration.delete', async (_e, id: string) => {
  await daemonReady
  if (typeof id !== 'string' || !id) throw new Error('非法灵感 ID')
  return request<{ id: string; removed: boolean }>({ cmd: 'inspiration.delete', id })
})

ipcMain.handle(
  'automation.list',
  async () => {
    await daemonReady
    return request<{ automations: unknown[] }>({ cmd: 'automation.list' })
  }
)

ipcMain.handle('automation.create', async (_e, input: Record<string, unknown>) => {
  await daemonReady
  if (!input || typeof input.name !== 'string' || !input.name.trim()) throw new Error('缺少任务名称')
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw new Error('缺少任务指令')
  return request<{ automation: unknown }>({ cmd: 'automation.create', ...input })
})

ipcMain.handle(
  'automation.toggle',
  async (_e, input: { id?: string; enabled?: boolean }) => {
    await daemonReady
    if (!input || typeof input.id !== 'string' || !input.id) throw new Error('缺少定时任务 ID')
    if (typeof input.enabled !== 'boolean') throw new Error('缺少启用状态')
    return request<{ id: string; enabled: boolean }>({
      cmd: 'automation.toggle',
      id: input.id,
      enabled: input.enabled
    })
  }
)

ipcMain.handle('automation.delete', async (_e, id: string) => {
  await daemonReady
  if (typeof id !== 'string' || !id) throw new Error('非法定时任务 ID')
  return request<{ id: string }>({ cmd: 'automation.delete', id })
})

ipcMain.handle('automation.scan', async (_e, input?: { now?: string; startup?: boolean }) => {
  await daemonReady
  return request<{ claimed: unknown[] }>({
    cmd: 'automation.scan',
    ...(typeof input?.now === 'string' ? { now: input.now } : {}),
    ...(input?.startup === true ? { startup: true } : {})
  })
})

ipcMain.handle('approval.respond', async (_e, input: { approvalId?: string; approved?: boolean; scope?: string }) => {
  await daemonReady
  if (!daemon?.stdin?.writable) throw new Error('daemon 未就绪')
  if (typeof input?.approvalId !== 'string' || !input.approvalId) throw new Error('缺少审批 ID')
  if (typeof input.approved !== 'boolean') throw new Error('缺少审批结论')
  if (input.approved && !['once', 'session', 'always'].includes(input.scope ?? '')) {
    throw new Error('非法授权范围')
  }
  // 审批回答不能走 request():工具调用本身正阻塞在等待这个回答上。
  daemon.stdin.write(
    encodeFrame({
      cmd: 'approval.respond',
      approvalId: input.approvalId,
      approved: input.approved,
      ...(input.approved ? { scope: input.scope } : {})
    })
  )
  return { ok: true }
})

ipcMain.handle('approval.list', async () => {
  await daemonReady
  return request<{ requests: unknown[] }>({ cmd: 'approval.list' })
})

ipcMain.handle('notifications.list', async (_e, input?: { pendingOnly?: boolean; limit?: number }) => {
  await daemonReady
  return request<{ notifications: unknown[]; unread: number }>({
    cmd: 'notifications.list',
    ...(input?.pendingOnly === true ? { pendingOnly: true } : {}),
    ...(typeof input?.limit === 'number' ? { limit: input.limit } : {})
  })
})

ipcMain.handle('notifications.read', async (_e, id: string) => {
  await daemonReady
  if (typeof id !== 'string' || !id) throw new Error('非法通知 ID')
  return request<{ notification: unknown; unread: number }>({ cmd: 'notifications.read', id })
})

ipcMain.handle('notifications.readAll', async () => {
  await daemonReady
  return request<{ changed: number; unread: number }>({ cmd: 'notifications.readAll' })
})

ipcMain.handle('notifications.delete', async (_e, id: string) => {
  await daemonReady
  if (typeof id !== 'string' || !id) throw new Error('非法通知 ID')
  return request<{ id: string; removed: boolean; unread: number }>({ cmd: 'notifications.delete', id })
})

ipcMain.handle('approval.grants', async () => {
  await daemonReady
  return request<{ grants: unknown[] }>({ cmd: 'approval.grants' })
})

ipcMain.handle('approval.revoke', async (_e, groupKey: string) => {
  await daemonReady
  if (typeof groupKey !== 'string' || !groupKey) throw new Error('非法授权组')
  return request<{ groupKey: string; removed: boolean }>({ cmd: 'approval.revoke', groupKey })
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

ipcMain.handle(
  'conversation.send',
  async (
    _e,
    input: {
      text?: string
      mode?: string
      conversationId?: string
      skill?: string
      colleagueId?: string
      expertId?: string
      scene?: string
      contextPaths?: string[]
    }
  ) => {
  await daemonReady
  if (!daemon?.stdin?.writable) throw new Error('daemon 未就绪')
  if (typeof input?.text !== 'string') throw new Error('非法输入')
  if (input.mode !== undefined && typeof input.mode !== 'string') throw new Error('非法模式')
  if (input.conversationId !== undefined && typeof input.conversationId !== 'string') {
    throw new Error('非法会话 ID')
  }
  if (input.skill !== undefined && typeof input.skill !== 'string') throw new Error('非法技能')
  if (input.colleagueId !== undefined && typeof input.colleagueId !== 'string') {
    throw new Error('非法助理 ID')
  }
  if (input.expertId !== undefined && typeof input.expertId !== 'string') {
    throw new Error('非法专家 ID')
  }
  if (
    input.scene !== undefined &&
    input.scene !== 'working' &&
    input.scene !== 'coding' &&
    input.scene !== 'design'
  ) {
    throw new Error('非法场景')
  }
  if (
    input.contextPaths !== undefined &&
    (!Array.isArray(input.contextPaths) || input.contextPaths.some((x) => typeof x !== 'string'))
  ) {
    throw new Error('非法上下文路径')
  }
  // client_request_id 由渲染进程生成,主进程原样透传以支持幂等重发
  daemon.stdin.write(
    encodeFrame({
      text: input.text,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.skill ? { skill: input.skill } : {}),
      ...(input.colleagueId ? { colleagueId: input.colleagueId } : {}),
      ...(input.expertId ? { expertId: input.expertId } : {}),
      ...(input.scene ? { scene: input.scene } : {}),
      ...(input.contextPaths && input.contextPaths.length > 0 ? { contextPaths: input.contextPaths } : {}),
      clientRequestId: `main-${Date.now()}-${++seq}`
    })
  )
  }
)

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
        // 安装包冒烟需要一个客观的"首屏已就绪"时刻;仅在显式传入路径时写标记。
        const readyFile = process.env.OPENWB_READY_FILE
        if (readyFile) {
          try {
            writeFileSync(
              readyFile,
              JSON.stringify({ readyAt: new Date().toISOString(), packageMode: app.isPackaged }),
              'utf8'
            )
          } catch (err) {
            console.error('[main] 写就绪标记失败:', (err as Error).message)
          }
        }
        win?.webContents.send('agent.event', event)
        // 安装包冷启动基准:ready 后按需自动退出,避免 CI 残留进程。
        const exitAfter = Number(process.env.OPENWB_SMOKE_EXIT_MS ?? 0)
        if (Number.isFinite(exitAfter) && exitAfter > 0) {
          setTimeout(() => app.quit(), exitAfter)
        }
        continue
      }
      const entry = event.requestId ? pending.get(event.requestId) : undefined
      if (entry && event.requestId) {
        pending.delete(event.requestId)
        // daemon 的业务失败也带 requestId:必须沿 IPC 语义 reject,
        // 否则调用方会把"排序被拒绝"当成成功。
        if (event.type === 'error') {
          const message = (event as { message?: unknown }).message
          entry.reject(new Error(typeof message === 'string' ? message : 'daemon 请求失败'))
        } else {
          entry.resolve(event)
        }
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
  // 页面内已经有完整的中文菜单栏;移除 Electron 默认菜单,避免出现两套按钮。
  Menu.setApplicationMenu(null)
  win.setMenuBarVisibility(false)
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
  // 审批必须赶在第一次工具调用前声明就绪;否则 daemon 会 fail-closed。
  win.webContents.on('did-finish-load', () => {
    void daemonReady.then(() => {
      if (daemon?.stdin?.writable) daemon.stdin.write(encodeFrame({ cmd: 'approval.ready' }))
    })
  })
}

/** 桌面端由 apps/desktop 启动,资源目录相对构建产物上溯到仓库根 */
function resolveBundleRoot(): string {
  if (process.env.OPENWB_BUNDLE_ROOT) return path.resolve(process.env.OPENWB_BUNDLE_ROOT)
  // 打包态:<install>/resources 下同时放 resources/{modes,prompts,skills}。
  if (app.isPackaged) return process.resourcesPath
  // __dirname = <root>/apps/desktop/out/main
  return path.resolve(__dirname, '../../../..')
}

/** 没有显式工作区时,给用户一个可写且有意义的默认目录,而不是应用安装目录 */
function resolveWorkspace(): string {
  if (process.env.OPENWB_WORKSPACE) return path.resolve(process.env.OPENWB_WORKSPACE)
  return path.join(app.getPath('documents'), 'OpenWorkBuddy')
}

function startDaemon() {
  // 打包态 daemon 与运行依赖都在 resources/daemon 下,不依赖用户工作目录。
  // daemon 以 Electron 的 Node 运行时启动,但入口必须是普通文件:asar 内的
  // 原生模块与子进程脚本无法被 require/import 正确解析。
  const entry =
    process.env.OPENWB_DAEMON_ENTRY ??
    (app.isPackaged ? path.join(process.resourcesPath, 'daemon', 'dist', 'index.js') : undefined)
  if (!entry) throw new Error('缺少 OPENWB_DAEMON_ENTRY,daemon 未构建')
  const bundleRoot = resolveBundleRoot()
  const cwd = app.isPackaged ? path.dirname(entry) : resolveWorkspace()
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
      OPENWB_BUNDLED_SKILLS_DIR: path.join(bundleRoot, 'resources/skills'),
      OPENWB_WORKFLOWS_DIR: path.join(bundleRoot, 'resources/workflows')
    },
    cwd,
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
  // 单实例锁:安装包被重复点击时不能再起一套 daemon 与工作区。
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  startDaemon()
  createWindow()
})

app.on('window-all-closed', () => {
  daemon?.kill()
  if (process.platform !== 'darwin') app.quit()
})

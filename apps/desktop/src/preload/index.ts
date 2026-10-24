import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('openwb', {
  modes: {
    list: () => ipcRenderer.invoke('modes.list')
  },
  skills: {
    list: () => ipcRenderer.invoke('skills.list'),
    setEnabled: (input: unknown) => ipcRenderer.invoke('skills.setEnabled', input),
    pin: (input: unknown) => ipcRenderer.invoke('skills.pin', input),
    uninstall: (name: string) => ipcRenderer.invoke('skills.uninstall', name),
    importDirectory: (sourceDir: string) => ipcRenderer.invoke('skills.import', { sourceDir }),
    pickDir: () => ipcRenderer.invoke('skills.pickDir')
  },
  search: {
    query: (query: string) => ipcRenderer.invoke('search.query', query)
  },
  attachments: {
    pick: () => ipcRenderer.invoke('attachment.pick'),
    importPaths: (paths: string[]) => ipcRenderer.invoke('attachment.importPaths', { paths }),
    importData: (files: Array<{ name: string; data: ArrayBuffer | Uint8Array }>) =>
      ipcRenderer.invoke('attachment.importData', { files })
  },  workspace: {
    info: () => ipcRenderer.invoke('workspace.info'),
    open: () => ipcRenderer.invoke('workspace.open'),
    files: (input?: unknown) => ipcRenderer.invoke('workspace.files', input),
    reveal: (input: unknown) => ipcRenderer.invoke('workspace.reveal', input)
  },
  plugins: {
    list: () => ipcRenderer.invoke('plugins.list'),
    install: (input: unknown) => ipcRenderer.invoke('plugins.install', input),
    uninstall: (name: string) => ipcRenderer.invoke('plugins.uninstall', name),
    retry: (name: string) => ipcRenderer.invoke('plugins.retry', name),
    probe: (name: string) => ipcRenderer.invoke('plugins.probe', name),
    setEnabled: (input: unknown) => ipcRenderer.invoke('plugins.setEnabled', input),
    pickDir: () => ipcRenderer.invoke('plugins.pickDir')
  },
  conversation: {
    send: (input: unknown) => ipcRenderer.invoke('conversation.send', input),
    cancel: (conversationId?: string) => ipcRenderer.invoke('conversation.cancel', conversationId),
    list: () => ipcRenderer.invoke('conversation.list'),
    history: (conversationId?: string) => ipcRenderer.invoke('conversation.history', conversationId),
    create: (input?: unknown) => ipcRenderer.invoke('conversation.new', input),
    pin: (input: { conversationId: string; pinned: boolean }) => ipcRenderer.invoke('conversation.pin', input),
    reorderPinned: (orderedIds: string[]) => ipcRenderer.invoke('conversation.reorderPinned', orderedIds),
    rename: (input: { conversationId: string; title: string }) => ipcRenderer.invoke('conversation.rename', input),
    feedback: (input: { messageId: string; feedback: 'like' | 'dislike' | null; reason?: string }) =>
      ipcRenderer.invoke('message.feedback', input),
    replay: (input: { conversationId: string; messageId: string }) =>
      ipcRenderer.invoke('conversation.replay', input),
    revert: (input: { conversationId: string; messageId: string }) =>
      ipcRenderer.invoke('conversation.revert', input),
    remove: (conversationId: string) => ipcRenderer.invoke('conversation.delete', conversationId),
    onEvent: (cb: (e: unknown) => void) => {
      const handler = (_: unknown, e: unknown) => cb(e)
      ipcRenderer.on('agent.event', handler)
      return () => ipcRenderer.removeListener('agent.event', handler)
    }
  },
  voice: {
    transcribe: (input: { data: string; mimeType: string; durationMs?: number }) =>
      ipcRenderer.invoke('voice.transcribe', input)
  },
  automation: {
    list: () => ipcRenderer.invoke('automation.list'),
    create: (input: unknown) => ipcRenderer.invoke('automation.create', input),
    toggle: (input: unknown) => ipcRenderer.invoke('automation.toggle', input),
    remove: (id: string) => ipcRenderer.invoke('automation.delete', id),
    scan: (input?: unknown) => ipcRenderer.invoke('automation.scan', input)
  },
  workflow: {
    list: () => ipcRenderer.invoke('workflow.list'),
    runs: (input?: unknown) => ipcRenderer.invoke('workflow.runs', input),
    run: (input: unknown) => ipcRenderer.invoke('workflow.run', input),
    resume: (input: unknown) => ipcRenderer.invoke('workflow.resume', input),
    cancel: (runId: string) => ipcRenderer.invoke('workflow.cancel', runId)
  },
  artifact: {
    preview: (input: unknown) => ipcRenderer.invoke('artifact.preview', input),
    read: (input: unknown) => ipcRenderer.invoke('artifact.read', input),
    document: (input: unknown) => ipcRenderer.invoke('artifact.document', input),
    share: (input: unknown) => ipcRenderer.invoke('channel.shareArtifact', input),
    rename: (input: unknown) => ipcRenderer.invoke('artifact.rename', input),
    remove: (input: unknown) => ipcRenderer.invoke('artifact.remove', input),
    reveal: (input: unknown) => ipcRenderer.invoke('artifact.reveal', input)
  },
  channel: {
    list: () => ipcRenderer.invoke('channel.list'),
    create: (input: unknown) => ipcRenderer.invoke('channel.create', input),
    remove: (channelId: string) => ipcRenderer.invoke('channel.delete', channelId),
    artifacts: (channelId: string) => ipcRenderer.invoke('channel.artifacts', channelId)
  },
  sync: {
    status: () => ipcRenderer.invoke('sync.status'),
    flush: (input?: unknown) => ipcRenderer.invoke('sync.flush', input)
  },
  memory: {
    list: (scope?: string) => ipcRenderer.invoke('memory.list', scope),
    remove: (id: string) => ipcRenderer.invoke('memory.delete', id)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings.get'),
    set: (input: unknown) => ipcRenderer.invoke('settings.set', input)
  },
  models: {
    list: () => ipcRenderer.invoke('models.list')
  },
  library: {
    list: (input?: unknown) => ipcRenderer.invoke('library.list', input)
  },
  colleagues: {
    list: () => ipcRenderer.invoke('colleagues.list'),
    create: (input: unknown) => ipcRenderer.invoke('colleagues.create', input),
    update: (input: unknown) => ipcRenderer.invoke('colleagues.update', input),
    remove: (id: string) => ipcRenderer.invoke('colleagues.delete', id),
    tasks: (id: string) => ipcRenderer.invoke('colleagues.tasks', id)
  },
  projects: {
    list: () => ipcRenderer.invoke('projects.list'),
    create: (input: unknown) => ipcRenderer.invoke('projects.create', input),
    update: (input: unknown) => ipcRenderer.invoke('projects.update', input),
    remove: (id: string) => ipcRenderer.invoke('projects.delete', id),
    tasks: (id: string) => ipcRenderer.invoke('projects.tasks', id)
  },
  connections: {
    list: () => ipcRenderer.invoke('connections.list'),
    set: (input: unknown) => ipcRenderer.invoke('connections.set', input),
    disconnect: (provider: string) => ipcRenderer.invoke('connections.disconnect', provider)
  },
  inspiration: {
    list: () => ipcRenderer.invoke('inspiration.list'),
    create: (input: unknown) => ipcRenderer.invoke('inspiration.create', input),
    favorite: (input: unknown) => ipcRenderer.invoke('inspiration.favorite', input),
    remove: (id: string) => ipcRenderer.invoke('inspiration.delete', id)
  },
  approval: {
    respond: (input: unknown) => ipcRenderer.invoke('approval.respond', input),
    list: () => ipcRenderer.invoke('approval.list'),
    grants: () => ipcRenderer.invoke('approval.grants'),
    revoke: (groupKey: string) => ipcRenderer.invoke('approval.revoke', groupKey)
  },
  notifications: {
    list: (input?: unknown) => ipcRenderer.invoke('notifications.list', input),
    read: (id: string) => ipcRenderer.invoke('notifications.read', id),
    readAll: () => ipcRenderer.invoke('notifications.readAll'),
    remove: (id: string) => ipcRenderer.invoke('notifications.delete', id)
  }
})

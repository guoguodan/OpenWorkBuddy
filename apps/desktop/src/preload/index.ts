import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('openwb', {
  modes: {
    list: () => ipcRenderer.invoke('modes.list')
  },
  skills: {
    list: () => ipcRenderer.invoke('skills.list')
  },
  search: {
    query: (query: string) => ipcRenderer.invoke('search.query', query)
  },
  workspace: {
    info: () => ipcRenderer.invoke('workspace.info'),
    open: () => ipcRenderer.invoke('workspace.open')
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
    list: () => ipcRenderer.invoke('conversation.list'),
    history: (conversationId?: string) => ipcRenderer.invoke('conversation.history', conversationId),
    create: (input?: unknown) => ipcRenderer.invoke('conversation.new', input),
    remove: (conversationId: string) => ipcRenderer.invoke('conversation.delete', conversationId),
    onEvent: (cb: (e: unknown) => void) => {
      const handler = (_: unknown, e: unknown) => cb(e)
      ipcRenderer.on('agent.event', handler)
      return () => ipcRenderer.removeListener('agent.event', handler)
    }
  },
  automation: {
    list: () => ipcRenderer.invoke('automation.list'),
    create: (input: unknown) => ipcRenderer.invoke('automation.create', input),
    toggle: (input: unknown) => ipcRenderer.invoke('automation.toggle', input),
    remove: (id: string) => ipcRenderer.invoke('automation.delete', id),
    scan: (input?: unknown) => ipcRenderer.invoke('automation.scan', input)
  },
  artifact: {
    preview: (input: unknown) => ipcRenderer.invoke('artifact.preview', input),
    share: (input: unknown) => ipcRenderer.invoke('channel.shareArtifact', input)
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
  library: {
    list: (input?: unknown) => ipcRenderer.invoke('library.list', input)
  },
  colleagues: {
    list: () => ipcRenderer.invoke('colleagues.list'),
    create: (input: unknown) => ipcRenderer.invoke('colleagues.create', input),
    update: (input: unknown) => ipcRenderer.invoke('colleagues.update', input),
    remove: (id: string) => ipcRenderer.invoke('colleagues.delete', id)
  },
  approval: {
    respond: (input: unknown) => ipcRenderer.invoke('approval.respond', input),
    list: () => ipcRenderer.invoke('approval.list'),
    grants: () => ipcRenderer.invoke('approval.grants'),
    revoke: (groupKey: string) => ipcRenderer.invoke('approval.revoke', groupKey)
  }
})

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('openwb', {
  modes: {
    list: () => ipcRenderer.invoke('modes.list')
  },
  skills: {
    list: () => ipcRenderer.invoke('skills.list')
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
  artifact: {
    open: (target: string) => ipcRenderer.invoke('artifact.open', target)
  },
  memory: {
    list: (scope?: string) => ipcRenderer.invoke('memory.list', scope),
    remove: (id: string) => ipcRenderer.invoke('memory.delete', id)
  }
})

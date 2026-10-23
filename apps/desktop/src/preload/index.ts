import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('openwb', {
  modes: {
    list: () => ipcRenderer.invoke('modes.list')
  },
  conversation: {
    send: (input: unknown) => ipcRenderer.invoke('conversation.send', input),
    onEvent: (cb: (e: unknown) => void) => {
      const handler = (_: unknown, e: unknown) => cb(e)
      ipcRenderer.on('agent.event', handler)
      return () => ipcRenderer.removeListener('agent.event', handler)
    }
  }
})

interface ConversationInfo {
  id: string
  title: string
  modeId: string
  updatedAt: string
  lastSeq: number
}

interface MemoryItemInfo {
  id: string
  scope: string
  kind: string
  content: string
  tokens: number
  createdAt: string
}

interface PluginToolInfo {
  name: string
  description: string
  highCredit: boolean
}

interface PluginSnapshotInfo {
  name: string
  displayName: string
  version: string
  kind: 'connector' | 'expert'
  state: 'unloaded' | 'starting' | 'ready' | 'reconnecting' | 'disabled' | 'crashed'
  enabled: boolean
  attempts: number
  lastError: string | null
  tools: PluginToolInfo[]
  pids: number[]
  warnings: string[]
  verifiedPublisher: boolean
  permissions: string[]
}

interface HistoryMessage {
  id: string
  seq: number
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: unknown
  status: string
  tokenIn: number
  tokenOut: number
  createdAt: string
}

interface ArtifactInfoLike {
  id: string
  kind: 'file' | 'html' | 'url' | 'image'
  title: string
  description?: string | null
  path?: string | null
  url?: string | null
  size?: number
  sha256?: string | null
}

interface SearchHitInfo {
  group: 'message' | 'artifact' | 'task'
  id: string
  conversationId: string
  conversationTitle: string
  seq: number | null
  title: string
  snippet: string
  role?: string
  createdAt: string
}

interface SearchGroupInfo {
  group: 'message' | 'artifact' | 'task'
  total: number
  items: SearchHitInfo[]
}

interface Window {
  openwb: {
    modes: {
      list: () => Promise<{ modes: Array<{ id: string; displayName: string; description: string }> }>
    }
    workspace: {
      info: () => Promise<{ path: string }>
      open: () => Promise<{ path: string }>
    }
    skills: {
      list: () => Promise<{
        skills: Array<{ name: string; description: string; scope: string }>
        issues: Array<{ path: string; reason: string }>
      }>
    }
    search: {
      query: (q: string) => Promise<{ query: string; groups: SearchGroupInfo[] }>
    }
    conversation: {
      send: (input: { text: string; mode?: string; conversationId?: string }) => Promise<void>
      list: () => Promise<{ conversations: ConversationInfo[]; conversationId: string }>
      history: (conversationId?: string) => Promise<{
        messages: HistoryMessage[]
        artifacts: ArtifactInfoLike[]
        conversationId: string
      }>
      create: (input?: { title?: string; mode?: string }) => Promise<{ conversationId: string }>
      remove: (conversationId: string) => Promise<{ conversationId: string }>
      onEvent: (cb: (e: unknown) => void) => () => void
    }
    memory: {
      list: (scope?: string) => Promise<{ items: MemoryItemInfo[] }>
      remove: (id: string) => Promise<{ id: string }>
    }
    artifact: {
      preview: (input: {
        kind: 'file' | 'html' | 'url' | 'image'
        path?: string
        url?: string
        title?: string
        confirmedUrl?: boolean
      }) => Promise<{ mode: string; size?: number; sha256?: string }>
    }
    plugins: {
      list: () => Promise<{ plugins: PluginSnapshotInfo[] }>
      install: (input: { sourceDir: string; confirmShell?: boolean }) => Promise<{ plugin: PluginSnapshotInfo | null }>
      uninstall: (name: string) => Promise<{ name: string }>
      retry: (name: string) => Promise<{ plugin: PluginSnapshotInfo | null }>
      probe: (name: string) => Promise<{ ok: boolean; tools: number; error?: string }>
      setEnabled: (input: {
        name: string
        enabled: boolean
        confirmShell?: boolean
      }) => Promise<{ plugin: PluginSnapshotInfo | null }>
      pickDir: () => Promise<{ path: string | null }>
    }
  }
}

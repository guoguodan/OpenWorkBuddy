interface ConversationInfo {
  id: string
  title: string
  modeId: string
  channelId?: string | null
  channelName?: string | null
  updatedAt: string
  lastSeq: number
}

interface ChannelInfo {
  id: string
  name: string
  description: string | null
  createdAt: string
  conversationCount: number
  artifacts: number
}

interface SyncStatusInfo {
  configured: boolean
  endpoint: string | null
  pending: number
  sent: number
  failed: number
  oldest: string | null
  lastError: string | null
}

interface MemoryItemInfo {
  id: string
  scope: string
  kind: string
  content: string
  tokens: number
  createdAt: string
}

interface ApprovalGrantInfo {
  id: string
  scope: string
  groupKey: string
  toolName: string
  grantedAt: string
  expiresAt: string | null
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
      create: (input?: { title?: string; mode?: string; channelId?: string }) => Promise<{ conversationId: string }>
      remove: (conversationId: string) => Promise<{ conversationId: string }>
      onEvent: (cb: (e: unknown) => void) => () => void
    }
    memory: {
      list: (scope?: string) => Promise<{ items: MemoryItemInfo[] }>
      remove: (id: string) => Promise<{ id: string }>
    }
    approval: {
      respond: (input: {
        approvalId: string
        approved: boolean
        scope?: 'once' | 'session' | 'always'
      }) => Promise<{ ok: boolean }>
      list: () => Promise<{ requests: unknown[] }>
      grants: () => Promise<{ grants: ApprovalGrantInfo[] }>
      revoke: (groupKey: string) => Promise<{ groupKey: string; removed: boolean }>
    }
    artifact: {
      preview: (input: {
        kind: 'file' | 'html' | 'url' | 'image'
        path?: string
        url?: string
        title?: string
        confirmedUrl?: boolean
      }) => Promise<{ mode: string; size?: number; sha256?: string }>
      share: (input: { channelId: string; artifactId: string }) => Promise<{
        channelId: string
        shared: boolean
        artifacts: ArtifactInfoLike[]
      }>
    }
    channel: {
      list: () => Promise<{ channels: ChannelInfo[] }>
      create: (input: { name: string; description?: string }) => Promise<{ channel: ChannelInfo }>
      remove: (channelId: string) => Promise<{ channelId: string }>
      artifacts: (channelId: string) => Promise<{ channelId: string; artifacts: ArtifactInfoLike[] }>
    }
    sync: {
      status: () => Promise<SyncStatusInfo>
      flush: (input?: { retryFailed?: boolean }) => Promise<SyncStatusInfo & {
        sentEvents: number
        sentArtifacts: number
        stopped: boolean
      }>
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

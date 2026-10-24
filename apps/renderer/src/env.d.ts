declare module '*.png' {
  const src: string
  export default src
}

declare module '*.svg' {
  const src: string
  export default src
}

interface ConversationInfo {
  id: string
  title: string
  modeId: string
  colleagueId?: string | null
  colleagueName?: string | null
  pinnedAt?: string | null
  channelId?: string | null
  channelName?: string | null
  projectId?: string | null
  projectName?: string | null
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

interface NotificationInfo {
  id: string
  workspaceId: string
  biz: 'task' | 'automation' | 'approval' | 'system'
  title: string
  summary: string
  conversationId: string | null
  actionKind: 'open-conversation' | 'none'
  isRead: boolean
  isPending: boolean
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

interface LibraryArtifactInfo {
  id: string
  kind: 'file' | 'html' | 'url' | 'image'
  title: string
  description: string | null
  path: string | null
  url: string | null
  size: number
  createdAt: string
  conversationId: string | null
  conversationTitle: string | null
  taskTitle: string | null
}

interface ColleagueInfo {
  id: string
  name: string
  title: string
  description: string
  instructions: string
  avatar: string
  skillNames: string[]
  connectorNames: string[]
  channelIds: string[]
  status: 'active' | 'paused'
  visibility: 'personal' | 'project' | 'public'
  memoryEnabled: boolean
  pinnedAt: string | null
  modeId: string
  stats: {
    conversationCount: number
    tokenUsage: number
    lastActiveAt: string | null
  }
  createdAt: string
  updatedAt: string
}

interface ColleagueInputInfo {
  name: string
  title?: string
  description?: string
  instructions?: string
  avatar?: string
  skillNames?: string[]
  connectorNames?: string[]
  channelIds?: string[]
  status?: 'active' | 'paused'
  visibility?: 'personal' | 'project' | 'public'
  memoryEnabled?: boolean
  pinned?: boolean
  modeId?: string
}

interface ProjectInfo {
  id: string
  name: string
  description: string
  instructions: string
  skillNames: string[]
  pinnedAt: string | null
  stats: { taskCount: number; lastActiveAt: string | null }
  createdAt: string
  updatedAt: string
}

interface ProjectInputInfo {
  name: string
  description?: string
  instructions?: string
  skillNames?: string[]
  pinned?: boolean
}

type ServiceProviderInfo = 'mailbox' | 'tencentDocs' | 'ima' | 'lexiang'
type ServiceStatusInfo = 'not_connected' | 'connecting' | 'connected' | 'error'

interface ServiceConnectionInfo {
  provider: ServiceProviderInfo
  status: ServiceStatusInfo
  endpoint: string | null
  account: string | null
  lastError: string | null
  lastCheckedAt: string | null
  createdAt: string
  updatedAt: string
}

interface InspirationPostInfo {
  id: string
  title: string
  body: string
  source: string
  tags: string[]
  favorite: boolean
  createdAt: string
  updatedAt: string
}

interface AutomationInfo {
  id: string
  name: string
  scheduleType: 'once' | 'rrule'
  rrule: string | null
  scheduledAt: string | null
  timezone: string
  prompt: string
  modeId: string
  enabled: boolean
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: string | null
  createdAt: string
  updatedAt: string
}

interface Window {
  openwb: {
    modes: {
      list: () => Promise<{ modes: Array<{ id: string; displayName: string; description: string }> }>
    }
    workspace: {
      info: () => Promise<{ path: string }>
      open: () => Promise<{ path: string }>
      files: (input?: { limit?: number; maxDepth?: number }) => Promise<{
        workspace: string
        files: Array<{ path: string; name: string; size: number }>
      }>
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
      send: (input: {
        text: string
        mode?: string
        conversationId?: string
        skill?: string
        colleagueId?: string
        scene?: 'working' | 'coding' | 'design'
        contextPaths?: string[]
      }) => Promise<void>
      list: () => Promise<{ conversations: ConversationInfo[]; conversationId: string }>
      history: (conversationId?: string) => Promise<{
        messages: HistoryMessage[]
        artifacts: ArtifactInfoLike[]
        conversationId: string
      }>
      create: (input?: {
        title?: string
        mode?: string
        channelId?: string
        colleagueId?: string
        projectId?: string
      }) => Promise<{ conversationId: string }>
      pin: (input: { conversationId: string; pinned: boolean }) => Promise<{
        conversationId: string
        pinnedAt: string | null
      }>
      rename: (input: { conversationId: string; title: string }) => Promise<{
        conversationId: string
        title: string
      }>
      remove: (conversationId: string) => Promise<{ conversationId: string }>
      onEvent: (cb: (e: unknown) => void) => () => void
    }
    memory: {
      list: (scope?: string) => Promise<{ items: MemoryItemInfo[] }>
      remove: (id: string) => Promise<{ id: string }>
    }
    settings: {
      get: () => Promise<{
        settings: { permissionMode: 'default' | 'fullAccess' | 'readOnly'; taskTarget: 'local'; model: string | null }
        workspace: string
        model: string
      }>
      set: (input: { key: 'permissionMode' | 'taskTarget' | 'model'; value: string | null }) => Promise<{
        settings: { permissionMode: 'default' | 'fullAccess' | 'readOnly'; taskTarget: 'local'; model: string | null }
      }>
    }
    library: {
      list: (input?: { limit?: number }) => Promise<{ items: LibraryArtifactInfo[] }>
    }
    colleagues: {
      list: () => Promise<{ colleagues: ColleagueInfo[] }>
      create: (input: ColleagueInputInfo) => Promise<{ colleague: ColleagueInfo }>
      update: (input: Partial<ColleagueInputInfo> & { id: string }) => Promise<{ colleague: ColleagueInfo }>
      remove: (id: string) => Promise<{ id: string; removed: boolean }>
    }
    projects: {
      list: () => Promise<{ projects: ProjectInfo[] }>
      create: (input: ProjectInputInfo) => Promise<{ project: ProjectInfo }>
      update: (input: Partial<ProjectInputInfo> & { id: string }) => Promise<{ project: ProjectInfo }>
      remove: (id: string) => Promise<{ id: string; removed: boolean }>
      tasks: (id: string) => Promise<{
        projectId: string
        tasks: Array<{ id: string; title: string; updatedAt: string; colleagueId: string | null; pinnedAt: string | null }>
      }>
    }
    connections: {
      list: () => Promise<{ connections: ServiceConnectionInfo[] }>
      set: (input: {
        provider: ServiceProviderInfo
        status: ServiceStatusInfo
        endpoint?: string | null
        account?: string | null
        lastError?: string | null
      }) => Promise<{ connection: ServiceConnectionInfo }>
      disconnect: (provider: ServiceProviderInfo) => Promise<{ connection: ServiceConnectionInfo }>
    }
    inspiration: {
      list: () => Promise<{ posts: InspirationPostInfo[] }>
      create: (input: { title: string; body?: string; source?: string; tags?: string[] }) => Promise<{ post: InspirationPostInfo }>
      favorite: (input: { id: string; favorite: boolean }) => Promise<{ post: InspirationPostInfo }>
      remove: (id: string) => Promise<{ id: string; removed: boolean }>
    }
    automation: {
      list: () => Promise<{ automations: AutomationInfo[] }>
      create: (input: {
        name: string
        prompt: string
        scheduleType: 'once' | 'rrule'
        rrule?: string
        scheduledAt?: string
        timezone?: string
        modeId?: string
        enabled?: boolean
      }) => Promise<{ automation: AutomationInfo }>
      toggle: (input: { id: string; enabled: boolean }) => Promise<{ id: string; enabled: boolean }>
      remove: (id: string) => Promise<{ id: string }>
      scan: (input?: { now?: string; startup?: boolean }) => Promise<{ claimed: unknown[] }>
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
    notifications: {
      list: (input?: { pendingOnly?: boolean; limit?: number }) => Promise<{
        notifications: NotificationInfo[]
        unread: number
      }>
      read: (id: string) => Promise<{ notification: NotificationInfo; unread: number }>
      readAll: () => Promise<{ changed: number; unread: number }>
      remove: (id: string) => Promise<{ id: string; removed: boolean; unread: number }>
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

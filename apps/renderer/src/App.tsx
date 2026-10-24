import { useCallback, useEffect, useRef, useState } from 'react'
import { ChatView, type ChatMessage, type ToolCall } from './components/ChatView'
import { type ArtifactInfo } from './components/ArtifactCards'
import { Composer, type ComposerAttachment, type PermissionMode } from './components/Composer'
import { ContentHeader } from './components/ContentHeader'
import { InfoPanel, type SkillInfo } from './components/InfoPanel'
import { ConnectorsPanel } from './components/ConnectorsPanel'
import { MemoryPanel, type MemoryItem } from './components/MemoryPanel'
import { SearchPanel, type SearchGroup, type SearchHit } from './components/SearchPanel'
import { ChannelPanel, type ChannelInfo, type SyncStatus } from './components/ChannelPanel'
import {
  ApprovalDialog,
  ApprovalGrantList,
  type ApprovalGrantInfo,
  type ApprovalRequestInfo,
  type ApprovalScope
} from './components/ApprovalDialog'
import { Sidebar, type ConversationSummary, type MoreEntry } from './components/Sidebar'
import {
  EMPTY_TASK_FILTER,
  TopBar,
  hasTaskFilter,
  type TaskFilterState
} from './components/TopBar'
import { WelcomeView, type SceneId } from './components/WelcomeView'
import { SettingsPanel, type WorkspaceSettingsInfo } from './components/SettingsPanel'
import { AutomationPanel } from './components/AutomationPanel'
import { LibraryPanel } from './components/LibraryPanel'
import { ColleaguesPanel } from './components/ColleaguesPanel'
import { ProjectsPanel } from './components/ProjectsPanel'
import { ConnectionsPanel } from './components/ConnectionsPanel'
import { InspirationPanel } from './components/InspirationPanel'
import { MessageCenter } from './components/MessageCenter'
import { IconCheck, IconSparkle, IconTool } from './components/Icons'
import './styles/tokens.css'
import './styles/app.css'

type ModeInfo = { id: string; displayName: string; description: string }
type MemoryBlock = { scope: string; count: number; truncated: number; ids: string[] }

type AgentEvent = {
  type: string
  text?: string
  callId?: string
  name?: string
  ok?: boolean
  summary?: string
  code?: string
  message?: string
  names?: string[]
  modeId?: string
  displayName?: string
  conversationId?: string
  workspace?: string
  blocks?: MemoryBlock[]
  truncatedTotal?: number
  usage?: { input?: number; output?: number }
  skills?: SkillInfo[]
  allowedTools?: string[] | null
  artifact?: ArtifactInfo
  request?: ApprovalRequestInfo
  approvalId?: string
  paths?: string[]
  injected?: number
  bytes?: number
}

interface SystemLine {
  id: string
  kind: 'system' | 'skill' | 'tools' | 'memory' | 'usage' | 'warn' | 'info'
  text: string
}

type Sheet =
  | 'settings'
  | 'automation'
  | 'library'
  | 'colleagues'
  | 'projects'
  | 'connections'
  | 'inspiration'
  | null

const THEME_KEY = 'owb.theme'
const COLLAPSE_KEY = 'owb.sidebar.collapsed'
const FILTER_KEY = 'owb.task.filter.v1'

function readTaskFilter(): TaskFilterState {
  try {
    const raw = localStorage.getItem(FILTER_KEY)
    if (!raw) return EMPTY_TASK_FILTER
    const parsed = JSON.parse(raw) as Partial<TaskFilterState>
    const statuses = Array.isArray(parsed.sessionStatus)
      ? parsed.sessionStatus.filter((item): item is TaskFilterState['sessionStatus'][number] =>
          ['working', 'completed', 'failed', 'pending', 'planning'].includes(String(item))
        )
      : []
    const date =
      parsed.date === 'today' || parsed.date === 'last7days' || parsed.date === 'last30days'
        ? parsed.date
        : null
    return { sessionStatus: statuses, date }
  } catch {
    return EMPTY_TASK_FILTER
  }
}

function readTheme(): 'light' | 'dark' {
  const saved = localStorage.getItem(THEME_KEY)
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/**
 * 从输入里解析 @ 引用。
 *
 * 只在 @ 后面紧跟非空白字符时才算引用,因此邮箱、@所有人 这类写法不会被误判成文件;
 * 真正的路径校验发生在 daemon 侧(resolveInsideWorkspace),这里不做信任假设。
 */
function parseContextPaths(text: string): string[] {
  const found: string[] = []
  const re = /(?:^|\s)@([^\s@]+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const value = match[1]?.trim()
    if (value && !found.includes(value)) found.push(value)
  }
  return found.slice(0, 20)
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [tools, setTools] = useState<ToolCall[]>([])
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([])
  const [notices, setNotices] = useState<SystemLine[]>([])
  const [modes, setModes] = useState<ModeInfo[]>([])
  const [mode, setMode] = useState('craft')
  const [scene, setScene] = useState<SceneId>('working')
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [conversationId, setConversationId] = useState('')
  const [memories, setMemories] = useState<MemoryItem[]>([])
  const [showMemory, setShowMemory] = useState(false)
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [panel, setPanel] = useState<'skills' | 'connectors' | null>(null)
  const [sheet, setSheet] = useState<Sheet>(null)
  const [connectionProvider, setConnectionProvider] = useState<ServiceProviderInfo>('mailbox')
  const [searchOpen, setSearchOpen] = useState(false)
  const [channels, setChannels] = useState<ChannelInfo[]>([])
  const [channelPanelOpen, setChannelPanelOpen] = useState(false)
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [focusTarget, setFocusTarget] = useState<{ seq: number; nonce: number } | null>(null)
  const [approvalQueue, setApprovalQueue] = useState<ApprovalRequestInfo[]>([])
  const [approvalGrants, setApprovalGrants] = useState<ApprovalGrantInfo[]>([])
  const [showGrants, setShowGrants] = useState(false)
  const [showMessages, setShowMessages] = useState(false)
  const [unreadNotifications, setUnreadNotifications] = useState(0)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === '1')
  const [theme, setTheme] = useState<'light' | 'dark'>(readTheme)
  const [taskFilter, setTaskFilter] = useState<TaskFilterState>(readTaskFilter)
  const [settings, setSettings] = useState<WorkspaceSettingsInfo>({
    permissionMode: 'default',
    taskTarget: 'local',
    model: null
  })
  const [modelLabel, setModelLabel] = useState('')
  const [activeColleague, setActiveColleague] = useState<{ id: string; name: string } | null>(null)
  const streaming = useRef(false)
  const activeConversation = useRef('')

  // 工具读写的是真实目录,界面必须显示它,否则"查当前目录"会被误解成应用安装目录。
  const [workspacePath, setWorkspacePath] = useState('')
  const workspaceLabel = workspacePath ? baseName(workspacePath) : '选择工作空间'
  const currentTitle = conversations.find((c) => c.id === conversationId)?.title ?? ''
  const modeLabel = modes.find((m) => m.id === mode)?.displayName ?? mode
  const activeChannel = channels.find((c) => c.id === activeChannelId) ?? null

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0')
  }, [collapsed])

  useEffect(() => {
    if (hasTaskFilter(taskFilter)) localStorage.setItem(FILTER_KEY, JSON.stringify(taskFilter))
    else localStorage.removeItem(FILTER_KEY)
  }, [taskFilter])

  const note = useCallback((kind: SystemLine['kind'], text: string) => {
    setNotices((list) => [...list, { id: `${kind}-${Date.now()}-${list.length}`, kind, text }])
  }, [])

  const loadConversations = useCallback(async (selectId?: string) => {
    const r = await window.openwb.conversation.list()
    setConversations(r.conversations)
    const target = selectId ?? r.conversationId
    setConversationId(target)
    activeConversation.current = target
    return target
  }, [])

  const loadHistory = useCallback(async (id: string) => {
    const r = await window.openwb.conversation.history(id)
    setArtifacts(r.artifacts ?? [])
    setMessages(
      r.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => {
          const content = m.content as { text?: string } | null
          return {
            id: m.id,
            role: m.role === 'user' ? 'user' : 'assistant',
            text: content?.text ?? '',
            seq: m.seq,
            createdAt: m.createdAt
          } satisfies ChatMessage
        })
    )
  }, [])

  const loadMemories = useCallback(async () => {
    const r = await window.openwb.memory.list()
    setMemories(r.items)
  }, [])

  const loadChannels = useCallback(async () => {
    const r = await window.openwb.channel.list()
    setChannels(r.channels)
    return r.channels
  }, [])

  const loadSyncStatus = useCallback(async () => {
    const r = await window.openwb.sync.status()
    setSyncStatus(r)
  }, [])

  const loadSettings = useCallback(async () => {
    const r = await window.openwb.settings.get()
    setSettings(r.settings)
    setModelLabel(r.model)
    return r
  }, [])

  const loadUnreadNotifications = useCallback(async () => {
    try {
      const r = await window.openwb.notifications.list({ limit: 100 })
      setUnreadNotifications(r.unread)
    } catch {
      // 通知计数失败不能阻塞主流程
    }
  }, [])

  useEffect(() => {
    // ready 帧在本监听注册前就已发出,工作区路径必须主动拉一次。
    void window.openwb.workspace
      .info()
      .then((r) => setWorkspacePath(r.path))
      .catch(() => undefined)

    void window.openwb.modes
      .list()
      .then((r) => {
        setModes(r.modes)
        if (r.modes.length > 0 && !r.modes.some((m) => m.id === 'craft')) {
          setMode(r.modes[0]!.id)
        }
      })
      .catch((err: Error) => note('system', `[错误] 模式加载失败: ${err.message}`))

    void (async () => {
      try {
        const id = await loadConversations()
        if (id) await loadHistory(id)
        await loadMemories()
        await loadChannels()
        await loadSyncStatus()
        await loadSettings()
        await loadUnreadNotifications()
      } catch (err) {
        note('system', `[错误] 历史加载失败: ${(err as Error).message}`)
      }
    })()

    void window.openwb.skills
      .list()
      .then((r) => setSkills(r.skills))
      .catch(() => undefined)

    void window.openwb.approval
      .list()
      .then((r) => setApprovalQueue((r.requests ?? []) as ApprovalRequestInfo[]))
      .catch(() => undefined)

    return window.openwb.conversation.onEvent((raw: unknown) => {
      const e = raw as AgentEvent
      if (e.type === 'text.start') {
        streaming.current = true
        setMessages((list) => [
          ...list,
          { id: `a-${Date.now()}-${list.length}`, role: 'assistant', text: '', streaming: true }
        ])
      } else if (e.type === 'delta' && streaming.current && e.text) {
        setMessages((list) => {
          const next = [...list]
          for (let i = next.length - 1; i >= 0; i--) {
            const item = next[i]!
            if (item.role === 'assistant') {
              next[i] = { ...item, text: item.text + e.text }
              break
            }
          }
          return next
        })
      } else if (e.type === 'skill.activated') {
        const narrowed = e.allowedTools
        note('skill', `已加载技能: ${e.name ?? ''}${narrowed ? `(收窄为 ${narrowed.join(', ')})` : '(未额外收窄工具)'}`)
      } else if (e.type === 'context.attached') {
        const bytes = e.bytes ?? 0
        const size = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} 字节`
        note('info', `已附加 ${e.injected ?? 0} 个文件 · ${size}${(e.paths ?? []).length > (e.injected ?? 0) ? ' · 部分文件读取失败' : ''}`)
      } else if (e.type === 'memory.injected') {
        const truncated = e.truncatedTotal ?? 0
        const counts = (e.blocks ?? []).map((b) => `${b.scope}:${b.count}`).join(' ')
        if (counts || truncated > 0) {
          note(
            'memory',
            [counts ? `已注入记忆 ${counts}` : '', truncated > 0 ? `已截断 ${truncated} 条` : '']
              .filter(Boolean)
              .join(' · ')
          )
        }
      } else if (e.type === 'tools.available') {
        note('tools', `本轮可用工具: ${e.names?.length ? e.names.join(', ') : '(无)'}`)
      } else if (e.type === 'tool.started') {
        setTools((list) => [
          ...list,
          { callId: e.callId ?? '', name: e.name ?? '', ok: null, summary: '' }
        ])
      } else if (e.type === 'tool.finished') {
        setTools((list) =>
          list.map((x) => (x.callId === e.callId ? { ...x, ok: e.ok ?? false, summary: e.summary ?? '' } : x))
        )
      } else if (e.type === 'ready' && e.workspace) {
        setWorkspacePath(e.workspace)
      } else if (e.type === 'artifact.created' && e.artifact) {
        const created = e.artifact
        setArtifacts((list) => (list.some((a) => a.id === created.id) ? list : [...list, created]))
      } else if (e.type === 'delivery.missing') {
        note(
          'warn',
          'DELIVERY_MISSING:本轮写了文件但没有交付,成果还在工作区里。请让助手调用 present_files,否则你拿不到可点击的交付物。'
        )
      } else if (e.type === 'approval.request' && e.request) {
        const request = e.request as ApprovalRequestInfo
        setApprovalQueue((list) => (list.some((item) => item.id === request.id) ? list : [...list, request]))
      } else if (e.type === 'approval.resolved' || e.type === 'approval.expired' || e.type === 'approval.cancelled') {
        const approvalId = (e as { approvalId?: string }).approvalId
        if (approvalId) setApprovalQueue((list) => list.filter((item) => item.id !== approvalId))
      } else if (e.type === 'approval.denied') {
        if (e.code === 'USER_DENIED') note('warn', '你拒绝了该操作,本次没有执行。')
        else note('system', `操作被拦截: ${e.code ?? ''} ${e.message ?? ''}`.trim())
      } else if (e.type === 'conversation.ready' && e.conversationId) {
        setConversationId(e.conversationId)
        activeConversation.current = e.conversationId
      } else if (e.type === 'done') {
        streaming.current = false
        setBusy(false)
        setMessages((list) =>
          list.map((m, i) => (i === list.length - 1 && m.role === 'assistant' ? { ...m, streaming: false } : m))
        )
        if (e.usage && (e.usage.input || e.usage.output)) {
          note('usage', `本轮回合计费: 输入 ${e.usage.input ?? 0} / 输出 ${e.usage.output ?? 0} token (接口返回)`)
        }
        void loadConversations(activeConversation.current || undefined).catch(() => undefined)
        void loadMemories().catch(() => undefined)
        void loadUnreadNotifications()
      } else if (e.type === 'automation.finished') {
        void loadUnreadNotifications()
      } else if (e.type === 'error') {
        streaming.current = false
        setBusy(false)
        note('system', `[错误] ${e.code}: ${e.message}`)
      }
    })
  }, [loadConversations, loadHistory, loadMemories, loadChannels, loadSyncStatus, loadSettings, loadUnreadNotifications, note])

  const send = async () => {
    const text = input.trim()
    if ((!text && attachments.length === 0) || busy) return
    // 只有附件没有文字时也要给出可执行的指令,否则模型不知道要对文件做什么。
    const outgoing = text || '请阅读我添加的上下文文件，并说明你看到了什么。'
    setBusy(true)
    setInput('')
    setTools([])
    setNotices([])
    setMessages((list) => [
      ...list,
      {
        id: `u-${Date.now()}-${list.length}`,
        role: 'user',
        text: attachments.length > 0 ? `${outgoing}\n\n@ ${attachments.map((a) => a.path).join(' ')}` : outgoing,
        createdAt: new Date().toISOString()
      }
    ])
    const typedPaths = parseContextPaths(outgoing)
    const contextPaths = Array.from(new Set([...attachments.map((a) => a.path), ...typedPaths])).slice(0, 20)
    const sentAttachments = attachments
    setAttachments([])
    try {
      await window.openwb.conversation.send({
        text: outgoing,
        mode,
        scene,
        ...(conversationId ? { conversationId } : {}),
        ...(selectedSkill ? { skill: selectedSkill } : {}),
        ...(activeColleague ? { colleagueId: activeColleague.id } : {}),
        ...(contextPaths.length > 0 ? { contextPaths } : {})
      })
    } catch (err) {
      streaming.current = false
      setBusy(false)
      setAttachments(sentAttachments)
      setInput(outgoing)
      note('system', `[错误] 发送失败: ${(err as Error).message}`)
    }
  }

  const switchConversation = async (id: string) => {
    if (busy) return
    setConversationId(id)
    activeConversation.current = id
    const target = conversations.find((c) => c.id === id)
    setActiveColleague(
      target?.colleagueId && target.colleagueName
        ? { id: target.colleagueId, name: target.colleagueName }
        : null
    )
    setFocusTarget(null)
    setTools([])
    setNotices([])
    await loadHistory(id)
    await loadMemories()
  }

  const newConversation = async (colleague: ColleagueInfo | null = null) => {
    if (busy) return
    const r = await window.openwb.conversation.create({
      title: colleague ? `与${colleague.name}协作` : '新会话',
      mode,
      ...(activeChannelId ? { channelId: activeChannelId } : {}),
      ...(colleague ? { colleagueId: colleague.id } : {})
    })
    setConversationId(r.conversationId)
    activeConversation.current = r.conversationId
    setActiveColleague(colleague)
    setMessages([])
    setFocusTarget(null)
    setTools([])
    setNotices([])
    await loadConversations(r.conversationId)
    if (colleague) note('info', `已指派给助理「${colleague.name}」,直接描述任务即可。`)
    return r.conversationId
  }

  const newProjectTask = async (project: ProjectInfo) => {
    if (busy) return
    try {
      const r = await window.openwb.conversation.create({
        title: `与项目「${project.name}」协作`,
        mode,
        ...(activeChannelId ? { channelId: activeChannelId } : {}),
        projectId: project.id
      })
      setConversationId(r.conversationId)
      activeConversation.current = r.conversationId
      setActiveColleague(null)
      setMessages([])
      setFocusTarget(null)
      setTools([])
      setNotices([])
      await loadConversations(r.conversationId)
      setSheet(null)
      note('info', `已在项目「${project.name}」中新建任务，项目指令与技能约束会随本轮生效。`)
    } catch (err) {
      note('system', `新建项目任务失败: ${(err as Error).message}`)
    }
  }

  const selectChannel = (channelId: string | null) => {
    setActiveChannelId(channelId)
    // 选频道后立刻开一个归属该频道的会话,避免用户以为"选了但没生效"。
    if (!channelId) return
    void (async () => {
      const r = await window.openwb.conversation.create({ title: '新会话', mode, channelId })
      setConversationId(r.conversationId)
      activeConversation.current = r.conversationId
      setMessages([])
      setActiveColleague(null)
      setFocusTarget(null)
      setTools([])
      setNotices([])
      await loadConversations(r.conversationId)
    })().catch((err: Error) => note('system', `创建频道会话失败: ${err.message}`))
  }

  const createChannel = async (name: string, description: string) => {
    const r = await window.openwb.channel.create({ name, ...(description ? { description } : {}) })
    await loadChannels()
    selectChannel(r.channel.id)
  }

  const deleteChannel = async (channelId: string) => {
    await window.openwb.channel.remove(channelId)
    const next = await loadChannels()
    if (activeChannelId === channelId) setActiveChannelId(next[0]?.id ?? null)
    await loadConversations(conversationId)
  }

  const flushSync = async () => {
    await window.openwb.sync.flush()
    await loadSyncStatus()
    await loadChannels()
  }

  const respondApproval = async (input: { approvalId: string; approved: boolean; scope?: ApprovalScope }) => {
    await window.openwb.approval.respond(input)
    setApprovalQueue((list) => list.filter((item) => item.id !== input.approvalId))
  }

  const openGrants = async () => {
    const r = await window.openwb.approval.grants()
    setApprovalGrants(r.grants as ApprovalGrantInfo[])
    setShowGrants(true)
  }

  const revokeGrant = async (groupKey: string) => {
    await window.openwb.approval.revoke(groupKey)
    const r = await window.openwb.approval.grants()
    setApprovalGrants(r.grants as ApprovalGrantInfo[])
  }

  const shareArtifact = async (artifact: ArtifactInfo) => {
    if (!activeChannelId) {
      note('warn', '先在设置里选择一个频道,再转发交付物。')
      setSheet('settings')
      return
    }
    try {
      const r = await window.openwb.artifact.share({ channelId: activeChannelId, artifactId: artifact.id })
      note('tools', r.shared ? `已转发到频道:${activeChannel?.name ?? ''}` : '该产物已在频道中')
      await loadChannels()
      void loadSyncStatus().catch(() => undefined)
    } catch (err) {
      note('system', `转发失败: ${(err as Error).message}`)
    }
  }

  const removeConversation = async (id: string) => {
    if (busy) return
    await window.openwb.conversation.remove(id)
    const next = await loadConversations()
    if (next) await loadHistory(next)
  }

  const pinConversation = async (id: string, pinned: boolean) => {
    try {
      await window.openwb.conversation.pin({ conversationId: id, pinned })
      await loadConversations(activeConversation.current || undefined)
    } catch (err) {
      note('system', `置顶失败: ${(err as Error).message}`)
    }
  }

  const reorderPinned = async (orderedIds: string[]) => {
    try {
      await window.openwb.conversation.reorderPinned(orderedIds)
      await loadConversations(activeConversation.current || undefined)
    } catch (err) {
      note('system', `置顶排序失败: ${(err as Error).message}`)
    }
  }

  const renameConversation = async (id: string, title: string) => {
    try {
      await window.openwb.conversation.rename({ conversationId: id, title })
      await loadConversations(activeConversation.current || undefined)
    } catch (err) {
      note('system', `重命名失败: ${(err as Error).message}`)
    }
  }

  const removeMemory = async (id: string) => {
    await window.openwb.memory.remove(id)
    await loadMemories()
  }

  const openWorkspace = async () => {
    try {
      const r = await window.openwb.workspace.open()
      if (r.path) setWorkspacePath(r.path)
    } catch (err) {
      note('system', `打开工作区失败: ${(err as Error).message}`)
    }
  }

  const openArtifact = async (artifact: ArtifactInfo) => {
    try {
      if (artifact.kind === 'url' && !artifact.url) return
      if (artifact.kind !== 'url' && !artifact.path) return
      const confirmedUrl =
        artifact.kind === 'url'
          ? window.confirm(`即将用系统浏览器打开外部链接:\n${artifact.url}\n\n只在你信任该地址时继续。`)
          : false
      if (artifact.kind === 'url' && !confirmedUrl) return
      await window.openwb.artifact.preview({
        kind: artifact.kind,
        ...(artifact.path ? { path: artifact.path } : {}),
        ...(artifact.url ? { url: artifact.url } : {}),
        title: artifact.title,
        ...(confirmedUrl ? { confirmedUrl: true } : {})
      })
    } catch (err) {
      note('system', `打开交付物失败: ${(err as Error).message}`)
    }
  }

  const runSearch = async (q: string): Promise<SearchGroup[]> => {
    const r = await window.openwb.search.query(q)
    return (r.groups ?? []) as SearchGroup[]
  }

  const jumpToHit = async (hit: SearchHit) => {
    if (!hit.conversationId) return
    if (hit.conversationId !== activeConversation.current) {
      if (busy) {
        note('system', '任务运行中,结束后再跳转到其他会话。')
        return
      }
      await switchConversation(hit.conversationId)
    }
    if (hit.seq !== null) setFocusTarget({ seq: hit.seq, nonce: Date.now() })
  }

  const changePermission = async (next: PermissionMode) => {
    try {
      const r = await window.openwb.settings.set({ key: 'permissionMode', value: next })
      setSettings(r.settings)
      note('info', next === 'readOnly' ? '已切换为只读:写入与命令会被拒绝' : next === 'fullAccess' ? '已切换为完全访问:已知风险自动放行' : '已切换为默认权限')
    } catch (err) {
      note('system', `保存权限失败: ${(err as Error).message}`)
    }
  }

  const handleMore = (entry: MoreEntry) => {
    if (entry === 'projects') {
      setSheet('projects')
      return
    }
    if (entry === 'inspiration') {
      setSheet('inspiration')
      return
    }
    setConnectionProvider(entry)
    setSheet('connections')
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setCollapsed((v) => !v)
      }
      if (e.key === 'Escape') {
        setPanel(null)
        setSheet(null)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const composer = (autoFocus = false) => (
    <Composer
      value={input}
      busy={busy}
      autoFocus={autoFocus}
      skills={skills}
      selectedSkill={selectedSkill}
      workspaceLabel={workspaceLabel}
      workspacePath={workspacePath}
      permission={settings.permissionMode}
      modelLabel={modelLabel || '未配置模型'}
      attachments={attachments}
      onChange={setInput}
      onSend={() => void send()}
      onPickSkill={setSelectedSkill}
      onPickPermission={(next) => void changePermission(next)}
      onOpenWorkspace={() => void openWorkspace()}
      onListFiles={async () => {
        const r = await window.openwb.workspace.files({ limit: 400, maxDepth: 4 })
        return r.files
      }}
      onAddAttachment={(file) =>
        setAttachments((list) => (list.some((a) => a.path === file.path) || list.length >= 20 ? list : [...list, file]))
      }
      onRemoveAttachment={(path) => setAttachments((list) => list.filter((a) => a.path !== path))}
    />
  )

  return (
    <div className="owb-shell">
      <TopBar
        collapsed={collapsed}
        theme={theme}
        onToggleCollapse={() => setCollapsed((v) => !v)}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        onFocusSearch={() => setSearchOpen(true)}
        onClearInput={() => setInput('')}
        onOpenSettings={() => setSheet('settings')}
        onOpenWorkspace={() => void openWorkspace()}
        filter={taskFilter}
        onFilterChange={setTaskFilter}
      />

      <div className="owb-app">
        <Sidebar
          conversations={conversations}
          activeId={conversationId}
          busy={busy}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
          onNew={() => void newConversation()}
          onSelect={(id) => void switchConversation(id)}
          onDelete={(id) => void removeConversation(id)}
          onPin={(id, pinned) => void pinConversation(id, pinned)}
          onReorderPinned={(orderedIds) => void reorderPinned(orderedIds)}
          onRename={(id, title) => void renameConversation(id, title)}
          onOpenColleagues={() => setSheet('colleagues')}
          onOpenSkills={() => setPanel('skills')}
          onOpenAutomation={() => setSheet('automation')}
          onOpenLibrary={() => setSheet('library')}
          onOpenMessages={() => setShowMessages(true)}
          unreadMessages={unreadNotifications}
          onOpenActivity={() => note('info', '积分活动需要登录账号后参与')}
          onOpenSupport={() => note('info', '客服入口需要登录账号后使用')}
          onOpenMore={handleMore}
          onOpenAccount={() => setSheet('settings')}
          filter={taskFilter}
          onOpenFilter={() => {
            // 空态里的"调整筛选条件"直接打开同一个真实筛选菜单。
            document.querySelector<HTMLElement>('[data-testid="open-filter"]')?.click()
          }}
        />

        <main className="owb-main">
          {messages.length > 0 ? (
            <ContentHeader
              title={currentTitle || '任务'}
              modeLabel={modeLabel}
              workspaceLabel={workspaceLabel}
              workspacePath={workspacePath}
              busy={busy}
            />
          ) : null}

          <div className="owb-main__body">
            {messages.length === 0 ? (
              <WelcomeView
                scene={scene}
                busy={busy}
                onSceneChange={setScene}
                onQuickAction={(text) => setInput(text)}
              >
                {activeColleague ? (
                  <div className="owb-status owb-status--info owb-status--welcome">
                    <IconSparkle size={13} />
                    <span>
                      正在与助理「{activeColleague.name}」协作
                      <button className="owb-status__link" onClick={() => setActiveColleague(null)}>
                        退出
                      </button>
                    </span>
                  </div>
                ) : null}
                {composer(true)}
              </WelcomeView>
            ) : (
              <>
                <ChatView
                  messages={messages}
                  tools={tools}
                  artifacts={artifacts}
                  modeLabel={modeLabel}
                  busy={busy}
                  focusRequest={focusTarget}
                  onOpenArtifact={(a) => void openArtifact(a)}
                  onShareArtifact={(a) => void shareArtifact(a)}
                  shareChannelName={activeChannel?.name ?? null}
                />
                <div className="owb-chat__input">
                  {activeColleague ? (
                    <div className="owb-status owb-status--info">
                      <IconSparkle size={13} />
                      <span>
                        正在与助理「{activeColleague.name}」协作
                        <button className="owb-status__link" onClick={() => setActiveColleague(null)}>
                          退出
                        </button>
                      </span>
                    </div>
                  ) : null}
                  {notices.length > 0 ? (
                    <div className="owb-notices">
                      {notices.map((n) => (
                        <div
                          key={n.id}
                          className={`owb-status${n.kind === 'system' ? ' owb-status--error' : n.kind === 'skill' ? ' owb-status--skill' : n.kind === 'warn' ? ' owb-status--warn' : ' owb-status--info'}`}
                        >
                          {n.kind === 'skill' ? <IconTool size={13} /> : null}
                          {n.kind === 'tools' ? <IconCheck size={13} /> : null}
                          {n.kind === 'usage' ? <IconSparkle size={13} /> : null}
                          <span>{n.text}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {composer()}
                </div>
              </>
            )}
          </div>

          {showMemory ? (
            <MemoryPanel items={memories} onDelete={(id) => void removeMemory(id)} onClose={() => setShowMemory(false)} />
          ) : null}
        </main>
      </div>

      {panel === 'connectors' ? (
        <ConnectorsPanel
          onClose={() => setPanel(null)}
          onNotify={(kind, text) => note(kind === 'info' ? 'tools' : 'system', text)}
        />
      ) : panel === 'skills' ? (
        <InfoPanel
          kind="skills"
          skills={skills}
          model={modelLabel}
          workspace={workspacePath || workspaceLabel}
          onOpenWorkspace={() => void openWorkspace()}
          onClose={() => setPanel(null)}
        />
      ) : null}

      {channelPanelOpen ? (
        <ChannelPanel
          channels={channels}
          activeChannelId={activeChannelId}
          sync={syncStatus}
          onClose={() => setChannelPanelOpen(false)}
          onSelect={(id) => {
            setChannelPanelOpen(false)
            selectChannel(id)
          }}
          onCreate={createChannel}
          onDelete={deleteChannel}
          onFlush={flushSync}
          onOpenArtifact={(a) => void openArtifact(a)}
        />
      ) : null}

      {sheet ? (
        <div className="owb-sheet-overlay" role="presentation" onClick={(e) => {
          if (e.target === e.currentTarget) setSheet(null)
        }}>
          {sheet === 'settings' ? (
            <SettingsPanel
              settings={settings}
              model={modelLabel}
              workspace={workspacePath || workspaceLabel}
              memoryCount={memories.length}
              channelCount={channels.length}
              onOpenWorkspace={() => void openWorkspace()}
              onOpenMemory={() => {
                setSheet(null)
                setShowMemory(true)
                void loadMemories()
              }}
              onOpenChannels={() => {
                setSheet(null)
                setChannelPanelOpen(true)
                void loadSyncStatus()
              }}
              onOpenGrants={() => {
                setSheet(null)
                void openGrants().catch((err: Error) => note('system', `授权列表加载失败: ${err.message}`))
              }}
              onPermissionChange={changePermission}
              onClose={() => setSheet(null)}
            />
          ) : sheet === 'automation' ? (
            <AutomationPanel
              onClose={() => setSheet(null)}
              onNotify={(kind, text) => note(kind === 'info' ? 'info' : 'system', text)}
            />
          ) : sheet === 'library' ? (
            <LibraryPanel
              onClose={() => setSheet(null)}
              onNotify={(kind, text) => note(kind === 'info' ? 'info' : 'system', text)}
              onOpenArtifact={(item) => {
                setSheet(null)
                void openArtifact({
                  id: item.id,
                  kind: item.kind,
                  title: item.title,
                  description: item.description,
                  path: item.path,
                  url: item.url,
                  size: item.size
                })
              }}
            />
          ) : sheet === 'colleagues' ? (
            <ColleaguesPanel
              onClose={() => setSheet(null)}
              onNotify={(kind, text) => note(kind === 'info' ? 'info' : 'system', text)}
              onAssign={(colleague) => {
                setSheet(null)
                void newConversation(colleague)
              }}
            />
          ) : sheet === 'projects' ? (
            <ProjectsPanel
              onClose={() => setSheet(null)}
              onNotify={(kind, text) => note(kind === 'info' ? 'info' : 'system', text)}
              onOpenTask={(id) => {
                setSheet(null)
                void switchConversation(id)
              }}
              onCreateTask={(project) => void newProjectTask(project)}
              onChanged={() => void loadConversations(conversationId || undefined)}
            />
          ) : sheet === 'connections' ? (
            <ConnectionsPanel
              provider={connectionProvider}
              onClose={() => setSheet(null)}
              onNotify={(kind, text) => note(kind === 'info' ? 'info' : 'system', text)}
            />
          ) : sheet === 'inspiration' ? (
            <InspirationPanel
              onClose={() => setSheet(null)}
              onNotify={(kind, text) => note(kind === 'info' ? 'info' : 'system', text)}
            />
          ) : null}
        </div>
      ) : null}

      <SearchPanel
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onQuery={runSearch}
        onJump={(hit) => void jumpToHit(hit)}
      />

      <MessageCenter
        open={showMessages}
        onClose={() => setShowMessages(false)}
        onNotify={note}
        onUnreadChange={setUnreadNotifications}
        onOpenConversation={(id) => {
          if (busy) {
            note('system', '任务运行中,结束后再跳转到其他会话。')
            return
          }
          void switchConversation(id)
        }}
      />

      {approvalQueue[0] ? (
        <ApprovalDialog request={approvalQueue[0]} onRespond={respondApproval} />
      ) : null}

      {showGrants ? (
        <div className="owb-approval-overlay" role="presentation">
          <section className="owb-approval owb-approval--grants" role="dialog" aria-modal="true" aria-label="授权管理">
            <header className="owb-approval__header">
              <span className="owb-approval__risk"><IconTool size={14} /> 长期授权</span>
              <button className="owb-icon-btn" onClick={() => setShowGrants(false)} aria-label="关闭授权管理">
                <span aria-hidden="true">✕</span>
              </button>
            </header>
            <div className="owb-approval__body">
              <p className="owb-approval__detail">这些授权会在到期前自动放行同组操作;撤销后下一次调用会重新询问。</p>
              <ApprovalGrantList grants={approvalGrants} onRevoke={revokeGrant} />
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}

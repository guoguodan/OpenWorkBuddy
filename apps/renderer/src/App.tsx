import { useCallback, useEffect, useRef, useState } from 'react'
import { ChatView, type ChatMessage, type ToolCall } from './components/ChatView'
import { type ArtifactInfo } from './components/ArtifactCards'
import { ArtifactPanel } from './components/ArtifactPanel'
import { ArtifactPreview, type TextPreviewInfo } from './components/ArtifactPreview'
import { Composer, type ComposerAttachment, type PermissionMode } from './components/Composer'
import { ContentHeader } from './components/ContentHeader'
import { SkillsHubPanel, type HubSkill } from './components/SkillsHubPanel'
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

type SkillInfo = HubSkill

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
  conversation?: { id?: string; title?: string; autoTitle?: string }
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
  attempt?: number
  delayMs?: number
  reason?: string
  coveredMessages?: number
  coveredSeq?: number
  fallback?: boolean
  from?: string
  to?: string
  limit?: number
  used?: number
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
/**
 * 运行诊断开关。
 *
 * "本轮可用工具""已注入记忆""本轮回合计费"是排障信息,真实产品的对话页不展示,
 * 常驻会让界面看起来像控制台。默认隐藏;需要排查时在开发者工具里执行
 * `localStorage.setItem('owb.showRunDiagnostics','1')` 并刷新即可。
 */
const DIAGNOSTICS_KEY = 'owb.showRunDiagnostics'

function showRunDiagnostics(): boolean {
  try {
    return localStorage.getItem(DIAGNOSTICS_KEY) === '1'
  } catch {
    return false
  }
}

function isDiagnosticNotice(kind: SystemLine['kind']): boolean {
  return kind === 'tools' || kind === 'memory' || kind === 'skill' || kind === 'usage'
}

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
  const [showArtifacts, setShowArtifacts] = useState(false)
  /** 应用内预览:null 表示关闭;preview=null 表示该格式不支持内嵌预览。 */
  const [previewArtifact, setPreviewArtifact] = useState<{
    artifact: ArtifactInfo
    preview: TextPreviewInfo | null
  } | null>(null)
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
  /**
   * 历史请求代次。启动时的 loadHistory 可能晚于用户首轮发送返回,
   * 旧响应若仍无条件 setMessages 会把刚发送的消息覆盖掉。
   * 每次主动切换/新建会话或开始流式输出都推进代次,只允许最新一次回填。
   */
  const historyEpoch = useRef(0)
  /** 首轮启动回填必须让位给用户已经发出的消息;否则空历史会覆盖首轮回复。 */
  const userStartedSend = useRef(false)
  const [memories, setMemories] = useState<MemoryItem[]>([])
  const [showMemory, setShowMemory] = useState(false)
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [panel, setPanel] = useState<'skills' | 'connectors' | null>(null)
  const [sheet, setSheet] = useState<Sheet>(null)
  const [focusProjectId, setFocusProjectId] = useState<string | null>(null)
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
    model: null,
    fallbackModel: null,
    tokenBudget: 0
  })
  const [modelLabel, setModelLabel] = useState('')
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [activeColleague, setActiveColleague] = useState<{ id: string; name: string } | null>(null)
  const [activeExpert, setActiveExpert] = useState<{ id: string; name: string } | null>(null)
  const streaming = useRef(false)
  const activeConversation = useRef('')

  // 工具读写的是真实目录,界面必须显示它,否则"查当前目录"会被误解成应用安装目录。
  const [workspacePath, setWorkspacePath] = useState('')
  const workspaceLabel = workspacePath ? baseName(workspacePath) : '选择工作空间'
  const currentTitle = conversations.find((c) => c.id === conversationId)?.title ?? ''
  const currentPinned = Boolean(conversations.find((c) => c.id === conversationId)?.pinnedAt)
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

  // 备注仍然记录在状态里(切到诊断模式后能看到同一轮的完整信息),
  // 只是默认不渲染。这里在渲染期读取开关,避免为了一个调试项再加一次状态同步。
  const visibleNotices = showRunDiagnostics()
    ? notices
    : notices.filter((item) => !isDiagnosticNotice(item.kind))

  const loadConversations = useCallback(async (selectId?: string) => {
    const r = await window.openwb.conversation.list()
    setConversations(r.conversations)
    const target = selectId ?? r.conversationId
    setConversationId(target)
    activeConversation.current = target
    return target
  }, [])

  const loadHistory = useCallback(async (id: string) => {
    const epoch = ++historyEpoch.current
    const r = await window.openwb.conversation.history(id)
    if (epoch !== historyEpoch.current || activeConversation.current !== id) return
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
            createdAt: m.createdAt,
            feedback: m.feedback ?? null,
            feedbackReason: m.feedbackReason ?? null
          } satisfies ChatMessage
        })
    )
  }, [])

  // 重放/回退的事件必须能同步重建整个视图。daemon 会带回数据库快照,
  // 避免界面保留已被截断的消息、工具行或交付物。
  const applySnapshot = useCallback((raw: unknown, artifactsNext: unknown) => {
    const rows = Array.isArray(raw) ? raw : []
    setArtifacts((Array.isArray(artifactsNext) ? artifactsNext : []) as ArtifactInfo[])
    setMessages(
      rows
        .filter((item): item is { id: string; role?: string; seq?: number; content?: { text?: string }; createdAt?: string; feedback?: 'like' | 'dislike' | null; feedbackReason?: string | null } =>
          Boolean(item) && typeof item === 'object' &&
          ((item as { role?: string }).role === 'user' || (item as { role?: string }).role === 'assistant')
        )
        .map((m) => ({
          id: m.id,
          role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
          text: m.content?.text ?? '',
          ...(m.seq !== undefined ? { seq: m.seq } : {}),
          ...(m.createdAt !== undefined ? { createdAt: m.createdAt } : {}),
          feedback: m.feedback ?? null,
          feedbackReason: m.feedbackReason ?? null
        }) satisfies ChatMessage)
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
    try {
      const r = await window.openwb.settings.get()
      setSettings(r.settings)
      setModelLabel(r.model)
      return r
    } finally {
      setSettingsLoaded(true)
    }
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
        if (id) {
          const list = await window.openwb.conversation.list()
          const target = list.conversations.find((c) => c.id === id)
          setActiveExpert(
            target?.expertId && target.expertName
              ? { id: target.expertId, name: target.expertName }
              : null
          )
          if (!userStartedSend.current) await loadHistory(id)
        }
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
      .then((r) => setSkills(r.skills.map((skill) => ({ ...skill, enabled: skill.enabled !== false }))))
      .catch(() => undefined)

    void window.openwb.approval
      .list()
      .then((r) => setApprovalQueue((r.requests ?? []) as ApprovalRequestInfo[]))
      .catch(() => undefined)

    return window.openwb.conversation.onEvent((raw: unknown) => {
      const e = raw as AgentEvent
      if (e.type === 'text.start') {
        historyEpoch.current++
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
      } else if (e.type === 'context.summary') {
        // 长对话压缩是用户能感知的行为:前面的原文不再逐条发送,但关键信息被保留。
        // 不提示会让用户以为历史丢了,提示太技术化又像报错,这里只说结果。
        const count = e.coveredMessages ?? 0
        note(
          e.fallback ? 'warn' : 'info',
          e.fallback
            ? `较早的 ${count} 条对话已压缩为简要摘要(模型摘要失败,已用本地摘要保底)。`
            : `已将较早的 ${count} 条对话压缩为摘要,关键目标与结论仍会带入后续对话。`
        )
      } else if (e.type === 'tool.started') {
        setTools((list) => [
          ...list,
          { callId: e.callId ?? '', name: e.name ?? '', ok: null, summary: '' }
        ])
      } else if (e.type === 'tool.finished') {
        setTools((list) =>
          list.map((x) => (x.callId === e.callId ? { ...x, ok: e.ok ?? false, summary: e.summary ?? '' } : x))
        )
      } else if (e.type === 'retry.scheduled') {
        // 重试期间仍处于同一个"流式回复"里,不能把 streaming 置 false:
        // 否则重试成功后的增量会被丢弃,界面只看到半截答案。
        const delayMs = Math.max(0, e.delayMs ?? 0)
        const wait = delayMs >= 1000 ? `${(delayMs / 1000).toFixed(1)} 秒` : `${delayMs} 毫秒`
        const reason = e.reason ? ` · ${e.reason.slice(0, 120)}` : ''
        note('warn', `连接中断,${wait}后自动重试(第 ${e.attempt ?? 1} 次)${reason}`)
      } else if (e.type === 'retry.recovered') {
        note('info', '连接已恢复,继续生成。')
      } else if (e.type === 'model.fallback') {
        note('warn', `主模型「${e.from ?? ''}」不可用,已切换到备用模型「${e.to ?? ''}」继续生成。`)
      } else if (e.type === 'model.fallback.recovered') {
        note('info', `备用模型「${e.to ?? ''}」已恢复生成。`)
      } else if (e.type === 'budget.exceeded') {
        note('warn', e.message ?? `本轮已达到 ${e.limit ?? 0} token 成本上限,已停止后续调用。`)
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
      } else if (e.type === 'expert.released') {
        setActiveExpert(null)
        note('warn', '当前专家已关闭或卸载,已自动退出专家模式;本会话将按普通会话继续。')
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
        // 用户消息以 daemon 落库后的真实 ID 为准:发送时的临时 ID 只用于先显示,
        // 不替换就会让复制之后的扩展操作(重放/回退)找不到实体。
        const messageId = (e as { messageId?: string }).messageId
        if (messageId) {
          setMessages((list) => {
            for (let i = list.length - 1; i >= 0; i--) {
              const item = list[i]!
              if (item.role === 'user' && item.id.startsWith('u-')) {
                return list.map((m, idx) => (idx === i ? { ...m, id: messageId } : m))
              }
            }
            return list
          })
        }
      } else if (e.type === 'conversation.reverted' || e.type === 'conversation.replayed') {
        // 重放/回退是破坏性操作,以 daemon 回传的数据库快照为准。
        const snapshot = e as {
          messages?: unknown
          artifacts?: unknown
          files?: {
            applied?: boolean
            reason?: string
            touched?: number
            restored?: number
            deleted?: number
          }
        }
        const files = snapshot.files
        const fileNotice = (() => {
          if (!files) return ''
          if (!files.applied) return files.reason ? `文件未回退: ${files.reason}` : ''
          if (!files.touched) return '文件无需改动。'
          const parts = [`已恢复 ${files.restored ?? 0} 个文件`]
          if (files.deleted) parts.push(`删除 ${files.deleted} 个新增文件`)
          return `${parts.join(',')}。`
        })()
        setTools([])
        setNotices([])
        applySnapshot(snapshot.messages, snapshot.artifacts)
        if (e.type === 'conversation.replayed') {
          streaming.current = true
          setBusy(true)
          if (fileNotice) note(files?.applied ? 'info' : 'warn', fileNotice)
        } else {
          setBusy(false)
          streaming.current = false
          note('info', '已回退到此版本。')
          if (fileNotice) note(files?.applied ? 'info' : 'warn', fileNotice)
        }
        void loadConversations(activeConversation.current || undefined).catch(() => undefined)
      } else if (e.type === 'done') {
        streaming.current = false
        setBusy(false)
        const messageId = (e as { messageId?: string }).messageId
        setMessages((list) =>
          list.map((m, i) =>
            i === list.length - 1 && m.role === 'assistant'
              ? { ...m, streaming: false, ...(messageId ? { id: messageId } : {}) }
              : m
          )
        )
        if (e.usage && (e.usage.input || e.usage.output)) {
          note('usage', `本轮回合计费: 输入 ${e.usage.input ?? 0} / 输出 ${e.usage.output ?? 0} token (接口返回)`)
        }
        // 实时流里的消息没有数据库序号,回填一次让搜索定位和消息操作都拿到稳定坐标。
        void loadHistory(activeConversation.current).catch(() => undefined)
        void loadConversations(activeConversation.current || undefined).catch(() => undefined)
        void loadMemories().catch(() => undefined)
        void loadUnreadNotifications()
      } else if (e.type === 'run.cancelled') {
        // 停止以 daemon 的确认事件为准:点击瞬间就清空会把已经生成的内容"撤回",
        // 用户在停止前看到的部分回复应继续留在会话里。
        streaming.current = false
        setBusy(false)
        setMessages((list) =>
          list.map((m, i) => (i === list.length - 1 && m.role === 'assistant' ? { ...m, streaming: false } : m))
        )
        note('warn', '已停止生成,已保留当前输出。')
        void loadConversations(activeConversation.current || undefined).catch(() => undefined)
      } else if (e.type === 'conversation.updated' && e.conversation) {
        // 自动标题/重命名由 daemon 统一广播;用事件里的 title 直接更新,
        // 避免每个事件都重新拉整个列表造成侧栏闪烁。
        const updated = e.conversation
        if (updated.id && updated.title) {
          setConversations((list) =>
            list.map((c) =>
              c.id === updated.id
                ? { ...c, title: updated.title!, ...(updated.autoTitle ? { autoTitle: updated.autoTitle } : {}) }
                : c
            )
          )
        }
      } else if (e.type === 'automation.finished') {
        void loadUnreadNotifications()
      } else if (e.type === 'error') {
        streaming.current = false
        setBusy(false)
        note('system', `[错误] ${e.code}: ${e.message}`)
      }
    })
  }, [loadConversations, loadHistory, loadMemories, loadChannels, loadSyncStatus, loadSettings, loadUnreadNotifications, note, applySnapshot])

  const send = async () => {
    const text = input.trim()
    if ((!text && attachments.length === 0) || busy) return
    // 只有附件没有文字时也要给出可执行的指令,否则模型不知道要对文件做什么。
    const outgoing = text || '请阅读我添加的上下文文件，并说明你看到了什么。'
    userStartedSend.current = true
    historyEpoch.current++
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
        ...(activeExpert ? { expertId: activeExpert.id } : {}),
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

  const stopGenerate = async () => {
    if (!busy) return
    try {
      await window.openwb.conversation.cancel(conversationId || undefined)
    } catch (err) {
      note('system', `[错误] 停止失败: ${(err as Error).message}`)
    }
  }

  const applyFeedback = useCallback(
    async (message: ChatMessage, feedback: 'like' | 'dislike' | null, reason?: string) => {
      if (!message.id || !message.id.match(/^[0-9A-Za-z]+$/)) {
        note('warn', '这条消息还在发送中,完成后才能反馈。')
        return
      }
      const previous = { feedback: message.feedback ?? null, feedbackReason: message.feedbackReason ?? null }
      // 先乐观更新:点赞/点踩要即时响应;daemon 失败时回滚到原状态,
      // 不能让界面显示成功而数据库里没有记录。
      setMessages((list) =>
        list.map((item) =>
          item.id === message.id
            ? {
                ...item,
                feedback,
                feedbackReason: feedback === 'dislike' ? (reason ?? null) : null
              }
            : item
        )
      )
      try {
        const updated = await window.openwb.conversation.feedback({
          messageId: message.id,
          feedback,
          ...(reason ? { reason } : {})
        })
        setMessages((list) =>
          list.map((item) =>
            item.id === message.id
              ? { ...item, feedback: updated.feedback, feedbackReason: updated.feedbackReason }
              : item
          )
        )
      } catch (err) {
        setMessages((list) => list.map((item) => (item.id === message.id ? { ...item, ...previous } : item)))
        note('system', `[错误] 反馈保存失败: ${(err as Error).message}`)
      }
    },
    [note]
  )

  const replayMessage = useCallback(
    async (message: ChatMessage) => {
      if (!conversationId) return
      try {
        // 先进入忙碌态:重放会真正重跑模型,期间不允许再次发送或切换。
        setBusy(true)
        streaming.current = true
        await window.openwb.conversation.replay({ conversationId, messageId: message.id })
      } catch (err) {
        setBusy(false)
        streaming.current = false
        note('system', `[错误] 重放失败: ${(err as Error).message}`)
        throw err
      }
    },
    [conversationId, note]
  )

  const revertMessage = useCallback(
    async (message: ChatMessage) => {
      if (!conversationId) return
      try {
        await window.openwb.conversation.revert({ conversationId, messageId: message.id })
        // 快照由 conversation.reverted 事件带回;这里不再主动拉历史,
        // 避免异步请求晚到覆盖服务端已经截断后的状态。
      } catch (err) {
        note('system', `[错误] 回退失败: ${(err as Error).message}`)
        throw err
      }
    },
    [conversationId, note]
  )

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
    setActiveExpert(
      target?.expertId && target.expertName ? { id: target.expertId, name: target.expertName } : null
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
    setActiveExpert(null)
    setMessages([])
    setFocusTarget(null)
    setTools([])
    setNotices([])
    await loadConversations(r.conversationId)
    if (colleague) note('info', `已指派给助理「${colleague.name}」,直接描述任务即可。`)
    return r.conversationId
  }

  const useExpert = async (expert: { id: string; name: string }) => {
    if (busy) return
    try {
      const r = await window.openwb.conversation.create({
        title: `与「${expert.name}」协作`,
        mode,
        expertId: expert.id,
        ...(activeChannelId ? { channelId: activeChannelId } : {})
      })
      setPanel(null)
      setConversationId(r.conversationId)
      activeConversation.current = r.conversationId
      setActiveExpert(expert)
      setActiveColleague(null)
      setMessages([])
      setFocusTarget(null)
      setTools([])
      setNotices([])
      await loadConversations(r.conversationId)
      note('info', `已切换到专家「${expert.name}」,直接描述任务即可。`)
    } catch (err) {
      note('system', `启用专家失败: ${(err as Error).message}`)
    }
  }

  const releaseExpert = async () => {
    if (busy) return
    try {
      const r = await window.openwb.conversation.create({ title: '新会话', mode })
      setConversationId(r.conversationId)
      activeConversation.current = r.conversationId
      setActiveExpert(null)
      setActiveColleague(null)
      setMessages([])
      setFocusTarget(null)
      setTools([])
      setNotices([])
      await loadConversations(r.conversationId)
    } catch (err) {
      note('system', `退出专家失败: ${(err as Error).message}`)
    }
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
      setActiveExpert(null)
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
      setActiveExpert(null)
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
      // 服务端返回的是展示标题(用户标题优先);直接替换本地项,无需整表重拉。
      setConversations((list) => list.map((c) => (c.id === id ? { ...c, title } : c)))
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
      if (artifact.kind === 'url') {
        const targetUrl = artifact.url
        if (!targetUrl) return
        const confirmedUrl = window.confirm(
          `即将用系统浏览器打开外部链接:\n${targetUrl}\n\n只在你信任该地址时继续。`
        )
        if (!confirmedUrl) return
        await window.openwb.artifact.preview({
          kind: 'url',
          url: targetUrl,
          title: artifact.title,
          confirmedUrl: true
        })
        return
      }
      if (!artifact.path) return
      const r = await window.openwb.artifact.read({ path: artifact.path })
      setPreviewArtifact({ artifact, preview: (r.preview ?? null) as TextPreviewInfo | null })
    } catch (err) {
      note('system', `打开交付物失败: ${(err as Error).message}`)
    }
  }

  /** 预览里点"用系统程序打开"才允许启动外部程序;网页类仍保留工作区与大小校验。 */
  const openArtifactExternally = async (artifact: ArtifactInfo) => {
    try {
      if (artifact.kind === 'url') {
        const targetUrl = artifact.url
        if (!targetUrl) return
        await window.openwb.artifact.preview({
          kind: 'url',
          url: targetUrl,
          title: artifact.title,
          confirmedUrl: true
        })
        return
      }
      if (!artifact.path) return
      await window.openwb.artifact.preview({
        kind: artifact.kind,
        path: artifact.path,
        title: artifact.title
      })
    } catch (err) {
      note('system', `用系统程序打开失败: ${(err as Error).message}`)
    }
  }
  /**
   * 交付物记录操作。
   *
   * 重命名只改展示标题;移除只删除记录。两者都不触碰磁盘文件,
   * 所以不需要走审批,但仍以 daemon 的数据库结果为准更新本地列表。
   */
  const renameArtifact = async (artifact: ArtifactInfo, title: string) => {
    try {
      const r = await window.openwb.artifact.rename({ artifactId: artifact.id, title })
      setArtifacts((list) => list.map((item) => (item.id === artifact.id ? { ...item, title: r.artifact.title } : item)))
      note('info', `已重命名为「${r.artifact.title}」`)
    } catch (err) {
      note('system', `重命名交付物失败: ${(err as Error).message}`)
    }
  }

  const removeArtifact = async (artifact: ArtifactInfo) => {
    try {
      await window.openwb.artifact.remove({ artifactId: artifact.id })
      setArtifacts((list) => list.filter((item) => item.id !== artifact.id))
      note('info', `已从交付物列表移除「${artifact.title}」,工作区文件未删除`)
    } catch (err) {
      note('system', `移除交付物失败: ${(err as Error).message}`)
    }
  }

  const revealArtifact = async (artifact: ArtifactInfo) => {
    try {
      if (!artifact.path || artifact.kind === 'url') return
      await window.openwb.artifact.reveal({ kind: artifact.kind, path: artifact.path })
    } catch (err) {
      note('system', `定位交付物失败: ${(err as Error).message}`)
    }
  }

  const runSearch = async (q: string): Promise<SearchGroup[]> => {
    const r = await window.openwb.search.query(q)
    return (r.groups ?? []) as SearchGroup[]
  }

  const jumpToHit = async (hit: SearchHit) => {
    if (hit.group === 'project' && hit.projectId) {
      setFocusProjectId(hit.projectId)
      setSheet('projects')
      return
    }
    if (!hit.conversationId) return
    if (hit.conversationId !== activeConversation.current) {
      if (busy) {
        note('system', '任务运行中,结束后再跳转到其他会话。')
        return
      }
        await switchConversation(hit.conversationId)
    } else if (!busy) {
      // 同一会话里的实时消息可能还没带 seq;先与服务端对齐再定位。
      await loadHistory(hit.conversationId)
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

  const changeModel = async (name: string | null) => {
    const value = name?.trim() || null
    try {
      const r = await window.openwb.settings.set({ key: 'model', value })
      setSettings(r.settings)
      await loadSettings()
      note('info', `已切换模型: ${value ?? '跟随环境默认'}`)
    } catch (err) {
      note('system', `切换模型失败: ${(err as Error).message}`)
    }
  }

  const changeFallbackModel = async (name: string | null) => {
    const value = name?.trim() || null
    try {
      const r = await window.openwb.settings.set({ key: 'fallbackModel', value })
      setSettings(r.settings)
      note('info', value ? `备用模型已设为: ${value}` : '已关闭备用模型降级')
    } catch (err) {
      note('system', `保存备用模型失败: ${(err as Error).message}`)
    }
  }

  const changeTokenBudget = async (value: number) => {
    try {
      const r = await window.openwb.settings.set({ key: 'tokenBudget', value })
      setSettings(r.settings)
      note('info', value > 0 ? `单轮 token 上限已设为 ${value}` : '已取消单轮 token 上限')
    } catch (err) {
      note('system', `保存成本上限失败: ${(err as Error).message}`)
    }
  }

  /**
   * 模型候选来自网关 /v1/models,不再写死常见模型名。
   * 失败时保留当前模型与自定义输入,并把原因交给菜单显示。
   */
  const loadModelOptions = useCallback(async () => {
    setModelsLoading(true)
    try {
      const r = await window.openwb.models.list()
      setModelOptions(r.models)
      setModelsError(r.remote ? null : (r.error ?? '网关未返回模型清单'))
      if (r.current && !modelLabel) setModelLabel(r.current)
    } catch (err) {
      setModelOptions([])
      setModelsError((err as Error).message)
    } finally {
      setModelsLoading(false)
    }
  }, [modelLabel])

  const handleMore = (entry: MoreEntry) => {
    if (entry === 'projects') {
      setFocusProjectId(null)
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
      skills={skills.filter((skill) => skill.enabled !== false)}
      selectedSkill={selectedSkill}
      workspaceLabel={workspaceLabel}
      workspacePath={workspacePath}
      permission={settings.permissionMode}
      modelLabel={modelLabel}
      modelLoading={!settingsLoaded}
      modelOptions={modelOptions}
      modelsLoading={modelsLoading}
      modelsError={modelsError}
      onOpenModelMenu={() => {
        if (!modelsLoading) void loadModelOptions()
      }}
      attachments={attachments}
      onChange={setInput}
      onSend={() => void send()}
      onStop={() => void stopGenerate()}
      onPickSkill={setSelectedSkill}
      onPickPermission={(next) => void changePermission(next)}
      onPickModel={(next) => void changeModel(next)}
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
              artifactCount={artifacts.length}
              artifactPanelOpen={showArtifacts}
              onToggleArtifacts={() => setShowArtifacts((value) => !value)}
              pinned={currentPinned}
              onPin={(pinned) => {
                if (conversationId) void pinConversation(conversationId, pinned)
              }}
              onRename={(title) => {
                if (conversationId) void renameConversation(conversationId, title)
              }}
              onDelete={() => {
                if (conversationId) void removeConversation(conversationId)
              }}
            />
          ) : null}

          <div className="owb-main__body">
            <div className="owb-main__split">
            <div className="owb-main__content">
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
                {activeExpert ? (
                  <div className="owb-status owb-status--info owb-status--welcome" data-testid="active-expert-banner">
                    <IconSparkle size={13} />
                    <span>
                      正在与专家「{activeExpert.name}」协作
                      <button className="owb-status__link" onClick={() => void releaseExpert()}>
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
                  onFeedback={applyFeedback}
                  onReplay={replayMessage}
                  onRevert={revertMessage}
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
                  {activeExpert ? (
                    <div className="owb-status owb-status--info" data-testid="active-expert-banner">
                      <IconSparkle size={13} />
                      <span>
                        正在与专家「{activeExpert.name}」协作
                        <button className="owb-status__link" onClick={() => void releaseExpert()}>
                          退出
                        </button>
                      </span>
                    </div>
                  ) : null}
                  {visibleNotices.length > 0 ? (
                    <div className="owb-notices">
                      {visibleNotices.map((n) => (
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

            {showArtifacts ? (
              <ArtifactPanel
                artifacts={artifacts}
                busy={busy}
                onClose={() => setShowArtifacts(false)}
                onOpen={(item) => void openArtifact(item)}
                onRename={(item, title) => void renameArtifact(item, title)}
                onRemove={(item) => void removeArtifact(item)}
                onReveal={(item) => void revealArtifact(item)}
                onOpenAll={() => {
                  setShowArtifacts(false)
                  setSheet('library')
                }}
                onNotify={note}
              />
            ) : null}
            </div>
          </div>

          {showMemory ? (
            <MemoryPanel items={memories} onDelete={(id) => void removeMemory(id)} onClose={() => setShowMemory(false)} />
          ) : null}
        </main>
      </div>

      {previewArtifact ? (
        <ArtifactPreview
          artifact={previewArtifact.artifact}
          preview={previewArtifact.preview}
          onClose={() => setPreviewArtifact(null)}
          onOpenExternal={() => void openArtifactExternally(previewArtifact.artifact)}
        />
      ) : null}
      {panel === 'skills' || panel === 'connectors' ? (
        <SkillsHubPanel
          initialTab={panel === 'connectors' ? 'connectors' : 'skills'}
          onClose={() => setPanel(null)}
          onNotify={(kind, text) => note(kind === 'info' ? 'tools' : 'system', text)}
          onSkillsChanged={(next) => setSkills(next)}
          onUseExpert={(expert) => void useExpert(expert)}
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
              onFallbackModelChange={changeFallbackModel}
              onTokenBudgetChange={changeTokenBudget}
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
              onAssign={(colleague, prompt) => {
                setSheet(null)
                void newConversation(colleague).then(() => {
                  if (prompt) setInput(prompt)
                })
              }}
              onOpenTask={(id) => {
                setSheet(null)
                void switchConversation(id)
              }}
            />
          ) : sheet === 'projects' ? (
            <ProjectsPanel
              focusProjectId={focusProjectId}
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

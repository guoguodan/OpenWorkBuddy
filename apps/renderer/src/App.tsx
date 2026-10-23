import { useCallback, useEffect, useRef, useState } from 'react'
import { ChatView, type ChatMessage, type ToolCall } from './components/ChatView'
import { type ArtifactInfo } from './components/ArtifactCards'
import { Composer } from './components/Composer'
import { ContentHeader } from './components/ContentHeader'
import { InfoPanel, type SkillInfo } from './components/InfoPanel'
import { ConnectorsPanel } from './components/ConnectorsPanel'
import { MemoryPanel, type MemoryItem } from './components/MemoryPanel'
import { Sidebar, type ConversationSummary } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { WelcomeView } from './components/WelcomeView'
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
}

interface SystemLine {
  id: string
  kind: 'system' | 'skill' | 'tools' | 'memory' | 'usage' | 'warn'
  text: string
}

const THEME_KEY = 'owb.theme'
const COLLAPSE_KEY = 'owb.sidebar.collapsed'

function readTheme(): 'light' | 'dark' {
  const saved = localStorage.getItem(THEME_KEY)
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [tools, setTools] = useState<ToolCall[]>([])
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([])
  const [notices, setNotices] = useState<SystemLine[]>([])
  const [modes, setModes] = useState<ModeInfo[]>([])
  const [mode, setMode] = useState('craft')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [conversationId, setConversationId] = useState('')
  const [memories, setMemories] = useState<MemoryItem[]>([])
  const [showMemory, setShowMemory] = useState(false)
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [panel, setPanel] = useState<'skills' | 'connectors' | null>(null)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === '1')
  const [theme, setTheme] = useState<'light' | 'dark'>(readTheme)
  const [focusSearchToken, setFocusSearchToken] = useState(0)
  const streaming = useRef(false)
  const activeConversation = useRef('')

  const model = 'OpenAI 兼容'
  // 工具读写的是真实目录,界面必须显示它,否则"查当前目录"会被误解成应用安装目录。
  const [workspacePath, setWorkspacePath] = useState('')
  const workspaceLabel = workspacePath ? baseName(workspacePath) : '工作区'
  const modeLabel = modes.find((m) => m.id === mode)?.displayName ?? mode
  const currentTitle = conversations.find((c) => c.id === conversationId)?.title ?? '新会话'

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0')
  }, [collapsed])

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
            createdAt: m.createdAt
          } satisfies ChatMessage
        })
    )
  }, [])

  const loadMemories = useCallback(async () => {
    const r = await window.openwb.memory.list()
    setMemories(r.items)
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
      } catch (err) {
        note('system', `[错误] 历史加载失败: ${(err as Error).message}`)
      }
    })()

    void window.openwb.skills
      .list()
      .then((r) => setSkills(r.skills))
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
      } else if (e.type === 'memory.injected') {
        const truncated = e.truncatedTotal ?? 0
        const counts = (e.blocks ?? []).map((b) => `${b.scope}:${b.count}`).join(' ')
        note(
          'memory',
          [counts ? `已注入记忆 ${counts}` : '本轮无记忆注入', truncated > 0 ? `已截断 ${truncated} 条` : '']
            .filter(Boolean)
            .join(' · ')
        )
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
      } else if (e.type === 'error') {
        streaming.current = false
        setBusy(false)
        note('system', `[错误] ${e.code}: ${e.message}`)
      }
    })
  }, [loadConversations, loadHistory, loadMemories, note])

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setBusy(true)
    setInput('')
    setTools([])
    setNotices([])
    setMessages((list) => [
      ...list,
      { id: `u-${Date.now()}-${list.length}`, role: 'user', text, createdAt: new Date().toISOString() }
    ])
    try {
      await window.openwb.conversation.send({
        text,
        mode,
        ...(conversationId ? { conversationId } : {})
      })
    } catch (err) {
      streaming.current = false
      setBusy(false)
      note('system', `[错误] 发送失败: ${(err as Error).message}`)
    }
  }

  const switchConversation = async (id: string) => {
    if (busy) return
    setConversationId(id)
    activeConversation.current = id
    setTools([])
    setNotices([])
    await loadHistory(id)
    await loadMemories()
  }

  const newConversation = async () => {
    if (busy) return
    const r = await window.openwb.conversation.create({ title: '新会话', mode })
    setConversationId(r.conversationId)
    activeConversation.current = r.conversationId
    setMessages([])
    setTools([])
    setNotices([])
    await loadConversations(r.conversationId)
  }

  const removeConversation = async (id: string) => {
    if (busy) return
    await window.openwb.conversation.remove(id)
    const next = await loadConversations()
    if (next) await loadHistory(next)
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
      if (artifact.kind === 'url') {
        if (artifact.url) window.open(artifact.url, '_blank', 'noopener')
        return
      }
      if (!artifact.path) return
      await window.openwb.artifact.open(artifact.path)
    } catch (err) {
      note('system', `打开交付物失败: ${(err as Error).message}`)
    }
  }

  const composer = (showModes: boolean, autoFocus = false) => (
    <Composer
      value={input}
      busy={busy}
      mode={mode}
      modes={modes}
      showModes={showModes}
      autoFocus={autoFocus}
      placeholder={
        mode === 'quick' ? '问点什么,快速模式不调用工具' : '描述你的任务,Enter 发送 / Shift+Enter 换行'
      }
      onChange={setInput}
      onSend={() => void send()}
      onModeChange={setMode}
    />
  )

  return (
    <div className="owb-shell">
      <TopBar
        collapsed={collapsed}
        theme={theme}
        onToggleCollapse={() => setCollapsed((v) => !v)}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        onFocusSearch={() => setFocusSearchToken((v) => v + 1)}
        onClearInput={() => setInput('')}
        onToggleMemory={() => {
          setShowMemory((v) => !v)
          void loadMemories()
        }}
        onOpenWorkspace={openWorkspace}
      />

      <div className="owb-app">
        <Sidebar
          conversations={conversations}
          activeId={conversationId}
          busy={busy}
          collapsed={collapsed}
          theme={theme}
          memoryCount={memories.length}
          model={model}
          skillCount={skills.length}
          focusSearchToken={focusSearchToken}
          onToggleCollapse={() => setCollapsed((v) => !v)}
          onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          onNew={() => void newConversation()}
          onSelect={(id) => void switchConversation(id)}
          onDelete={(id) => void removeConversation(id)}
          onToggleMemory={() => {
            setShowMemory((v) => !v)
            void loadMemories()
          }}
          onOpenSkills={() => setPanel('skills')}
          onOpenConnectors={() => setPanel('connectors')}
        />

        <main className="owb-main">
          <ContentHeader
            title={currentTitle}
            modeLabel={modeLabel}
            workspaceLabel={workspaceLabel}
            workspacePath={workspacePath}
            busy={busy}
          />

          <div className="owb-main__body">
            {messages.length === 0 ? (
              <WelcomeView
                modes={modes}
                mode={mode}
                busy={busy}
                onModeChange={setMode}
                onQuickAction={(text) => setInput(text)}
              >
                {composer(false, true)}
              </WelcomeView>
            ) : (
              <>
                <ChatView
                  messages={messages}
                  tools={tools}
                  artifacts={artifacts}
                  modeLabel={modeLabel}
                  busy={busy}
                  onOpenArtifact={(a) => void openArtifact(a)}
                />
                <div className="owb-chat__input">
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
                  {composer(true)}
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
          model={model}
          workspace={workspacePath || workspaceLabel}
          onOpenWorkspace={() => void openWorkspace()}
          onClose={() => setPanel(null)}
        />
      ) : null}
    </div>
  )
}

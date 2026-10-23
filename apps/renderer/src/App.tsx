import { useCallback, useEffect, useRef, useState } from 'react'

type ToolEvent = { callId: string; name: string; ok: boolean | null; summary: string }
type ModeInfo = { id: string; displayName: string; description: string }
type ConversationInfo = { id: string; title: string; modeId: string; updatedAt: string; lastSeq: number }
type MemoryItem = {
  id: string
  scope: string
  kind: string
  content: string
  tokens: number
  createdAt: string
}
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
  blocks?: MemoryBlock[]
  truncatedTotal?: number
  usage?: { input?: number; output?: number }
}

interface ChatLine {
  role: 'user' | 'assistant' | 'system'
  text: string
}

export default function App() {
  const [lines, setLines] = useState<ChatLine[]>([])
  const [tools, setTools] = useState<ToolEvent[]>([])
  const [availableTools, setAvailableTools] = useState<string[]>([])
  const [skill, setSkill] = useState<{ name: string; allowedTools: string[] | null } | null>(null)
  const [toolsKnown, setToolsKnown] = useState(false)
  const [modes, setModes] = useState<ModeInfo[]>([])
  const [mode, setMode] = useState('craft')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [conversations, setConversations] = useState<ConversationInfo[]>([])
  const [conversationId, setConversationId] = useState('')
  const [memories, setMemories] = useState<MemoryItem[]>([])
  const [memoryNotice, setMemoryNotice] = useState('')
  const [usage, setUsage] = useState<string>('')
  const [showMemory, setShowMemory] = useState(false)
  const streaming = useRef(false)

  const loadConversations = useCallback(async (selectId?: string) => {
    const r = await window.openwb.conversation.list()
    setConversations(r.conversations)
    const target = selectId ?? r.conversationId
    setConversationId(target)
    return target
  }, [])

  const loadHistory = useCallback(async (id: string) => {
    const r = await window.openwb.conversation.history(id)
    setLines(
      r.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => {
          const content = m.content as { text?: string } | null
          return {
            role: m.role === 'user' ? 'user' : 'assistant',
            text: content?.text ?? JSON.stringify(m.content)
          }
        })
    )
  }, [])

  const loadMemories = useCallback(async () => {
    const r = await window.openwb.memory.list()
    setMemories(r.items)
  }, [])

  useEffect(() => {
    void window.openwb.modes
      .list()
      .then((r) => {
        setModes(r.modes)
        if (r.modes.length > 0 && !r.modes.some((m) => m.id === 'craft')) {
          setMode(r.modes[0]!.id)
        }
      })
      .catch((err: Error) => setLines((l) => [...l, { role: 'system', text: `[错误] 模式加载失败: ${err.message}` }]))

    void (async () => {
      try {
        const id = await loadConversations()
        if (id) await loadHistory(id)
        await loadMemories()
      } catch (err) {
        setLines((l) => [...l, { role: 'system', text: `[错误] 历史加载失败: ${(err as Error).message}` }])
      }
    })()

    return window.openwb.conversation.onEvent((raw: unknown) => {
      const e = raw as AgentEvent
      if (e.type === 'text.start') {
        streaming.current = true
        setLines((l) => [...l, { role: 'assistant', text: '' }])
      } else if (e.type === 'delta' && streaming.current && e.text) {
        setLines((l) => {
          const next = [...l]
          const last = next[next.length - 1]
          if (last && last.role === 'assistant') {
            next[next.length - 1] = { ...last, text: last.text + e.text }
          }
          return next
        })
      } else if (e.type === 'skill.activated') {
        setSkill({ name: e.name ?? '', allowedTools: (e as { allowedTools?: string[] | null }).allowedTools ?? null })
      } else if (e.type === 'memory.injected') {
        const truncated = e.truncatedTotal ?? 0
        const counts = (e.blocks ?? []).map((b) => `${b.scope}:${b.count}`).join(' ')
        setMemoryNotice(
          [
            counts ? `已注入记忆 ${counts}` : '本轮无记忆注入',
            truncated > 0 ? `已截断 ${truncated} 条` : ''
          ]
            .filter(Boolean)
            .join(' · ')
        )
      } else if (e.type === 'tools.available') {
        setAvailableTools(e.names ?? [])
        setToolsKnown(true)
      } else if (e.type === 'tool.started') {
        setTools((t) => [...t, { callId: e.callId ?? '', name: e.name ?? '', ok: null, summary: '' }])
      } else if (e.type === 'tool.finished') {
        setTools((t) =>
          t.map((x) => (x.callId === e.callId ? { ...x, ok: e.ok ?? false, summary: e.summary ?? '' } : x))
        )
      } else if (e.type === 'conversation.ready' && e.conversationId) {
        setConversationId(e.conversationId)
      } else if (e.type === 'done') {
        streaming.current = false
        setBusy(false)
        if (e.usage && (e.usage.input || e.usage.output)) {
          setUsage(`本轮回合计费: 输入 ${e.usage.input ?? 0} / 输出 ${e.usage.output ?? 0} token (接口返回)`)
        }
        void loadConversations(conversationId || undefined).catch(() => {})
        void loadMemories().catch(() => {})
      } else if (e.type === 'error') {
        streaming.current = false
        setBusy(false)
        setLines((l) => [...l, { role: 'system', text: `[错误] ${e.code}: ${e.message}` }])
      }
    })
  }, [conversationId, loadConversations, loadHistory, loadMemories])

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setBusy(true)
    setInput('')
    setTools([])
    setAvailableTools([])
    setToolsKnown(false)
    setSkill(null)
    setUsage('')
    setMemoryNotice('')
    setLines((l) => [...l, { role: 'user', text: `我(${mode}): ${text}` }])
    try {
      await window.openwb.conversation.send({
        text,
        mode,
        ...(conversationId ? { conversationId } : {})
      })
    } catch (err) {
      streaming.current = false
      setBusy(false)
      setLines((l) => [...l, { role: 'system', text: `[错误] 发送失败: ${(err as Error).message}` }])
    }
  }

  const switchConversation = async (id: string) => {
    if (busy) return
    setConversationId(id)
    setTools([])
    setSkill(null)
    setUsage('')
    await loadHistory(id)
    await loadMemories()
  }

  const newConversation = async () => {
    if (busy) return
    const r = await window.openwb.conversation.create({ title: '新会话', mode })
    setConversationId(r.conversationId)
    setLines([])
    setTools([])
    setSkill(null)
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

  return (
    <div style={{ fontFamily: 'system-ui', padding: 16, maxWidth: 1000, margin: '0 auto' }}>
      <h1 style={{ fontSize: 18 }}>OpenWorkBuddy</h1>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        {modes.map((m) => (
          <button
            key={m.id}
            title={m.description}
            onClick={() => setMode(m.id)}
            disabled={busy}
            style={{
              padding: '4px 10px',
              border: mode === m.id ? '2px solid #2563eb' : '1px solid #ccc',
              background: mode === m.id ? '#eff6ff' : '#fff',
              cursor: busy ? 'not-allowed' : 'pointer'
            }}
          >
            {m.displayName}
          </button>
        ))}
      </div>

      <div style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>
        {modes.find((m) => m.id === mode)?.description ?? ''}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'stretch' }}>
        <select
          value={conversationId}
          onChange={(e) => void switchConversation(e.target.value)}
          disabled={busy}
          style={{ padding: 6, maxWidth: 240 }}
          title="历史会话"
        >
          {conversations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title} ({c.lastSeq})
            </option>
          ))}
        </select>
        <button onClick={() => void newConversation()} disabled={busy}>新会话</button>
        <button
          onClick={() => void removeConversation(conversationId)}
          disabled={busy || !conversationId}
        >
          删除会话
        </button>
        <button onClick={() => { setShowMemory((v) => !v); void loadMemories() }}>
          {showMemory ? '收起记忆' : '记忆'} ({memories.length})
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void send() }}
          placeholder="试试:读取 package.json 并告诉我依赖数量"
          style={{ flex: 1, padding: 8 }}
        />
        <button onClick={() => void send()} disabled={busy}>{busy ? '执行中…' : '发送'}</button>
      </div>

      {showMemory && (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 10, marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>
            记忆正文来自磁盘文件,这里是可检索索引;删除会同时从文件移除。
          </div>
          {memories.length === 0 && <div style={{ fontSize: 12, color: '#999' }}>(暂无记忆)</div>}
          {memories.map((m) => (
            <div key={m.id} style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0' }}>
              <span style={{ color: '#7c3aed', minWidth: 70 }}>{m.scope}</span>
              <span style={{ color: '#999', minWidth: 70 }}>{m.kind}</span>
              <span style={{ flex: 1 }}>{m.content}</span>
              <button onClick={() => void removeMemory(m.id)}>删除</button>
            </div>
          ))}
        </div>
      )}

      {memoryNotice && (
        <div style={{ fontSize: 12, color: '#0369a1', marginBottom: 8 }}>{memoryNotice}</div>
      )}

      {skill && (
        <div style={{ fontSize: 12, color: '#7c3aed', marginBottom: 8 }}>
          已加载技能: {skill.name}
          {skill.allowedTools ? `(收窄为 ${skill.allowedTools.join(', ')})` : '(未额外收窄工具)'}
        </div>
      )}

      {toolsKnown && (
        <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
          本轮可用工具: {availableTools.length > 0 ? availableTools.join(', ') : '(无)'}
        </div>
      )}

      {tools.map((t) => (
        <div key={t.callId} style={{ fontSize: 12, color: '#666' }}>
          {t.ok === null ? '调用中' : t.ok ? '已完成' : '失败'} · {t.name}
          {t.summary ? ` · ${t.summary}` : ''}
        </div>
      ))}

      <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
        {lines.map((l, i) => (
          <div key={i} style={{ color: l.role === 'system' ? '#b91c1c' : undefined }}>{l.text}</div>
        ))}
      </div>

      {usage && <div style={{ fontSize: 11, color: '#999', marginTop: 8 }}>{usage}</div>}
    </div>
  )
}
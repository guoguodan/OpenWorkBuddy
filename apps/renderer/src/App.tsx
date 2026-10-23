import { useEffect, useRef, useState } from 'react'

type ToolEvent = { callId: string; name: string; ok: boolean | null; summary: string }
type ModeInfo = { id: string; displayName: string; description: string }
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
}

export default function App() {
  const [messages, setMessages] = useState<string[]>([])
  const [tools, setTools] = useState<ToolEvent[]>([])
  const [availableTools, setAvailableTools] = useState<string[]>([])
  const [skill, setSkill] = useState<{ name: string; allowedTools: string[] | null } | null>(null)
  const [toolsKnown, setToolsKnown] = useState(false)
  const [modes, setModes] = useState<ModeInfo[]>([])
  const [mode, setMode] = useState('craft')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const streaming = useRef(false)

  useEffect(() => {
    void window.openwb.modes.list()
      .then((r) => {
        setModes(r.modes)
        if (r.modes.length > 0 && !r.modes.some((m) => m.id === 'craft')) {
          setMode(r.modes[0]!.id)
        }
      })
      .catch((err: Error) => setMessages((m) => [...m, `[错误] 模式加载失败: ${err.message}`]))

    return window.openwb.conversation.onEvent((raw: unknown) => {
      const e = raw as AgentEvent
      if (e.type === 'text.start') {
        streaming.current = true
        setMessages((m) => [...m, ''])
      } else if (e.type === 'delta' && streaming.current && e.text) {
        setMessages((m) => {
          const next = [...m]
          next[next.length - 1] = (next[next.length - 1] ?? '') + e.text
          return next
        })
      } else if (e.type === 'skill.activated') {
        setSkill({ name: e.name ?? '', allowedTools: (e as { allowedTools?: string[] | null }).allowedTools ?? null })
      } else if (e.type === 'tools.available') {
        setAvailableTools(e.names ?? [])
        setToolsKnown(true)
      } else if (e.type === 'tool.started') {
        setTools((t) => [...t, { callId: e.callId ?? '', name: e.name ?? '', ok: null, summary: '' }])
      } else if (e.type === 'tool.finished') {
        setTools((t) =>
          t.map((x) => (x.callId === e.callId ? { ...x, ok: e.ok ?? false, summary: e.summary ?? '' } : x))
        )
      } else if (e.type === 'done') {
        streaming.current = false
        setBusy(false)
      } else if (e.type === 'error') {
        streaming.current = false
        setBusy(false)
        setMessages((m) => [...m, `[错误] ${e.code}: ${e.message}`])
      }
    })
  }, [])

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setBusy(true)
    setInput('')
    setTools([])
    setAvailableTools([])
    setToolsKnown(false)
    setSkill(null)
    setMessages((m) => [...m, `我(${mode}): ${text}`])
    try {
      await window.openwb.conversation.send({ text, mode })
    } catch (err) {
      streaming.current = false
      setBusy(false)
      setMessages((m) => [...m, `[错误] 发送失败: ${(err as Error).message}`])
    }
  }

  return (
    <div style={{ fontFamily: 'system-ui', padding: 16, maxWidth: 900, margin: '0 auto' }}>
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
        {messages.map((m, i) => <div key={i}>{m}</div>)}
      </div>
    </div>
  )
}

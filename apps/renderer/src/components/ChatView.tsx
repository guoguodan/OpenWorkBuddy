import { useEffect, useRef } from 'react'
import { Markdown } from '../lib/markdown'
import { IconCheck, IconLoader, IconTool, IconX } from './Icons'

export interface ToolCall {
  callId: string
  name: string
  ok: boolean | null
  summary: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt?: string
  streaming?: boolean
}

interface ChatViewProps {
  messages: ChatMessage[]
  tools: ToolCall[]
  modeLabel: string
  busy: boolean
}

function Avatar({ role }: { role: 'user' | 'assistant' }) {
  return <div className="owb-msg__avatar">{role === 'user' ? '我' : 'W'}</div>
}

function ToolRows({ tools }: { tools: ToolCall[] }) {
  if (tools.length === 0) return null
  return (
    <div className="owb-tools">
      {tools.map((t) => (
        <div
          key={t.callId}
          className={`owb-tool ${t.ok === null ? 'owb-tool--running' : t.ok ? 'owb-tool--ok' : 'owb-tool--fail'}`}
        >
          {t.ok === null ? <IconLoader size={14} className="owb-tool__icon" />
            : t.ok ? <IconCheck size={14} className="owb-tool__icon" />
              : <IconX size={14} className="owb-tool__icon" />}
          <IconTool size={13} className="owb-tool__icon" />
          <span className="owb-tool__name">{t.name}</span>
          {t.summary ? <span className="owb-tool__summary" title={t.summary}>{t.summary}</span> : null}
        </div>
      ))}
    </div>
  )
}

export function ChatView({ messages, tools, modeLabel, busy }: ChatViewProps) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight
      stick.current = gap < 80
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (!stick.current) return
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, tools])

  return (
    <div className="owb-chat" data-busy={busy ? '1' : '0'}>
      <div className="owb-chat__messages" ref={ref}>
        <div className="owb-chat__inner">
          {messages.map((m, idx) => {
            const isLast = idx === messages.length - 1
            return (
              <div key={m.id} className={`owb-msg owb-msg--${m.role}`}>
                <Avatar role={m.role} />
                <div className="owb-msg__body">
                  <div className="owb-msg__header">
                    <span className="owb-msg__role">{m.role === 'user' ? `我 · ${modeLabel}` : 'OpenWorkBuddy'}</span>
                    {m.createdAt ? (
                      <span className="owb-msg__time">
                        {new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    ) : null}
                  </div>
                  {m.role === 'user' ? (
                    <div className="owb-msg__bubble">{m.text}</div>
                  ) : (
                    <>
                      {m.text ? (
                        <div className="owb-msg__text">
                          <Markdown text={m.text} />
                        </div>
                      ) : isLast && busy ? (
                        <div className="owb-status"><span className="owb-status__dot" />正在思考…</div>
                      ) : null}
                      {isLast ? <ToolRows tools={tools} /> : null}
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
import { useEffect, useRef } from 'react'
import { Markdown } from '../lib/markdown'
import { IconCheck, IconLoader, IconTool, IconX } from './Icons'
import { ArtifactCards, type ArtifactInfo } from './ArtifactCards'

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
  seq?: number
  createdAt?: string
  streaming?: boolean
}

interface ChatViewProps {
  messages: ChatMessage[]
  tools: ToolCall[]
  artifacts: ArtifactInfo[]
  modeLabel: string
  busy: boolean
  /** 从全局搜索跳转过来时,需要滚到并高亮的消息序号;nonce 让同一序号可重复触发 */
  focusRequest?: { seq: number; nonce: number } | null
  onOpenArtifact: (artifact: ArtifactInfo) => void
  onShareArtifact?: ((artifact: ArtifactInfo) => void) | undefined
  shareChannelName?: string | null | undefined
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

export function ChatView({
  messages,
  tools,
  artifacts,
  modeLabel,
  busy,
  focusRequest,
  onOpenArtifact,
  onShareArtifact,
  shareChannelName
}: ChatViewProps) {
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
    const el = ref.current
    if (!el || !focusRequest) return
    const target = el.querySelector<HTMLElement>(`[data-seq="${focusRequest.seq}"]`)
    if (!target) return
    // 跳转要压过"贴底"逻辑,否则滚到目标后又被拉回最后一条。
    stick.current = false
    target.scrollIntoView({ block: 'center' })
  }, [focusRequest, messages])

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
              <div
                key={m.id}
                className={`owb-msg owb-msg--${m.role}${m.seq !== undefined && m.seq === focusRequest?.seq ? ' owb-msg--focused' : ''}`}
                data-seq={m.seq}
              >
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
                      {isLast ? (
                        <ArtifactCards
                          artifacts={artifacts}
                          onOpen={onOpenArtifact}
                          onShare={onShareArtifact}
                          shareChannelName={shareChannelName}
                        />
                      ) : null}
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

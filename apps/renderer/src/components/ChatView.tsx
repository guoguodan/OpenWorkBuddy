import { useEffect, useRef, useState } from 'react'
import { Markdown } from '../lib/markdown'
import {
  IconCheck,
  IconCopy,
  IconLoader,
  IconThumbDown,
  IconThumbUp,
  IconTool,
  IconX
} from './Icons'
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
  feedback?: 'like' | 'dislike' | null
  feedbackReason?: string | null
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
  onFeedback?: (message: ChatMessage, feedback: 'like' | 'dislike' | null, reason?: string) => Promise<void>
}

const DISLIKE_REASONS = [
  { id: 'misunderstanding', label: '误解问题' },
  { id: 'context_error', label: '上下文错误' },
  { id: 'answer_obscure', label: '答案不清晰' },
  { id: 'code_error', label: '代码错误' },
  { id: 'unprofessional_answer', label: '回答不专业' },
  { id: 'code_format_error', label: '代码格式错误' },
  { id: 'other', label: '其他' }
] as const

const OTHER_REASON_LIMIT = 500

function Avatar({ role }: { role: 'user' | 'assistant' }) {
  return <div className="owb-msg__avatar">{role === 'user' ? '我' : 'W'}</div>
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 某些运行环境没有剪贴板权限;用隐藏 textarea 兜底,避免按钮看似成功但什么都没复制。
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch {
      return false
    }
  }
}

function MessageToolbar({
  message,
  onFeedback
}: {
  message: ChatMessage
  onFeedback?: ChatViewProps['onFeedback']
}) {
  const [copied, setCopied] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [otherText, setOtherText] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const doCopy = async () => {
    if (await copyText(message.text)) setCopied(true)
  }

  const toggleFeedback = async (next: 'like' | 'dislike') => {
    if (!onFeedback || !message.id) return
    if (next === 'like') {
      const value = message.feedback === 'like' ? null : 'like'
      await onFeedback(message, value)
      return
    }
    if (message.feedback === 'dislike') {
      await onFeedback(message, null)
      return
    }
    setSelected([])
    setOtherText('')
    setDialogOpen(true)
  }

  const submitDislike = async () => {
    if (selected.length === 0 || submitting || !onFeedback) return
    setSubmitting(true)
    try {
      const reasonIds = selected.join(',')
      const reason = selected.includes('other') && otherText.trim()
        ? reasonIds + '|' + otherText.trim()
        : reasonIds
      await onFeedback(message, 'dislike', reason)
      setDialogOpen(false)
    } finally {
      setSubmitting(false)
    }
  }

  const canFeedback = Boolean(onFeedback && message.id && !message.streaming)
  return (
    <>
      <div className="owb-msg-actions" data-testid={'message-actions-' + message.id}>
        <button
          type="button"
          className={'owb-msg-action' + (copied ? ' owb-msg-action--active' : '')}
          aria-label={copied ? '已复制' : '复制'}
          title={copied ? '已复制' : '复制'}
          onClick={() => void doCopy()}
          data-testid="message-copy"
        >
          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          {copied ? <span className="owb-msg-action__text">已复制</span> : null}
        </button>
        {message.role === 'assistant' && canFeedback ? (
          <>
            <button
              type="button"
              className={'owb-msg-action' + (message.feedback === 'like' ? ' owb-msg-action--active' : '')}
              aria-label="点赞"
              aria-pressed={message.feedback === 'like'}
              title="点赞"
              onClick={() => void toggleFeedback('like')}
              data-testid="message-like"
            >
              <IconThumbUp size={14} />
            </button>
            <button
              type="button"
              className={'owb-msg-action' + (message.feedback === 'dislike' ? ' owb-msg-action--active' : '')}
              aria-label="点踩"
              aria-pressed={message.feedback === 'dislike'}
              title="点踩"
              onClick={() => void toggleFeedback('dislike')}
              data-testid="message-dislike"
            >
              <IconThumbDown size={14} />
            </button>
          </>
        ) : null}
      </div>
      {dialogOpen ? (
        <div className="owb-feedback-backdrop" onClick={() => setDialogOpen(false)}>
          <div
            className="owb-feedback"
            role="dialog"
            aria-modal="true"
            aria-label="选择不满意原因"
            onClick={(event) => event.stopPropagation()}
            data-testid="dislike-dialog"
          >
            <div className="owb-feedback__header">
              <span className="owb-feedback__title">请选择不满意原因</span>
              <button
                type="button"
                className="owb-feedback__close"
                aria-label="关闭"
                onClick={() => setDialogOpen(false)}
              >
                <IconX size={14} />
              </button>
            </div>
            <div className="owb-feedback__items" role="listbox" aria-multiselectable="true">
              {DISLIKE_REASONS.map((reason) => {
                const active = selected.includes(reason.id)
                return (
                  <button
                    key={reason.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={'owb-feedback__item' + (active ? ' owb-feedback__item--active' : '')}
                    onClick={() => {
                      setSelected((list) =>
                        active ? list.filter((item) => item !== reason.id) : [...list, reason.id]
                      )
                      if (reason.id === 'other' && active) setOtherText('')
                    }}
                  >
                    {reason.label}
                  </button>
                )
              })}
            </div>
            {selected.includes('other') ? (
              <div className="owb-feedback__other">
                <textarea
                  value={otherText}
                  onChange={(event) => setOtherText(event.target.value.slice(0, OTHER_REASON_LIMIT))}
                  placeholder="请描述具体原因"
                  rows={3}
                  maxLength={OTHER_REASON_LIMIT}
                  aria-label="具体原因"
                />
                <div className="owb-feedback__counter">
                  {otherText.length}/{OTHER_REASON_LIMIT}
                </div>
              </div>
            ) : null}
            <div className="owb-feedback__footer">
              <button
                type="button"
                className="owb-feedback__submit"
                disabled={selected.length === 0 || submitting}
                onClick={() => void submitDislike()}
                data-testid="dislike-submit"
              >
                提交反馈
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
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
  shareChannelName,
  onFeedback
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
    <div className="owb-chat" data-busy={busy ? '1' : '0'} data-testid="chat">
      <div className="owb-chat__messages" ref={ref}>
        <div className="owb-chat__inner">
          {messages.map((m, idx) => {
            const isLast = idx === messages.length - 1
            return (
              <div
                key={m.id}
                className={`owb-msg owb-msg--${m.role}${m.streaming ? ' owb-msg--streaming' : ''}${m.seq !== undefined && m.seq === focusRequest?.seq ? ' owb-msg--focused' : ''}`}
                data-seq={m.seq}
                data-streaming={m.streaming ? '1' : '0'}
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
                      <MessageToolbar message={m} onFeedback={onFeedback} />
                    </>
                  )}
                  {m.role === 'user' ? <MessageToolbar message={m} onFeedback={onFeedback} /> : null}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

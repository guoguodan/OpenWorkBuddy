import { useEffect, useRef } from 'react'
import { IconSend, IconStop } from './Icons'
import { ModeTabs, type ModeInfo } from './ModeTabs'

interface ComposerProps {
  value: string
  busy: boolean
  mode: string
  modes: ModeInfo[]
  showModes?: boolean
  placeholder: string
  autoFocus?: boolean
  onChange: (v: string) => void
  onSend: () => void
  onStop?: () => void
  onModeChange: (id: string) => void
}

export function Composer({
  value,
  busy,
  mode,
  modes,
  showModes = true,
  placeholder,
  autoFocus,
  onChange,
  onSend,
  onModeChange
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  const resize = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  useEffect(resize, [value])

  return (
    <div className="owb-composer">
      <div className="owb-composer__box">
        <div className="owb-composer__editor">
          <textarea
            ref={ref}
            rows={1}
            data-testid="composer-input"
            value={value}
            placeholder={placeholder}
            aria-label="输入消息"
            onChange={(e) => { onChange(e.target.value); resize() }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                onSend()
              }
            }}
          />
        </div>
        <div className="owb-composer__toolbar">
          <div className="owb-composer__left">
            {showModes ? (
              <ModeTabs modes={modes} mode={mode} busy={busy} variant="compact" onSelect={onModeChange} />
            ) : null}
          </div>
          <div className="owb-composer__right">
            {busy ? (
              <button className="owb-stop-btn" disabled title="本次运行结束后才能继续">
                <IconStop size={12} />
                执行中
              </button>
            ) : (
              <button
                className="owb-send-btn"
                onClick={onSend}
                disabled={!value.trim()}
                title="发送 (Enter)"
                aria-label="发送"
              >
                发送
                <IconSend size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
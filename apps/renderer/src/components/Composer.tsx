import { useEffect, useRef, useState } from 'react'
import { IconArrowUp, IconAt, IconChevron, IconFolder, IconMic, IconStop, IconTool } from './Icons'

export type PermissionMode = 'default' | 'fullAccess' | 'readOnly'

export interface ComposerSkill {
  name: string
  description: string
}

interface ComposerProps {
  value: string
  busy: boolean
  placeholder?: string
  autoFocus?: boolean
  skills: ComposerSkill[]
  selectedSkill: string | null
  workspaceLabel: string
  workspacePath: string
  permission: PermissionMode
  modelLabel: string
  onChange: (v: string) => void
  onSend: () => void
  onPickSkill: (name: string | null) => void
  onPickPermission: (mode: PermissionMode) => void
  onOpenWorkspace: () => void
}

const PERMISSIONS: Array<{ id: PermissionMode; label: string; detail: string }> = [
  { id: 'default', label: '默认权限', detail: '敏感操作会先询问你' },
  { id: 'fullAccess', label: '完全访问', detail: '已知风险自动放行，计费类仍会询问' },
  { id: 'readOnly', label: '只读', detail: '禁止写入、删除与执行命令' }
]

export function Composer({
  value,
  busy,
  placeholder = '告诉我你想做些什么？  @ 添加上下文，/ 调用技能与指令',
  autoFocus,
  skills,
  selectedSkill,
  workspaceLabel,
  workspacePath,
  permission,
  modelLabel,
  onChange,
  onSend,
  onPickSkill,
  onPickPermission,
  onOpenWorkspace
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [menu, setMenu] = useState<'skill' | 'permission' | null>(null)

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => {
      const el = document.querySelector('.owb-composer__menu-host')
      if (!el?.contains(e.target as Node)) setMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menu])

  const resize = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }

  useEffect(resize, [value])

  const currentPermission = PERMISSIONS.find((item) => item.id === permission) ?? PERMISSIONS[0]!

  return (
    <div className="owb-composer" data-testid="composer">
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
          <div className="owb-composer__left owb-composer__menu-host">
            <button
              type="button"
              className={`owb-composer__chip${selectedSkill ? ' owb-composer__chip--on' : ''}`}
              onClick={() => setMenu(menu === 'skill' ? null : 'skill')}
              title="调用技能与指令"
              aria-label="调用技能与指令"
            >
              <IconTool size={14} />
              {selectedSkill ?? '技能'}
              <IconChevron size={12} />
            </button>
            {menu === 'skill' ? (
              <div className="owb-composer__menu" role="menu" aria-label="技能列表">
                <button
                  type="button"
                  role="menuitem"
                  className="owb-composer__menu-item"
                  onClick={() => { onPickSkill(null); setMenu(null) }}
                >
                  <span>不使用技能</span>
                  {selectedSkill === null ? <span className="owb-composer__tick">✓</span> : null}
                </button>
                {skills.length === 0 ? (
                  <div className="owb-composer__menu-empty">还没有安装技能</div>
                ) : (
                  skills.map((skill) => (
                    <button
                      key={skill.name}
                      type="button"
                      role="menuitem"
                      className="owb-composer__menu-item"
                      title={skill.description}
                      onClick={() => { onPickSkill(skill.name); setMenu(null) }}
                    >
                      <span>{skill.name}</span>
                      {selectedSkill === skill.name ? <span className="owb-composer__tick">✓</span> : null}
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>

          <div className="owb-composer__right">
            <span className="owb-composer__model" title="当前模型">
              <IconChevron size={12} />
              {modelLabel}
            </span>
            <button type="button" className="owb-icon-btn owb-composer__icon" title="语音输入" aria-label="语音输入">
              <IconMic size={17} />
            </button>
            {busy ? (
              <button className="owb-composer__send owb-composer__send--busy" disabled title="本次运行结束后才能继续">
                <IconStop size={13} />
              </button>
            ) : (
              <button
                type="button"
                className="owb-composer__send"
                onClick={onSend}
                disabled={!value.trim()}
                title="发送 (Enter)"
                aria-label="发送"
              >
                <IconArrowUp size={18} />
              </button>
            )}
          </div>
        </div>

        <div className="owb-composer__meta owb-composer__menu-host">
          <button type="button" className="owb-composer__meta-btn" onClick={onOpenWorkspace} title={workspacePath}>
            <IconFolder size={14} />
            {workspaceLabel}
            <IconChevron size={12} />
          </button>
          <button
            type="button"
            className="owb-composer__meta-btn"
            onClick={() => setMenu(menu === 'permission' ? null : 'permission')}
            aria-expanded={menu === 'permission'}
            title={currentPermission.detail}
          >
            <IconAt size={14} />
            {currentPermission.label}
            <IconChevron size={12} />
          </button>
          {menu === 'permission' ? (
            <div className="owb-composer__menu owb-composer__menu--meta" role="menu" aria-label="权限档位">
              {PERMISSIONS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={permission === item.id}
                  className="owb-composer__menu-item owb-composer__menu-item--stack"
                  onClick={() => { onPickPermission(item.id); setMenu(null) }}
                >
                  <span>
                    {item.label}
                    {permission === item.id ? <span className="owb-composer__tick"> ✓</span> : null}
                  </span>
                  <span className="owb-composer__menu-detail">{item.detail}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

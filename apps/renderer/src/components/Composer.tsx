import { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconArrowUp,
  IconAt,
  IconChevron,
  IconFile,
  IconFolder,
  IconMic,
  IconModel,
  IconStop,
  IconTool,
  IconX
} from './Icons'

export type PermissionMode = 'default' | 'fullAccess' | 'readOnly'

export interface ComposerSkill {
  name: string
  description: string
}

export interface ComposerAttachment {
  path: string
  name: string
  size: number
}

interface ComposerProps {
  value: string
  busy: boolean
  placeholder?: string
  autoFocus?: boolean
  skills: ComposerSkill[]
  selectedSkill: string | null
  attachments: ComposerAttachment[]
  workspaceLabel: string
  workspacePath: string
  permission: PermissionMode
  modelLabel: string
  onChange: (v: string) => void
  onSend: () => void
  onPickSkill: (name: string | null) => void
  onPickPermission: (mode: PermissionMode) => void
  onOpenWorkspace: () => void
  onListFiles: () => Promise<ComposerAttachment[]>
  onAddAttachment: (file: ComposerAttachment) => void
  onRemoveAttachment: (path: string) => void
}

const PERMISSIONS: Array<{ id: PermissionMode; label: string; detail: string }> = [
  { id: 'default', label: '默认权限', detail: '敏感操作会先询问你' },
  { id: 'fullAccess', label: '完全访问', detail: '已知风险自动放行，计费类仍会询问' },
  { id: 'readOnly', label: '只读', detail: '禁止写入、删除与执行命令' }
]

const MAX_ATTACHMENTS = 20

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/**
 * 找到光标前正在输入的 @ 片段。
 *
 * 只认行首或空白后的 @,所以邮箱、正文里的 @ 不会弹出文件菜单;
 * 选择器只负责挑"相对工作区的路径",真正的越界校验仍在 daemon。
 */
function atQueryAt(text: string, cursor: number): { query: string; start: number } | null {
  const at = text.lastIndexOf('@', Math.max(0, cursor - 1))
  if (at < 0) return null
  const before = text.slice(0, at)
  if (before.length > 0 && !/\s$/.test(before)) return null
  const query = text.slice(at + 1, cursor)
  if (/\s/.test(query)) return null
  return { query, start: at }
}

/** 行首或空白后的 / 才视为技能指令,避免误伤 docs/a.md 这类路径。 */
function slashQueryAt(text: string, cursor: number): { query: string; start: number } | null {
  const slash = text.lastIndexOf('/', Math.max(0, cursor - 1))
  if (slash < 0) return null
  const before = text.slice(0, slash)
  if (before.length > 0 && !/\s$/.test(before)) return null
  const query = text.slice(slash + 1, cursor)
  if (/[\s/]/.test(query)) return null
  return { query, start: slash }
}

function removeFragment(text: string, start: number, cursor: number): string {
  return `${text.slice(0, start)}${text.slice(cursor)}`
}

export function Composer({
  value,
  busy,
  placeholder = '告诉我你想做些什么？ @ 添加上下文，/调用技能与指令',
  autoFocus,
  skills,
  selectedSkill,
  attachments,
  workspaceLabel,
  workspacePath,
  permission,
  modelLabel,
  onChange,
  onSend,
  onPickSkill,
  onPickPermission,
  onOpenWorkspace,
  onListFiles,
  onAddAttachment,
  onRemoveAttachment
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<'file' | 'skill' | 'permission' | null>(null)
  const [atQuery, setAtQuery] = useState('')
  const [slashQuery, setSlashQuery] = useState('')
  const [files, setFiles] = useState<ComposerAttachment[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [filesLoaded, setFilesLoaded] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const pendingRef = useRef<{ kind: 'file' | 'skill'; start: number } | null>(null)

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenu(null)
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

  const loadFiles = async () => {
    if (filesLoading) return
    setFilesLoading(true)
    try {
      const list = await onListFiles()
      setFiles(list)
      setFilesLoaded(true)
    } catch {
      setFiles([])
      setFilesLoaded(true)
    } finally {
      setFilesLoading(false)
    }
  }

  const filteredFiles = useMemo(() => {
    const q = atQuery.trim().toLowerCase()
    const attached = new Set(attachments.map((a) => a.path))
    const base = files.filter((f) => !attached.has(f.path))
    if (!q) return base.slice(0, 40)
    return base
      .filter((f) => f.path.toLowerCase().includes(q) || f.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const an = a.name.toLowerCase().startsWith(q) ? 0 : 1
        const bn = b.name.toLowerCase().startsWith(q) ? 0 : 1
        if (an !== bn) return an - bn
        return a.path.length - b.path.length
      })
      .slice(0, 40)
  }, [atQuery, files, attachments])

  const filteredSkills = useMemo(() => {
    const q = slashQuery.trim().toLowerCase()
    if (!q) return skills
    return skills.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    )
  }, [slashQuery, skills])

  useEffect(() => {
    setActiveIndex(0)
  }, [menu, atQuery, slashQuery])

  const openFilePicker = (query: string) => {
    setMenu('file')
    setAtQuery(query)
    if (!filesLoaded) void loadFiles()
  }

  const chooseFile = (file: ComposerAttachment) => {
    const el = ref.current
    const cursor = el?.selectionStart ?? value.length
    const start = pendingRef.current?.start
    const next = start !== undefined ? removeFragment(value, start, cursor) : value
    onChange(next)
    if (attachments.length >= MAX_ATTACHMENTS) {
      // 上限由 daemon 与 UI 双重约束;到上限后不悄悄丢弃已有附件。
      setMenu(null)
      return
    }
    onAddAttachment(file)
    setMenu(null)
    pendingRef.current = null
    requestAnimationFrame(() => {
      const node = ref.current
      if (!node) return
      node.focus()
      const pos = start ?? next.length
      node.setSelectionRange(pos, pos)
    })
  }

  const chooseSkill = (name: string) => {
    const el = ref.current
    const cursor = el?.selectionStart ?? value.length
    const start = pendingRef.current?.start
    const next = start !== undefined ? removeFragment(value, start, cursor) : value
    onChange(next)
    onPickSkill(name)
    setMenu(null)
    pendingRef.current = null
    requestAnimationFrame(() => {
      const node = ref.current
      if (!node) return
      node.focus()
      const pos = start ?? next.length
      node.setSelectionRange(pos, pos)
    })
  }

  const handleChange = (next: string) => {
    onChange(next)
    const cursor = ref.current?.selectionStart ?? next.length
    const at = atQueryAt(next, cursor)
    const slash = slashQueryAt(next, cursor)
    if (at) {
      pendingRef.current = { kind: 'file', start: at.start }
      openFilePicker(at.query)
      return
    }
    if (slash) {
      pendingRef.current = { kind: 'skill', start: slash.start }
      setMenu('skill')
      setSlashQuery(slash.query)
      return
    }
    if (menu === 'file' || menu === 'skill') setMenu(null)
    pendingRef.current = null
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const pickerOpen = menu === 'file' || menu === 'skill'
    if (pickerOpen) {
      const count = menu === 'file' ? filteredFiles.length : filteredSkills.length
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (count === 0 ? 0 : (i + 1) % count))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (count === 0 ? 0 : (i - 1 + count) % count))
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMenu(null)
        return
      }
      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
        e.preventDefault()
        if (menu === 'file') {
          const file = filteredFiles[activeIndex]
          if (file) chooseFile(file)
        } else {
          const skill = filteredSkills[activeIndex]
          if (skill) chooseSkill(skill.name)
        }
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      onSend()
    }
  }

  return (
    <div className="owb-composer" data-testid="composer" ref={rootRef}>
      <div className="owb-composer__box">
        {menu === 'file' ? (
          <div className="owb-composer__picker" role="listbox" aria-label="添加上下文" data-testid="composer-picker">
            <div className="owb-composer__picker-head">
              <IconFolder size={14} />
              <span>从工作区添加</span>
              <span className="owb-composer__picker-hint">@ 继续输入可筛选</span>
            </div>
            {filesLoading ? (
              <div className="owb-composer__menu-empty">正在读取工作区文件…</div>
            ) : filteredFiles.length === 0 ? (
              <div className="owb-composer__menu-empty">
                {files.some((f) => attachments.some((a) => a.path === f.path))
                  ? '工作区文件都已添加'
                  : filesLoaded
                    ? '没有匹配的文件'
                    : '工作区里还没有文件'}
              </div>
            ) : (
              filteredFiles.map((file, index) => (
                <button
                  key={file.path}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  data-testid="picker-file"
                  className={`owb-composer__menu-item owb-composer__picker-item${index === activeIndex ? ' owb-composer__picker-item--active' : ''}`}
                  title={file.path}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => chooseFile(file)}
                >
                  <span className="owb-composer__picker-name">
                    <IconFile size={14} />
                    {file.name}
                  </span>
                  <span className="owb-composer__picker-path">
                    {file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : formatSize(file.size)}
                  </span>
                </button>
              ))
            )}
          </div>
        ) : null}

        {menu === 'skill' ? (
          <div className="owb-composer__picker" role="listbox" aria-label="调用技能与指令" data-testid="composer-picker">
            <div className="owb-composer__picker-head">
              <IconTool size={14} />
              <span>调用技能与指令</span>
              <span className="owb-composer__picker-hint">/ 继续输入可筛选</span>
            </div>
            {filteredSkills.length === 0 ? (
              <div className="owb-composer__menu-empty">
                {skills.length === 0 ? '还没有安装技能' : '没有匹配的技能'}
              </div>
            ) : (
              filteredSkills.map((skill, index) => (
                <button
                  key={skill.name}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  data-testid="picker-skill"
                  className={`owb-composer__menu-item owb-composer__picker-item${index === activeIndex ? ' owb-composer__picker-item--active' : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => chooseSkill(skill.name)}
                >
                  <span className="owb-composer__picker-name">
                    <IconTool size={14} />
                    {skill.name}
                  </span>
                  <span className="owb-composer__picker-path">{skill.description}</span>
                </button>
              ))
            )}
          </div>
        ) : null}

        <div className="owb-composer__editor">
          {attachments.length > 0 ? (
            <div className="owb-composer__attachments" aria-label="已添加上下文">
              {attachments.map((file) => (
                <span key={file.path} className="owb-composer__attachment" data-testid="attachment-chip" title={file.path}>
                  <IconFile size={13} />
                  <span className="owb-composer__attachment-name">{file.name}</span>
                  <button
                    type="button"
                    className="owb-composer__attachment-remove"
                    aria-label={`移除 ${file.name}`}
                    onClick={() => onRemoveAttachment(file.path)}
                  >
                    <IconX size={12} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            ref={ref}
            rows={1}
            data-testid="composer-input"
            value={value}
            placeholder={placeholder}
            aria-label="输入消息"
            onChange={(e) => handleChange(e.target.value)}
            onClick={(e) => {
              const cursor = e.currentTarget.selectionStart ?? 0
              const at = atQueryAt(value, cursor)
              const slash = slashQueryAt(value, cursor)
              if (at) {
                pendingRef.current = { kind: 'file', start: at.start }
                openFilePicker(at.query)
              } else if (slash) {
                pendingRef.current = { kind: 'skill', start: slash.start }
                setMenu('skill')
                setSlashQuery(slash.query)
              }
            }}
            onKeyDown={handleKeyDown}
          />
        </div>

        <div className="owb-composer__toolbar">
          <div className="owb-composer__left">
            {selectedSkill ? (
              <button
                type="button"
                className="owb-composer__chip owb-composer__chip--on"
                onClick={() => onPickSkill(null)}
                title="移除技能"
                aria-label={`移除技能 ${selectedSkill}`}
                data-testid="selected-skill"
              >
                <IconTool size={14} />
                {selectedSkill}
                <IconX size={12} />
              </button>
            ) : null}
            {attachments.length > 0 ? (
              <span className="owb-composer__hint" data-testid="attachment-count">
                已添加 {attachments.length} 个文件
              </span>
            ) : null}
          </div>

          <div className="owb-composer__right">
            <span className="owb-composer__model" title="当前模型">
              <IconModel size={15} className="owb-composer__model-icon" />
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
                disabled={!value.trim() && attachments.length === 0}
                title="发送 (Enter)"
                aria-label="发送"
              >
                <IconArrowUp size={18} />
              </button>
            )}
          </div>
        </div>

        <div className="owb-composer__meta">
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

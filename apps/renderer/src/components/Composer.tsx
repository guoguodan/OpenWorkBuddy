import { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconArrowUp,
  IconAt,
  IconChevron,
  IconFile,
  IconFolder,
  IconImage,
  IconMic,
  IconModel,
  IconPlus,
  IconStop,
  IconTool,
  IconX
} from './Icons'
import { useVoiceInput, VOICE_TEXT } from './useVoiceInput'

export type PermissionMode = 'default' | 'fullAccess' | 'readOnly'

export interface ComposerSkill {
  name: string
  description: string
}

export interface ComposerAttachment {
  path: string
  name: string
  size: number
  kind?: 'file' | 'image' | 'folder'
  source?: 'upload' | 'workspace'
}

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

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
  reasoningEffort: ReasoningEffort | null
  modelLoading?: boolean
  modelOptions?: string[]
  modelsLoading?: boolean
  modelsError?: string | null
  onChange: (v: string) => void
  onSend: () => void
  onStop: () => void
  onPickSkill: (name: string | null) => void
  onPickPermission: (mode: PermissionMode) => void
  onPickModel: (name: string) => void
  onPickReasoningEffort: (effort: ReasoningEffort | null) => void
  onVoiceError: (message: string) => void
  onOpenModelMenu?: () => void
  onOpenWorkspace: () => void
  onListFiles: () => Promise<ComposerAttachment[]>
  onAddAttachment: (file: ComposerAttachment) => void
  onAddAttachments: (files: ComposerAttachment[]) => void
  onRemoveAttachment: (path: string) => void
  onPickAttachments: () => Promise<void>
  onImportDroppedFiles: (files: File[]) => Promise<void>
}

const PERMISSIONS: Array<{ id: PermissionMode; label: string; detail: string }> = [
  { id: 'default', label: '默认权限', detail: '敏感操作会先询问你' },
  { id: 'fullAccess', label: '完全访问', detail: '已知风险自动放行，计费类仍会询问' },
  { id: 'readOnly', label: '只读', detail: '禁止写入、删除与执行命令' }
]

const MAX_ATTACHMENTS = 50

/**
 * 思考强度档位与真实产品一致:低/中/高/超高/极致,外加"自动"。
 * 自动不向网关传参数,由模型自身决定,避免对非推理模型伪造能力。
 */
const EFFORTS: Array<{ id: ReasoningEffort | null; label: string }> = [
  { id: null, label: '自动' },
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
  { id: 'xhigh', label: '超高' },
  { id: 'max', label: '极致' }
]

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
  reasoningEffort,
  modelLoading = false,
  modelOptions = [],
  modelsLoading = false,
  modelsError = null,
  onChange,
  onSend,
  onStop,
  onPickSkill,
  onPickPermission,
  onPickModel,
  onPickReasoningEffort,
  onVoiceError,
  onOpenModelMenu,
  onOpenWorkspace,
  onListFiles,
  onAddAttachment,
  onAddAttachments,
  onRemoveAttachment,
  onPickAttachments,
  onImportDroppedFiles
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<'file' | 'skill' | 'permission' | 'model' | 'effort' | null>(null)
  const [modelDraft, setModelDraft] = useState('')
  const [atQuery, setAtQuery] = useState('')
  const [slashQuery, setSlashQuery] = useState('')
  const [files, setFiles] = useState<ComposerAttachment[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [filesLoaded, setFilesLoaded] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const pendingRef = useRef<{ kind: 'file' | 'skill'; start: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const valueRef = useRef(value)
  valueRef.current = value

  /**
   * 把识别文本插到当前光标处,不覆盖用户已经输入的内容。
   * 语音和键盘可能同时存在,所以中英文之间也不强行加空格以外的分隔。
   */
  const insertVoiceText = (text: string) => {
    const node = ref.current
    const current = valueRef.current
    const start = node?.selectionStart ?? current.length
    const end = node?.selectionEnd ?? start
    const before = current.slice(0, start)
    const after = current.slice(end)
    const needsLeadingSpace = before.length > 0 && !/\s$/.test(before)
    const needsTrailingSpace = after.length > 0 && !/^\s/.test(after)
    const inserted = `${needsLeadingSpace ? ' ' : ''}${text}${needsTrailingSpace ? ' ' : ''}`
    const next = `${before}${inserted}${after}`
    onChange(next)
    requestAnimationFrame(() => {
      const target = ref.current
      if (!target) return
      const pos = before.length + inserted.length
      target.focus()
      target.setSelectionRange(pos, pos)
    })
  }

  const voice = useVoiceInput({
    disabled: busy,
    onText: insertVoiceText,
    onError: onVoiceError
  })

  // 真实产品支持"点击或长按 ALT"。长按阈值避免误吞普通的 Alt 组合键。
  // 监听只注册一次:录音一开始 state 就会变,若把 voice 放进依赖,
  // effect 重建会把"本次长按已启动"的标记清掉,松开 ALT 便收不到 stop。
  const voiceRef = useRef(voice)
  voiceRef.current = voice
  const busyRef = useRef(busy)
  busyRef.current = busy
  const holdTimerRef = useRef<number | null>(null)
  const heldRef = useRef(false)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Alt' || event.repeat || event.ctrlKey || event.metaKey || event.shiftKey) return
      const current = voiceRef.current
      if (current.state !== 'idle' || busyRef.current) return
      // ALT 是全局快捷键:焦点在别处也应能录音。仅当用户正在另一个输入框里
      // 按 Alt 组合键时才让位,避免抢占其他编辑行为。
      const target = event.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      const editable =
        (tag === 'input' || tag === 'textarea' || target?.isContentEditable === true) &&
        target !== ref.current &&
        !rootRef.current?.contains(target)
      if (editable) return
      if (holdTimerRef.current !== null || heldRef.current) return
      holdTimerRef.current = window.setTimeout(() => {
        holdTimerRef.current = null
        heldRef.current = true
        void voiceRef.current.start()
      }, 450)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Alt') return
      if (holdTimerRef.current !== null) {
        window.clearTimeout(holdTimerRef.current)
        holdTimerRef.current = null
      }
      if (heldRef.current) {
        heldRef.current = false
        voiceRef.current.stop()
      }
    }
    const onCancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || voiceRef.current.state !== 'recording') return
      event.preventDefault()
      heldRef.current = false
      voiceRef.current.cancel()
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)
    document.addEventListener('keydown', onCancel)
    return () => {
      if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('keydown', onCancel)
    }
  }, [])

  const voiceSeconds = Math.floor(voice.elapsedMs / 1000)
  const voiceTimer = `${String(Math.floor(voiceSeconds / 60)).padStart(2, '0')}:${String(voiceSeconds % 60).padStart(2, '0')}`

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

  /**
   * 文件拖拽是全窗口行为:用户不会精确瞄准输入框,只要把文件拖进页面就应能添加。
   * dragenter/dragleave 会冒泡经过大量子节点,用计数避免覆盖层闪烁。
   */
  useEffect(() => {
    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files')
    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepth.current += 1
      setDragging(true)
    }
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    }
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const dropped = Array.from(event.dataTransfer?.files ?? [])
      if (dropped.length > 0) void onImportDroppedFiles(dropped)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [onImportDroppedFiles])

  const currentPermission = PERMISSIONS.find((item) => item.id === permission) ?? PERMISSIONS[0]!
  // 设置是通过 IPC 异步读取的。首帧直接显示“未配置模型”会让用户误以为
  // 模型丢了,所以加载阶段单独显示占位状态。
  const currentModel = modelLoading ? '加载中…' : modelLabel.trim() || '未配置模型'
  /**
   * 菜单只列网关真实返回的候选。
   *
   * 不能把“当前值”混进候选:拉取失败时那样会显示一条看似来自网关的模型,
   * 用户无法判断这个模型到底存不存在。当前值单独用勾选态标记。
   */
  const models = useMemo(() => {
    return [...new Set(modelOptions.map((item) => item.trim()).filter(Boolean))]
  }, [modelOptions])
  const currentSelected = modelLabel.trim()
  const currentEffort = EFFORTS.find((item) => item.id === reasoningEffort) ?? EFFORTS[0]!
  const pickModel = (name: string) => {
    const next = name.trim()
    if (!next) return
    onPickModel(next)
    setModelDraft('')
    setMenu(null)
  }

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
      {dragging ? (
        <div className="owb-composer__drop" data-testid="attachment-drop-overlay" aria-live="polite">
          <div className="owb-composer__drop-card">
            <IconPlus size={24} />
            <strong>松开即可添加文件</strong>
            <span>最多支持上传 {MAX_ATTACHMENTS} 个文件，支持常见文件类型</span>
          </div>
        </div>
      ) : null}
      <div className={`owb-composer__box${voice.state === 'recording' ? ' owb-composer__box--recording' : ''}`}>
        {menu === 'file' ? (
          <div className="owb-composer__picker" role="listbox" aria-label="添加文件作为回答背景" data-testid="composer-picker">
            <div className="owb-composer__picker-head">
              <IconFolder size={14} />
              <span>选择文件和文件夹</span>
              <span className="owb-composer__picker-hint">@ 继续输入可筛选</span>
            </div>
            {filesLoading ? (
              <div className="owb-composer__menu-empty">正在读取工作区文件…</div>
            ) : filteredFiles.length === 0 ? (
              <div className="owb-composer__menu-empty">
                {files.some((f) => attachments.some((a) => a.path === f.path))
                  ? '工作区文件都已添加'
                  : filesLoaded
                    ? '无搜索结果'
                    : '当前对话中暂无文件'}
              </div>
            ) : (
              filteredFiles.map((file, index) => (
                <button
                  key={file.path}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  data-testid="picker-file"
                  data-kind={file.kind ?? 'file'}
                  className={`owb-composer__menu-item owb-composer__picker-item${index === activeIndex ? ' owb-composer__picker-item--active' : ''}`}
                  title={file.path}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => chooseFile(file)}
                >
                  <span className="owb-composer__picker-name">
                    {file.kind === 'folder' ? <IconFolder size={14} /> : <IconFile size={14} />}
                    {file.name}
                  </span>
                  <span className="owb-composer__picker-path">
                    {file.kind === 'folder'
                      ? '文件夹'
                      : file.path.includes('/')
                        ? file.path.slice(0, file.path.lastIndexOf('/'))
                        : formatSize(file.size)}
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
                <span key={file.path} className="owb-composer__attachment" data-testid="attachment-chip" data-kind={file.kind ?? 'file'} title={file.name}>
                  {file.kind === 'image' ? (
                    <IconImage size={13} />
                  ) : file.kind === 'folder' ? (
                    <IconFolder size={13} />
                  ) : (
                    <IconFile size={13} />
                  )}
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
            <button
              type="button"
              className="owb-icon-btn owb-composer__icon"
              title="添加文件"
              aria-label="添加文件"
              data-testid="attachment-picker-trigger"
              onClick={() => void onPickAttachments()}
            >
              <IconPlus size={17} />
            </button>
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
                已添加 {attachments.length} 项
              </span>
            ) : null}
          </div>

          <div className="owb-composer__right">
            <button
              type="button"
              className="owb-composer__model"
              title="切换模型"
              aria-label="切换模型"
              aria-haspopup="menu"
              aria-expanded={menu === 'model'}
              aria-disabled={modelLoading}
              data-testid="model-picker-trigger"
              onClick={() => {
                if (modelLoading) return
                setModelDraft('')
                const next = menu === 'model' ? null : 'model'
                setMenu(next)
                if (next === 'model') onOpenModelMenu?.()
              }}
            >
              <IconModel size={15} className="owb-composer__model-icon" />
              <span className="owb-composer__model-text">{currentModel}</span>
              {reasoningEffort ? (
                <span className="owb-composer__model-effort" data-testid="model-effort-badge">
                  {currentEffort.label}
                </span>
              ) : null}
              <IconChevron size={12} className="owb-composer__model-chevron" />
            </button>
            {menu === 'model' ? (
              <div className="owb-composer__menu owb-composer__menu--model" role="menu" aria-label="选择模型" data-testid="model-picker">
                <div className="owb-composer__menu-title">选择模型</div>
                {modelsLoading ? (
                  <div className="owb-composer__menu-empty" data-testid="model-loading">正在读取网关模型清单…</div>
                ) : models.length === 0 ? (
                  <div className="owb-composer__menu-empty" data-testid="model-empty">
                    {modelsError
                      ? `未能读取模型清单:${modelsError}。仍可在下方手动输入模型名。`
                      : '网关没有可列出的模型,可在下方手动输入模型名。'}
                  </div>
                ) : models.map((name) => (
                  <button
                    key={name}
                    type="button"
                    role="menuitemradio"
                    aria-checked={name === currentSelected}
                    className="owb-composer__menu-item"
                    onClick={() => pickModel(name)}
                    data-testid={`model-option-${name}`}
                  >
                    <span className="owb-composer__picker-name">
                      <IconModel size={14} />
                      {name}
                    </span>
                    {name === currentSelected ? <span className="owb-composer__tick">✓</span> : null}
                  </button>
                ))}
                {!modelsLoading && models.length > 0 ? (
                  <div className="owb-composer__menu-hint" data-testid="model-source">
                    来自当前网关,共 {models.length} 个模型
                    {currentSelected && !models.includes(currentSelected)
                      ? `(当前 ${currentSelected} 不在清单中)`
                      : ''}
                  </div>
                ) : null}
                <div className="owb-composer__menu-divider" />
                <form
                  className="owb-composer__model-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    pickModel(modelDraft)
                  }}
                >
                  <input
                    value={modelDraft}
                    onChange={(event) => setModelDraft(event.target.value)}
                    placeholder="输入模型名,例如 gpt-4o-mini"
                    aria-label="自定义模型名"
                    data-testid="model-input"
                  />
                  <button type="submit" disabled={!modelDraft.trim()} data-testid="model-use-custom">
                    使用
                  </button>
                </form>
                <div className="owb-composer__menu-hint">模型需与当前 OPENAI_BASE_URL 网关兼容。</div>
                <div className="owb-composer__menu-divider" />
                <div className="owb-composer__menu-title">思考强度</div>
                <div className="owb-composer__efforts" role="group" aria-label="思考强度">
                  {EFFORTS.map((item) => (
                    <button
                      key={item.id ?? 'auto'}
                      type="button"
                      role="menuitemradio"
                      aria-checked={item.id === reasoningEffort}
                      className={`owb-composer__effort-option${item.id === reasoningEffort ? ' owb-composer__effort-option--on' : ''}`}
                      data-testid={`effort-option-${item.id ?? 'auto'}`}
                      onClick={() => {
                        onPickReasoningEffort(item.id)
                        setMenu(null)
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <div className="owb-composer__menu-hint">
                  自动不发送强度参数;仅对支持思考强度的模型生效。
                </div>
              </div>
            ) : null}
            {voice.state === 'recording' ? (
              <div className="owb-voice" data-testid="voice-recording" aria-live="polite">
                <span className="owb-voice__dot" aria-hidden="true" />
                <span className="owb-voice__timer" data-testid="voice-timer">{voiceTimer}</span>
                <button
                  type="button"
                  className="owb-voice__action"
                  onClick={voice.stop}
                  title={VOICE_TEXT.stop}
                  aria-label={VOICE_TEXT.stop}
                  data-testid="voice-stop"
                >
                  <IconStop size={13} />
                  {VOICE_TEXT.stop}
                </button>
                <button
                  type="button"
                  className="owb-voice__action owb-voice__action--muted"
                  onClick={voice.cancel}
                  title={VOICE_TEXT.cancel}
                  aria-label={VOICE_TEXT.cancel}
                  data-testid="voice-cancel"
                >
                  {VOICE_TEXT.cancel}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className={`owb-icon-btn owb-composer__icon${voice.state === 'processing' ? ' owb-composer__icon--loading' : ''}`}
                title={VOICE_TEXT.hint}
                aria-label={voice.state === 'processing' ? VOICE_TEXT.processing : VOICE_TEXT.start}
                data-testid="voice-trigger"
                data-state={voice.state}
                disabled={busy || voice.state === 'processing'}
                onClick={voice.toggle}
              >
                {voice.state === 'processing' ? (
                  <span className="owb-voice__spinner" aria-hidden="true" />
                ) : (
                  <IconMic size={17} />
                )}
              </button>
            )}
            {busy ? (
              <button
                type="button"
                className="owb-composer__send owb-composer__send--busy"
                onClick={onStop}
                title="停止生成"
                aria-label="停止生成"
              >
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

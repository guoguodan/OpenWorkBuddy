import { useCallback, useEffect, useState } from 'react'
import { IconPlus, IconRefresh, IconSparkle, IconTrash } from './Icons'
import type { ArtifactInfo } from './ArtifactCards'

export interface ChannelInfo {
  id: string
  name: string
  description: string | null
  createdAt: string
  conversationCount: number
  artifacts: number
}

export interface SyncStatus {
  configured: boolean
  endpoint: string | null
  pending: number
  sent: number
  failed: number
  oldest: string | null
  lastError: string | null
}

interface ChannelPanelProps {
  channels: ChannelInfo[]
  activeChannelId: string | null
  sync: SyncStatus | null
  onClose: () => void
  onSelect: (channelId: string | null) => void
  onCreate: (name: string, description: string) => Promise<void>
  onDelete: (channelId: string) => Promise<void>
  onFlush: () => Promise<void>
  onOpenArtifact: (artifact: ArtifactInfo) => void
}

/**
 * 频道面板。频道本身完全本地可用;右上角的同步状态只在配置了服务端地址时
 * 才有意义,未配置时明确显示"本地模式",避免用户以为数据已经上云。
 */
export function ChannelPanel({
  channels,
  activeChannelId,
  sync,
  onClose,
  onSelect,
  onCreate,
  onDelete,
  onFlush,
  onOpenArtifact
}: ChannelPanelProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([])
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const loadArtifacts = useCallback(async (channelId: string) => {
    const r = await window.openwb.channel.artifacts(channelId)
    setArtifacts((r.artifacts ?? []) as ArtifactInfo[])
  }, [])

  useEffect(() => {
    if (!activeChannelId) {
      setArtifacts([])
      return
    }
    void loadArtifacts(activeChannelId).catch((err: Error) => setError(err.message))
  }, [activeChannelId, loadArtifacts])

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError('')
    try {
      await onCreate(trimmed, description.trim())
      setName('')
      setDescription('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (channelId: string) => {
    setBusy(true)
    setError('')
    try {
      await onDelete(channelId)
      setConfirmDelete(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="owb-channel" aria-label="团队频道" data-testid="channel-panel">
      <div className="owb-channel__header">
        <span className="owb-channel__heading">
          <IconSparkle size={15} />
          团队频道
        </span>
        <button className="owb-icon-btn" onClick={onClose} title="关闭频道面板">关闭</button>
      </div>

      <div className="owb-channel__sync" data-testid="sync-status">
        {sync?.configured ? (
          <>
            <span className="owb-channel__sync-dot" />
            <span>已连接 {sync.endpoint}</span>
            <span className="owb-channel__sync-meta">
              待发 {sync.pending} · 已发 {sync.sent}
              {sync.failed > 0 ? ` · 重试 ${sync.failed}` : ''}
            </span>
            <button
              className="owb-channel__link"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                void onFlush().catch((err: Error) => setError(err.message)).finally(() => setBusy(false))
              }}
            >
              <IconRefresh size={12} /> 立即同步
            </button>
          </>
        ) : (
          <span className="owb-channel__sync-meta">本地模式:未配置同步服务端,内容只保存在本机</span>
        )}
      </div>
      {sync?.lastError ? <div className="owb-channel__error">上次同步失败:{sync.lastError}</div> : null}

      <div className="owb-channel__create">
        <input
          className="owb-channel__input"
          value={name}
          maxLength={40}
          placeholder="新频道名称"
          aria-label="新频道名称"
          data-testid="channel-name-input"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void create() }}
        />
        <input
          className="owb-channel__input owb-channel__input--desc"
          value={description}
          maxLength={200}
          placeholder="用途说明(可选)"
          aria-label="频道说明"
          onChange={(e) => setDescription(e.target.value)}
        />
        <button
          className="owb-channel__create-btn"
          disabled={busy || !name.trim()}
          data-testid="channel-create"
          onClick={() => void create()}
        >
          <IconPlus size={14} /> 新建
        </button>
      </div>
      {error ? <div className="owb-channel__error">{error}</div> : null}

      <div className="owb-channel__list">
        <button
          className={`owb-channel__item${activeChannelId === null ? ' owb-channel__item--active' : ''}`}
          onClick={() => onSelect(null)}
        >
          <span className="owb-channel__name">仅本地</span>
          <span className="owb-channel__desc">不进入任何频道</span>
        </button>
        {channels.map((c) => (
          <div
            key={c.id}
            className={`owb-channel__item${activeChannelId === c.id ? ' owb-channel__item--active' : ''}`}
            data-testid="channel-item"
            role="button"
            tabIndex={0}
            onClick={() => onSelect(c.id)}
            onKeyDown={(e) => { if (e.key === 'Enter') onSelect(c.id) }}
          >
            <span className="owb-channel__name">
              {c.name}
              <span className="owb-channel__count">
                {c.conversationCount} 会话 · {c.artifacts} 产物
              </span>
            </span>
            {c.description ? <span className="owb-channel__desc">{c.description}</span> : null}
            {confirmDelete === c.id ? (
              <span className="owb-channel__confirm">
                <span>删除后会话保留为本地</span>
                <button className="owb-channel__danger" onClick={() => void remove(c.id)}>确认删除</button>
                <button className="owb-channel__link" onClick={() => setConfirmDelete(null)}>取消</button>
              </span>
            ) : (
              <button
                className="owb-channel__del"
                title="删除频道"
                aria-label={`删除频道 ${c.name}`}
                onClick={(e) => { e.stopPropagation(); setConfirmDelete(c.id) }}
              >
                <IconTrash size={13} />
              </button>
            )}
          </div>
        ))}
      </div>

      {activeChannelId ? (
        <div className="owb-channel__artifacts">
          <div className="owb-channel__subhead">频道共享产物 ({artifacts.length})</div>
          {artifacts.length === 0 ? (
            <div className="owb-channel__empty">还没有共享产物。在会话中点击交付卡片上的“转发到频道”。</div>
          ) : (
            artifacts.map((a) => (
              <button key={a.id} className="owb-channel__artifact" onClick={() => onOpenArtifact(a)}>
                <span>{a.title}</span>
                <span className="owb-channel__artifact-kind">{a.kind}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </section>
  )
}

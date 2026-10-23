import { IconFile, IconImage, IconLink } from './Icons'

export interface ArtifactInfo {
  id: string
  kind: 'file' | 'html' | 'url' | 'image'
  title: string
  description?: string | null
  path?: string | null
  url?: string | null
  size?: number
  sha256?: string | null
}

interface ArtifactCardsProps {
  artifacts: ArtifactInfo[]
  onOpen: (artifact: ArtifactInfo) => void
  onShare?: ((artifact: ArtifactInfo) => void) | undefined
  shareChannelName?: string | null | undefined
}

function formatSize(bytes: number | undefined): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const KIND_LABEL: Record<ArtifactInfo['kind'], string> = {
  file: '文件',
  html: '网页',
  url: '链接',
  image: '图片'
}

function KindIcon({ kind }: { kind: ArtifactInfo['kind'] }) {
  if (kind === 'image') return <IconImage size={18} />
  if (kind === 'url') return <IconLink size={18} />
  return <IconFile size={18} />
}

export function ArtifactCards({ artifacts, onOpen, onShare, shareChannelName }: ArtifactCardsProps) {
  if (artifacts.length === 0) return null
  return (
    <div className="owb-artifacts" data-testid="artifact-cards">
      {artifacts.map((a) => (
        <div
          key={a.id}
          className="owb-artifact"
          data-testid="artifact-card"
        >
          <button className="owb-artifact__main" onClick={() => onOpen(a)} title={a.path ?? a.url ?? a.title}>
            <span className="owb-artifact__icon"><KindIcon kind={a.kind} /></span>
            <span className="owb-artifact__body">
              <span className="owb-artifact__title">{a.title}</span>
              {a.description ? <span className="owb-artifact__desc">{a.description}</span> : null}
              <span className="owb-artifact__meta">
                {KIND_LABEL[a.kind]}
                {formatSize(a.size) ? ` · ${formatSize(a.size)}` : ''}
                {a.path ? ` · ${a.path}` : ''}
              </span>
            </span>
            <span className="owb-artifact__action">打开</span>
          </button>
          {onShare ? (
            <button
              className="owb-artifact__share"
              data-testid="artifact-share"
              title={shareChannelName ? `转发到频道 ${shareChannelName}` : '先在侧栏选择一个频道'}
              onClick={() => onShare(a)}
            >
              转发到频道
            </button>
          ) : null}
        </div>
      ))}
    </div>
  )
}

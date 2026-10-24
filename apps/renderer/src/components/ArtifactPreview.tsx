import { useEffect, useMemo } from 'react'
import type { ArtifactInfo } from './ArtifactCards'
import { Markdown } from '../lib/markdown'
import { IconFile, IconX } from './Icons'
import { PdfPreview } from './PdfPreview'

export interface TextPreviewInfo {
  path: string
  text: string
  size: number
  truncated: boolean
  format: 'markdown' | 'code' | 'text' | 'html'
}

export interface DocumentPreviewInfo {
  path: string
  format: 'office' | 'pdf'
  kind?: 'docx' | 'xlsx' | 'pptx'
  content?: string
  data?: Uint8Array
  size: number
  sha256: string
}

interface ArtifactPreviewProps {
  artifact: ArtifactInfo
  preview: TextPreviewInfo | null
  document?: DocumentPreviewInfo | null
  onClose: () => void
  onOpenExternal: () => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 给 iframe 自身的文档再加一层 CSP,即使父页面策略变化也不会放行脚本与网络。 */
const FRAME_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'none'; " +
  "connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

const FRAME_STYLE = `
  html, body { margin: 0; min-height: 100%; }
  body { padding: 24px; font: 14px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #1f2329; background: #fff; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  pre, code { white-space: pre-wrap; overflow-wrap: anywhere; }
  table { border-collapse: collapse; max-width: 100%; }
  th, td { border: 1px solid #e5e7eb; padding: 6px 10px; }
`

/** Office 提取结果只有语义标签,版式相关样式统一放在这里。 */
const OFFICE_STYLE = `
  .office h1, .office h2, .office h3 { line-height: 1.35; margin: 24px 0 12px; }
  .office h1:first-child, .office h2:first-child, .office h3:first-child { margin-top: 0; }
  .office p { margin: 8px 0; }
  .office table { width: 100%; margin: 12px 0; font-size: 13px; }
  .office th { background: #f6f7f9; font-weight: 600; }
  .office-slide { border: 1px solid #e5e7eb; border-radius: 10px; padding: 20px 24px; margin: 0 0 20px; }
  .office-slide h3 { margin-top: 0; color: #6b7280; font-size: 12px; font-weight: 500; }
  .office-sheet { margin: 0 0 28px; }
  .office-note { color: #6b7280; font-size: 12px; }
  .office-error { border: 1px solid #fecaca; background: #fef2f2; border-radius: 10px; padding: 16px 18px; }
  .office-bullet { color: #6b7280; }
`

export function ArtifactPreview({ artifact, preview, document, onClose, onOpenExternal }: ArtifactPreviewProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const html = useMemo(() => {
    if (!preview || preview.format !== 'html') return ''
    // srcDoc 里的文档与宿主同源;sandbox 空值会把脚本、表单、弹窗和顶层导航全部关掉。
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><style>${FRAME_STYLE}</style></head><body>${preview.text}</body></html>`
  }, [preview])

  const officeHtml = useMemo(() => {
    if (!document || document.format !== 'office' || !document.content) return ''
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><style>${FRAME_STYLE}${OFFICE_STYLE}</style></head><body>${document.content}</body></html>`
  }, [document])

  const size = preview?.size ?? document?.size ?? 0

  return (
    <div
      className="owb-artifact-preview"
      data-testid="artifact-preview"
      role="dialog"
      aria-modal="true"
      aria-label="产物预览"
    >
      <button
        type="button"
        className="owb-artifact-preview__scrim"
        aria-label="关闭产物预览"
        onClick={onClose}
      />
      <section className="owb-artifact-preview__panel">
        <header className="owb-artifact-preview__header">
          <span className="owb-artifact-preview__icon"><IconFile size={16} /></span>
          <div className="owb-artifact-preview__heading">
            <h2 title={artifact.title}>{artifact.title}</h2>
            <p title={artifact.path ?? ''}>
              {artifact.path ?? artifact.url ?? ''}
              {size ? ` · ${formatSize(size)}` : ''}
            </p>
          </div>
          <button
            type="button"
            className="owb-artifact-preview__external"
            data-testid="artifact-preview-external"
            onClick={onOpenExternal}
          >
            用系统程序打开
          </button>
          <button
            type="button"
            className="owb-icon-btn"
            aria-label="关闭产物预览"
            data-testid="artifact-preview-close"
            onClick={onClose}
          >
            <IconX size={16} />
          </button>
        </header>

        <div className="owb-artifact-preview__body">
          {document?.format === 'pdf' && document.data ? (
            <PdfPreview data={document.data} title={artifact.title} />
          ) : document?.format === 'office' ? (
            <iframe
              className="owb-artifact-preview__frame"
              data-testid="artifact-preview-office"
              title={`预览 ${artifact.title}`}
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={officeHtml}
            />
          ) : !preview ? (
            <div className="owb-artifact-preview__fallback" data-testid="artifact-preview-unsupported">
              <IconFile size={28} />
              <strong>此文件暂不支持预览</strong>
              <span>可以下载后用本机程序打开。</span>
            </div>
          ) : preview.format === 'markdown' ? (
            <div className="owb-artifact-preview__markdown" data-testid="artifact-preview-content">
              <Markdown text={preview.text} />
            </div>
          ) : preview.format === 'html' ? (
            <iframe
              className="owb-artifact-preview__frame"
              data-testid="artifact-preview-content"
              title={`预览 ${artifact.title}`}
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={html}
            />
          ) : (
            <pre
              className={`owb-artifact-preview__text owb-artifact-preview__text--${preview.format}`}
              data-testid="artifact-preview-content"
            >
              {preview.text}
            </pre>
          )}
        </div>

        {preview?.truncated ? (
          <footer className="owb-artifact-preview__notice" data-testid="artifact-preview-truncated">
            文件较大,这里只展示前 2MB。完整内容请用系统程序打开。
          </footer>
        ) : null}
      </section>
    </div>
  )
}

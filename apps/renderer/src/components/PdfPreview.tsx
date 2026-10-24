import { useEffect, useRef, useState } from 'react'
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

const PAGE_BATCH = 10

interface PdfPreviewProps {
  data: Uint8Array
  title: string
}

/**
 * 应用内 PDF 只读预览。
 *
 * PDF 字节由主进程按工作区边界读取,这里不再触网。分页渲染避免一次打开
 * 几百页时把渲染进程内存打满;每批最多 10 页,用户可继续加载。
 */
export function PdfPreview({ data, title }: PdfPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [pageCount, setPageCount] = useState(0)
  const [requested, setRequested] = useState(PAGE_BATCH)
  const [rendered, setRendered] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setPdf(null)
    setPageCount(0)
    setRequested(PAGE_BATCH)
    setRendered(0)
    setError('')

    const task = getDocument({
      data: data.slice(),
      useSystemFonts: true,
      useWasm: false,
      disableRange: true,
      disableStream: true
    })
    task.promise.then(
      (doc) => {
        if (cancelled) {
          void task.destroy()
          return
        }
        setPdf(doc)
        setPageCount(doc.numPages)
      },
      (err: unknown) => {
        if (!cancelled) setError((err as Error).message || 'PDF 解析失败')
      }
    )
    return () => {
      cancelled = true
      void task.destroy()
    }
  }, [data])

  useEffect(() => {
    if (!pdf || !containerRef.current) return
    const container = containerRef.current
    container.replaceChildren()
    let cancelled = false
    let completed = 0

    const render = async () => {
      const limit = Math.min(requested, pdf.numPages)
      for (let number = 1; number <= limit; number++) {
        if (cancelled) return
        const page = await pdf.getPage(number)
        if (cancelled) return
        const viewport = page.getViewport({ scale: 1.35 })
        const canvas = document.createElement('canvas')
        canvas.className = 'owb-artifact-preview__pdfpage'
        canvas.dataset.testid = 'artifact-preview-pdf-page'
        const ratio = Math.min(window.devicePixelRatio || 1, 2)
        canvas.width = Math.floor(viewport.width * ratio)
        canvas.height = Math.floor(viewport.height * ratio)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        const wrapper = document.createElement('div')
        wrapper.className = 'owb-artifact-preview__pdfsheet'
        wrapper.append(canvas)
        container.append(wrapper)
        await page.render({
          canvas,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0]
        }).promise
        completed = number
        if (!cancelled) setRendered(number)
      }
    }

    render().catch((err: unknown) => {
      if (!cancelled) setError((err as Error).message || 'PDF 渲染失败')
    })
    return () => {
      cancelled = true
      if (completed === 0) container.replaceChildren()
    }
  }, [pdf, requested])

  if (error) {
    return (
      <div className="owb-artifact-preview__fallback" data-testid="artifact-preview-pdf-error">
        <strong>无法预览此 PDF</strong>
        <span>{error}</span>
      </div>
    )
  }

  return (
    <div className="owb-artifact-preview__pdf" data-testid="artifact-preview-pdf" aria-label={`预览 ${title}`}>
      <div className="owb-artifact-preview__pdfbar" data-testid="artifact-preview-pdf-count">
        {pageCount ? `${pageCount} 页` : '正在解析 PDF…'}
      </div>
      <div className="owb-artifact-preview__pdfpages" ref={containerRef} />
      {pageCount > requested ? (
        <button
          type="button"
          className="owb-artifact-preview__pdfmore"
          data-testid="artifact-preview-pdf-more"
          onClick={() => setRequested((value) => value + PAGE_BATCH)}
        >
          继续加载（已显示 {rendered} / {pageCount} 页）
        </button>
      ) : null}
    </div>
  )
}

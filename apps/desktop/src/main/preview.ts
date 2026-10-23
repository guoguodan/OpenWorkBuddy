import { BrowserWindow, session, shell } from 'electron'
import { createHash } from 'node:crypto'
import { PREVIEW_CSP } from './preview-policy.js'
export { MAX_IMAGE_BYTES, PREVIEW_CSP, resolvePreview } from './preview-policy.js'
export type { PreviewTarget, ResolvedPreview } from './preview-policy.js'

function previewWindowOptions(title: string) {
  return {
    width: 900,
    height: 720,
    title,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false
      // 刻意不设置 preload:预览页拿不到任何宿主 API
    }
  }
}

/**
 * HTML 预览:独立会话 + 响应头注入 CSP。
 * 只拦自己的预览分区,不影响主窗口。
 */
export async function openHtmlPreview(
  absolutePath: string,
  title: string,
  csp: string = PREVIEW_CSP
): Promise<BrowserWindow> {
  const partition = `preview-${createHash('sha1').update(absolutePath).digest('hex').slice(0, 12)}`
  const previewSession = session.fromPartition(partition, { cache: false })
  previewSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    })
  })
  const view = new BrowserWindow(previewWindowOptions(title))
  // 预览页里任何跳转都只会留在原地:禁 top 导航
  view.webContents.on('will-navigate', (event, url) => {
    if (url !== `file://${absolutePath.replace(/\\/g, '/')}`) event.preventDefault()
  })
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  await view.loadFile(absolutePath)
  return view
}

export async function openImagePreview(absolutePath: string, title: string): Promise<BrowserWindow> {
  const view = new BrowserWindow({ ...previewWindowOptions(title), width: 800, height: 640 })
  const html = `<html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:#111}
    img{max-width:100%;max-height:100%;object-fit:contain}
  </style></head><body><img src="${encodeURI(`file://${absolutePath.replace(/\\/g, '/')}`)}" alt=""></body></html>`
  await view.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  return view
}

export async function openWithSystem(absolutePath: string): Promise<void> {
  const error = await shell.openPath(absolutePath)
  if (error) throw new Error(error)
}

export async function openExternal(url: string): Promise<void> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`只允许 http/https 外链,拒绝: ${parsed.protocol}`)
  }
  await shell.openExternal(parsed.toString())
}

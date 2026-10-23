import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

/** 不可信 HTML 预览的 CSP:禁脚本、禁网、只允许内联样式与 data/blob 图片 */
export const PREVIEW_CSP = [
  "default-src 'none'",
  "img-src data: blob:",
  "style-src 'unsafe-inline'",
  "script-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

export interface PreviewTarget {
  kind: 'file' | 'html' | 'url' | 'image'
  path?: string
  url?: string
  title?: string
}

export interface ResolvedPreview {
  mode: 'system' | 'html-window' | 'browser' | 'image-window'
  csp?: string
  absolutePath?: string
  url?: string
  size?: number
  sha256?: string
}

/**
 * 把"预览"拆成纯决策 + 执行两步:
 * 决策不碰 Electron,可在 Node 测试里直接断言;
 * 执行只做已经通过校验的动作。
 */
export async function resolvePreview(
  workspaceRoot: string,
  target: PreviewTarget,
  options: { confirmedUrl?: boolean } = {}
): Promise<ResolvedPreview> {
  if (target.kind === 'url') {
    if (!target.url) throw new Error('缺少 url')
    const parsed = new URL(target.url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`只允许 http/https 外链,拒绝: ${parsed.protocol}`)
    }
    if (!options.confirmedUrl) throw new Error('URL_NEEDS_CONFIRM:打开外部链接需要二次确认')
    return { mode: 'browser', url: parsed.toString() }
  }

  if (!target.path) throw new Error('缺少 path')
  const workspace = path.resolve(workspaceRoot)
  const abs = path.resolve(workspace, target.path)
  if (abs !== workspace && !abs.startsWith(workspace + path.sep)) {
    throw new Error(`路径越界: ${target.path}`)
  }
  const info = await stat(abs)
  if (!info.isFile()) throw new Error(`不是文件: ${target.path}`)

  if (target.kind === 'image' && info.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片超过 20MB(${info.size} 字节),不允许在应用内渲染`)
  }
  const buf = await readFile(abs)
  const sha256 = createHash('sha256').update(buf).digest('hex')

  if (target.kind === 'html') {
    return { mode: 'html-window', csp: PREVIEW_CSP, absolutePath: abs, size: info.size, sha256 }
  }
  if (target.kind === 'image') {
    return { mode: 'image-window', absolutePath: abs, size: info.size, sha256 }
  }
  return { mode: 'system', absolutePath: abs, size: info.size, sha256 }
}

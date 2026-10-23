import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

/** IMPLEMENTATION §6.4:体积与文件数上限 */
export const MAX_PLUGIN_BYTES = 50 * 1024 * 1024
export const MAX_PLUGIN_FILES = 5000
/** 单文件凭据扫描上限:超过则只扫前 256KB,并标记未完整扫描 */
const CREDENTIAL_SCAN_BYTES = 256 * 1024

export const CREDENTIAL_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'OpenAI 风格密钥', re: /\bsk-[A-Za-z0-9_-]{3,}/ },
  { label: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{12,}\b/ },
  { label: 'GitHub Token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
  { label: 'Slack Token', re: /\bxox[baprs]-[A-Za-z0-9-]{8,}/ },
  { label: '私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ }
]

export interface ScanResult {
  files: number
  bytes: number
  /** 命中凭据的文件与标签 */
  credentialHits: Array<{ path: string; label: string }>
  /** 因体积过大未完整扫描的文件 */
  partiallyScanned: string[]
}

export class PluginScanError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'PluginScanError'
  }
}

function toPosix(p: string): string {
  return p.split(sep).join('/')
}

/**
 * 递归扫描插件目录。
 *
 * 两点必须明确:
 * - 符号链接不跟随(避免逃逸到宿主目录),直接跳过并记录为未扫描;
 * - 超过上限立即抛错,不做"先统计再判断",否则超大目录会先把内存吃满。
 */
export async function scanPluginDir(root: string): Promise<ScanResult & { skippedLinks: string[] }> {
  const base = resolve(root)
  let files = 0
  let bytes = 0
  const credentialHits: Array<{ path: string; label: string }> = []
  const partiallyScanned: string[] = []
  const skippedLinks: string[] = []

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      const rel = toPosix(relative(base, abs))
      if (entry.isSymbolicLink()) {
        skippedLinks.push(rel)
        continue
      }
      if (entry.isDirectory()) {
        await walk(abs)
        continue
      }
      if (!entry.isFile()) continue

      const info = await stat(abs)
      files++
      bytes += info.size
      if (files > MAX_PLUGIN_FILES) {
        throw new PluginScanError(`插件文件数超过上限(${MAX_PLUGIN_FILES})`)
      }
      if (bytes > MAX_PLUGIN_BYTES) {
        throw new PluginScanError(`插件体积超过上限(${MAX_PLUGIN_BYTES} 字节)`)
      }

      const full = await readFile(abs)
      // 二进制文件不参与凭据扫描;判断依据是前 512 字节含 NUL
      if (full.subarray(0, 512).includes(0)) continue

      const slice = full.subarray(0, CREDENTIAL_SCAN_BYTES)
      if (full.length > CREDENTIAL_SCAN_BYTES) partiallyScanned.push(rel)
      const text = slice.toString('utf8')
      for (const pattern of CREDENTIAL_PATTERNS) {
        if (pattern.re.test(text)) credentialHits.push({ path: rel, label: pattern.label })
      }
    }
  }

  await walk(base)
  return { files, bytes, credentialHits, partiallyScanned, skippedLinks }
}

/** 入口文件必须在插件目录内,且不能含 `..`(防止清单里写 ../../etc/passwd) */
export function assertInsidePlugin(root: string, candidate: string): string {
  if (candidate.includes('\0')) throw new PluginScanError('路径含非法字符')
  if (candidate.split(/[\\/]/).includes('..')) {
    throw new PluginScanError(`入口路径不允许包含 ..: ${candidate}`)
  }
  const base = resolve(root)
  const abs = resolve(base, candidate)
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new PluginScanError(`入口路径越界: ${candidate}`)
  }
  return abs
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

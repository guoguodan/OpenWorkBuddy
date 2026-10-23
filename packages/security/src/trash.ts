import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'

export interface TrashItem {
  path: string
  kind: 'file' | 'directory'
}

export interface TrashOutcome {
  ok: boolean
  path: string
  error?: string
}

export interface TrashAdapter {
  /** 平台名,用于结果与审计展示 */
  readonly kind: 'windows' | 'macos' | 'linux' | 'test'
  trash(items: TrashItem[]): Promise<TrashOutcome[]>
}

export class MemoryTrashAdapter implements TrashAdapter {
  readonly kind = 'test' as const
  readonly calls: TrashItem[][] = []
  constructor(
    private readonly behavior: 'ok' | 'fail' = 'ok',
    private readonly removeOnTrash = true
  ) {}

  async trash(items: TrashItem[]): Promise<TrashOutcome[]> {
    this.calls.push(items.map((item) => ({ ...item })))
    if (this.behavior === 'fail') {
      return items.map((item) => ({ ok: false, path: item.path, error: '测试注入的失败' }))
    }
    // 测试替身要模拟"文件已离开原位置",否则执行器的后置校验会正确报错。
    if (this.removeOnTrash) {
      for (const item of items) {
        await rm(item.path, { recursive: item.kind === 'directory', force: false })
      }
    }
    return items.map((item) => ({ ok: true, path: item.path }))
  }
}

interface TrashScriptResult {
  ok: boolean
  error?: string
}

function runCollector(
  command: string,
  args: string[],
  input?: string,
  timeoutMs = 30_000
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(() => reject(new Error(`${command} 超时(${timeoutMs}ms)`)))
    }, timeoutMs)
    child.stdout.on('data', (b) => { stdout += String(b) })
    child.stderr.on('data', (b) => { stderr += String(b) })
    child.on('error', (err) => finish(() => reject(err)))
    child.on('close', (code) => finish(() => resolve({ code, stdout, stderr })))
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

// 路径只通过 stdin/stderr 传入,绝不拼进命令行;这样文件名里的引号与 ; rm -rf 都不会被解释。
const WINDOWS_TRASH_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Microsoft.VisualBasic
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$results = @()
foreach ($item in $payload) {
  try {
    if ($item.Kind -eq 'directory') {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
        [string]$item.Path,
        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
    } else {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
        [string]$item.Path,
        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
    }
    $results += [pscustomobject]@{ path = [string]$item.Path; ok = $true; error = $null }
  } catch {
    $results += [pscustomobject]@{ path = [string]$item.Path; ok = $false; error = $_.Exception.Message }
  }
}
$results | ConvertTo-Json -Compress
`

function parseWindowsResults(text: string): TrashScriptResult[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed) as TrashScriptResult | TrashScriptResult[]
  return Array.isArray(parsed) ? parsed : [parsed]
}

export class WindowsTrashAdapter implements TrashAdapter {
  readonly kind = 'windows' as const

  async trash(items: TrashItem[]): Promise<TrashOutcome[]> {
    if (items.length === 0) return []
    // -EncodedCommand:脚本本身固定,不接收任何路径参数。
    const encoded = Buffer.from(WINDOWS_TRASH_SCRIPT, 'utf16le').toString('base64')
    const payload = JSON.stringify(items.map((item) => ({ Path: item.path, Kind: item.kind })))
    let result
    try {
      result = await runCollector(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        payload
      )
    } catch (err) {
      return items.map((item) => ({ ok: false, path: item.path, error: (err as Error).message }))
    }
    if (result.code !== 0) {
      return items.map((item) => ({
        ok: false,
        path: item.path,
        error: result.stderr.trim() || `powershell 退出码 ${result.code}`
      }))
    }
    try {
      const parsed = parseWindowsResults(result.stdout)
      return items.map((item, index) => {
        const hit = parsed[index]
        if (!hit) return { ok: false, path: item.path, error: '回收站适配器没有返回结果' }
        return hit.ok
          ? { ok: true, path: item.path }
          : { ok: false, path: item.path, ...(hit.error ? { error: hit.error } : {}) }
      })
    } catch (err) {
      return items.map((item) => ({
        ok: false,
        path: item.path,
        error: `无法解析回收站结果: ${(err as Error).message}`
      }))
    }
  }
}

const APPLESCRIPT = `
on run argv
  set out to ""
  repeat with p in argv
    try
      tell application "Finder" to delete POSIX file p
      set out to out & "OK" & linefeed
    on error errMsg
      set out to out & "ERR:" & errMsg & linefeed
    end try
  end repeat
  return out
end run
`

export class MacTrashAdapter implements TrashAdapter {
  readonly kind = 'macos' as const

  async trash(items: TrashItem[]): Promise<TrashOutcome[]> {
    if (items.length === 0) return []
    try {
      const result = await runCollector('osascript', ['-e', APPLESCRIPT, ...items.map((item) => item.path)])
      if (result.code !== 0) {
        return items.map((item) => ({
          ok: false,
          path: item.path,
          error: result.stderr.trim() || `osascript 退出码 ${result.code}`
        }))
      }
      const lines = result.stdout.split(/\r?\n/).filter(Boolean)
      return items.map((item, index) => {
        const line = lines[index]
        if (line === 'OK') return { ok: true, path: item.path }
        return { ok: false, path: item.path, error: line?.replace(/^ERR:/, '') || 'Finder 未返回结果' }
      })
    } catch (err) {
      return items.map((item) => ({ ok: false, path: item.path, error: (err as Error).message }))
    }
  }
}

export class LinuxTrashAdapter implements TrashAdapter {
  readonly kind = 'linux' as const

  async trash(items: TrashItem[]): Promise<TrashOutcome[]> {
    const outcomes: TrashOutcome[] = []
    // gio trash 支持多参数;仍逐项记录,便于报告到底哪一项失败。
    for (const item of items) {
      try {
        const result = await runCollector('gio', ['trash', item.path])
        outcomes.push(
          result.code === 0
            ? { ok: true, path: item.path }
            : { ok: false, path: item.path, error: result.stderr.trim() || `gio 退出码 ${result.code}` }
        )
      } catch (err) {
        outcomes.push({ ok: false, path: item.path, error: (err as Error).message })
      }
    }
    return outcomes
  }
}

export function platformTrashAdapter(platform: NodeJS.Platform = process.platform): TrashAdapter {
  if (platform === 'win32') return new WindowsTrashAdapter()
  if (platform === 'darwin') return new MacTrashAdapter()
  return new LinuxTrashAdapter()
}

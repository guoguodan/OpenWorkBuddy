import { spawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { SkillError, type SkillIndexEntry } from './skills.js'

const MAX_SCRIPT_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const MAX_ARGS = 32
const MAX_ARG_BYTES = 4096

export interface SkillScriptResult {
  code: number | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

/** 脚本可读取的环境变量白名单;凭据类变量一律不传给子进程。 */
const SAFE_ENV_KEYS = new Set([
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ'
])

const CREDENTIAL_ENV_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i

function safeEnv(entry: SkillIndexEntry, workspaceRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (!SAFE_ENV_KEYS.has(key)) continue
    if (CREDENTIAL_ENV_RE.test(key)) continue
    env[key] = value
  }
  env.OPENWB_SKILL_NAME = entry.name
  env.OPENWB_WORKSPACE = workspaceRoot
  env.PYTHONIOENCODING = 'utf-8'
  env.PYTHONDONTWRITEBYTECODE = '1'
  return env
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

interface Interpreter {
  command: string
  prefix: string[]
}

function interpreterFor(scriptPath: string): Interpreter {
  const ext = extname(scriptPath).toLowerCase()
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return { command: process.execPath, prefix: [] }
  }
  if (ext === '.py') {
    return { command: process.platform === 'win32' ? 'python' : 'python3', prefix: [] }
  }
  if (ext === '.ps1') {
    if (process.platform !== 'win32') throw new Error('本机不是 Windows,无法执行 .ps1 脚本')
    return { command: 'pwsh', prefix: ['-NoProfile', '-NonInteractive', '-File'] }
  }
  if (ext === '.sh') {
    if (process.platform === 'win32') throw new Error('Windows 上没有可用的 bash,无法执行 .sh 脚本')
    return { command: 'bash', prefix: [] }
  }
  if (ext === '.bat' || ext === '.cmd') {
    throw new Error('技能脚本不允许 .bat/.cmd:它们必须经命令解释器执行,无法保证不二次展开')
  }
  throw new Error(`不支持的脚本类型: ${ext || '(无扩展名)'};只允许 .js/.mjs/.cjs/.py/.sh/.ps1`)
}

/** 解析并验证一个声明脚本:必须已声明、位于 scripts/ 下、是普通文件且不是符号链接。 */
export async function resolveSkillScript(entry: SkillIndexEntry, script: string): Promise<string> {
  if (!entry.scripts || entry.scripts.length === 0) {
    throw new SkillError(entry.dir, `技能 ${entry.name} 没有声明可执行脚本`)
  }
  if (!entry.scripts.includes(script)) {
    throw new SkillError(entry.dir, `脚本 ${script} 未在 SKILL.md 的 scripts 中声明;已声明: ${entry.scripts.join(', ')}`)
  }
  if (script.includes('/') || script.includes('\\') || script === '..' || script.includes('\0')) {
    throw new SkillError(entry.dir, `脚本名不合法: ${script}`)
  }

  const scriptsDir = join(entry.dir, 'scripts')
  const candidate = resolve(scriptsDir, script)
  if (dirname(candidate) !== resolve(scriptsDir)) {
    throw new SkillError(entry.dir, `脚本必须直接位于 scripts/ 目录: ${script}`)
  }

  let info
  try {
    info = await lstat(candidate)
  } catch {
    throw new SkillError(candidate, '脚本不存在')
  }
  if (info.isSymbolicLink()) throw new SkillError(candidate, '脚本不允许是符号链接')
  if (!info.isFile()) throw new SkillError(candidate, '脚本必须是普通文件')
  if (info.size > MAX_SCRIPT_BYTES) {
    throw new SkillError(candidate, `脚本超过大小上限 ${MAX_SCRIPT_BYTES} 字节`)
  }

  const [realDir, realScript] = await Promise.all([realpath(scriptsDir), realpath(candidate)])
  if (!isInside(realDir, realScript)) throw new SkillError(candidate, '脚本解析后的真实路径不在技能目录内')
  return realScript
}

/**
 * 在受限环境中执行技能脚本:
 * - 不经过 shell,参数数组原样传给解释器
 * - 环境变量白名单,剥离凭据
 * - 工作目录固定在工作区,默认 30 秒超时,输出有上限
 */
export async function runSkillScript(
  entry: SkillIndexEntry,
  request: {
    script: string
    args?: string[]
    workspaceRoot: string
    timeoutMs?: number
    signal?: AbortSignal
  }
): Promise<SkillScriptResult> {
  const scriptPath = await resolveSkillScript(entry, request.script)
  const args = request.args ?? []
  if (args.length > MAX_ARGS) throw new Error(`脚本参数最多 ${MAX_ARGS} 个`)
  for (const arg of args) {
    if (typeof arg !== 'string') throw new Error('脚本参数必须是字符串')
    if (Buffer.byteLength(arg, 'utf8') > MAX_ARG_BYTES) throw new Error('单个脚本参数过长')
    if (arg.includes('\0')) throw new Error('脚本参数不允许包含 NUL')
  }

  const interpreter = interpreterFor(scriptPath)
  const timeoutMs = Math.min(Math.max(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS)
  const workspace = resolve(request.workspaceRoot)
  const command = [...interpreter.prefix, scriptPath, ...args]
  const started = Date.now()

  return await new Promise<SkillScriptResult>((res, rej) => {
    const child = spawn(interpreter.command, command, {
      cwd: workspace,
      env: safeEnv(entry, workspace),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = () => {
      child.kill()
      finish(() => rej(new Error('已取消')))
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(() => rej(new Error(`脚本执行超时(${timeoutMs}ms),已终止`)))
    }, timeoutMs)
    if (request.signal) {
      if (request.signal.aborted) onAbort()
      else request.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (chunk) => {
      if (Buffer.byteLength(stdout, 'utf8') < MAX_SCRIPT_BYTES) stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (Buffer.byteLength(stderr, 'utf8') < MAX_SCRIPT_BYTES) stderr += String(chunk)
    })
    child.on('error', (err) => {
      finish(() => {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          rej(new Error(`脚本解释器不存在: ${interpreter.command};请先安装对应运行时`))
          return
        }
        rej(err)
      })
    })
    child.on('close', (code) => {
      finish(() =>
        res({
          code,
          stdout: stdout.slice(0, MAX_SCRIPT_BYTES),
          stderr: stderr.slice(0, MAX_SCRIPT_BYTES),
          durationMs: Date.now() - started,
          timedOut: false
        })
      )
    })
  })
}

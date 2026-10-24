import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, sep, dirname } from 'node:path'
import { z } from 'zod'
import { buildDeck, type ArtifactDraft, type ToolDescriptor, type ToolContext } from '@openwb/tools'
import {
  MAX_DESTRUCTIVE_BATCH,
  SecurityError,
  destructiveRequestFromTool,
  executeDestructivePlan,
  inspectDestructiveRequest,
  platformTrashAdapter,
  type DestructivePlan,
  type TrashAdapter
} from '@openwb/security'

const MAX_READ_BYTES = 512 * 1024

export async function resolveInsideWorkspace(root: string, rel: string): Promise<string> {
  if (typeof rel !== 'string' || rel.length === 0) throw new Error('路径不能为空')
  if (rel.includes('\0')) throw new Error('路径含非法字符')
  const workspace = resolve(root)
  const abs = resolve(workspace, rel)
  if (abs !== workspace && !abs.startsWith(workspace + sep)) {
    throw new Error(`路径越界: ${rel}`)
  }
  return abs
}

const effectsNone = { writesFilesystem: false, accessesNetwork: false, mayIncurCost: false }

export const readFileTool: ToolDescriptor<{ path: string }, string> = {
  name: 'read_file',
  description: '读取工作区内的文本文件。返回内容;超过 512KB 会截断。',
  parameters: z.object({ path: z.string().describe('相对工作区根目录的路径') }),
  effects: effectsNone,
  async execute({ path }, ctx: ToolContext) {
    const abs = await resolveInsideWorkspace(ctx.workspaceRoot, path)
    const buf = await readFile(abs)
    if (buf.length > MAX_READ_BYTES) {
      return `${buf.subarray(0, MAX_READ_BYTES).toString('utf8')}\n[已截断:原文件 ${buf.length} 字节]`
    }
    return buf.toString('utf8')
  }
}

export const writeFileTool: ToolDescriptor<{ path: string; content: string }, string> = {
  name: 'write_file',
  description: '在工作区内写入文本文件。会覆盖同名文件,父目录不存在时自动创建。',
  parameters: z.object({
    path: z.string().describe('相对工作区根目录的路径'),
    content: z.string().describe('要写入的完整文本内容')
  }),
  effects: { writesFilesystem: true, accessesNetwork: false, mayIncurCost: false },
  async execute({ path, content }, ctx: ToolContext) {
    const abs = await resolveInsideWorkspace(ctx.workspaceRoot, path)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
    return `已写入 ${Buffer.byteLength(content, 'utf8')} 字节到 ${path}`
  }
}

const globParams = z.object({
  pattern: z.string().describe('相对工作区的 glob 模式'),
  limit: z.number().int().min(1).max(500).optional()
})

export const globTool: ToolDescriptor<z.infer<typeof globParams>, string[]> = {
  name: 'glob',
  description: '按通配符列出工作区内的文件路径,例如 "**/*.ts"。',
  parameters: globParams,
  effects: effectsNone,
  async execute({ pattern, limit = 200 }, ctx: ToolContext) {
    const { glob } = await import('node:fs/promises')
    const found: string[] = []
    for await (const entry of glob(pattern, { cwd: ctx.workspaceRoot })) {
      found.push(String(entry).split(sep).join('/'))
      if (found.length >= limit) break
    }
    return found
  }
}

const grepParams = z.object({
  pattern: z.string().describe('JavaScript 正则表达式'),
  glob: z.string().optional().describe('限定文件范围,例如 "**/*.ts"'),
  limit: z.number().int().min(1).max(200).optional()
})

export const grepTool: ToolDescriptor<z.infer<typeof grepParams>, Array<{ path: string; line: number; text: string }>> = {
  name: 'grep',
  description: '在工作区文本文件中按正则搜索,返回文件、行号与匹配行。',
  parameters: grepParams,
  effects: effectsNone,
  async execute({ pattern, glob: pattern_glob = '**/*.{ts,tsx,js,json,md}', limit = 50 }, ctx: ToolContext) {
    const { glob, readFile } = await import('node:fs/promises')
    const re = new RegExp(pattern)
    const results: Array<{ path: string; line: number; text: string }> = []
    for await (const entry of glob(pattern_glob, { cwd: ctx.workspaceRoot })) {
      const rel = String(entry).split(sep).join('/')
      if (rel.includes('node_modules/') || rel.includes('/dist/') || rel.includes('/out/')) continue
      let content: string
      try { content = await readFile(resolve(ctx.workspaceRoot, rel), 'utf8') } catch { continue }
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          results.push({ path: rel, line: i + 1, text: lines[i]!.slice(0, 300) })
          if (results.length >= limit) return results
        }
      }
    }
    return results
  }
}

const shellParams = z.object({
  command: z.string().describe('可执行文件名,例如 pnpm 或 node'),
  args: z.array(z.string()).optional().describe('参数数组')
})

export const shellTool: ToolDescriptor<z.infer<typeof shellParams>, { code: number | null; stdout: string; stderr: string }> = {
  name: 'shell',
  description: '在工作区执行一条外部命令(直接 spawn,不经过 shell 解释,不支持管道与重定向)。只适合 pnpm/node/git 等真实可执行文件;列目录请用 glob。',
  parameters: shellParams,
  effects: { writesFilesystem: true, accessesNetwork: true, mayIncurCost: false },
  async execute({ command, args = [] }, ctx: ToolContext) {
    const { spawn } = await import('node:child_process')
    const forbidden = /^(cmd|cmd\.exe|powershell|powershell\.exe|pwsh|bash|sh)$/i
    if (forbidden.test(command)) {
      throw new Error(
        `不允许把 ${command} 当壳再套一层命令。本工具已经是执行器:直接传可执行文件名与参数数组,例如 {"command":"node","args":["-v"]}。`
      )
    }
    return await new Promise((res, rej) => {
      const child = spawn(command, args, { cwd: ctx.workspaceRoot, shell: false })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        ctx.signal?.removeEventListener('abort', onAbort)
        fn()
      }
      // 取消必须真的杀掉子进程:只改数据库状态不算"停下"
      const onAbort = () => {
        child.kill()
        finish(() => rej(new Error('已取消')))
      }
      if (ctx.signal) {
        if (ctx.signal.aborted) onAbort()
        else ctx.signal.addEventListener('abort', onAbort, { once: true })
      }
      child.stdout.on('data', (b) => { stdout += String(b) })
      child.stderr.on('data', (b) => { stderr += String(b) })
      child.on('error', (err) => {
        finish(() => {
          const code = (err as NodeJS.ErrnoException).code
          if (code === 'ENOENT') {
            rej(
              new Error(
                `命令 "${command}" 在本机不存在(ENOENT)。Windows 下没有 ls/cat/rm 等 Unix 命令;列目录用 glob(pattern="*"),读文件用 read_file。`
              )
            )
            return
          }
          rej(err)
        })
      })
      child.on('close', (code) => finish(() => res({
        code,
        stdout: stdout.slice(0, 20000),
        stderr: stderr.slice(0, 8000)
      })))
    })
  }
}

/** 破坏性文件工具的宿主依赖。测试可以注入假的回收站,生产默认使用系统回收站。 */
export interface DestructiveToolsDeps {
  backupRoot: string
  trash?: TrashAdapter
  home?: string
  platform?: NodeJS.Platform
  /** 在真正执行前拿到"已审批的计划";返回 null 表示调用方未携带审批计划 */
}

let destructiveDeps: DestructiveToolsDeps | null = null

export function configureDestructiveTools(deps: DestructiveToolsDeps): void {
  destructiveDeps = deps
}

function requireDestructiveDeps(): DestructiveToolsDeps {
  if (!destructiveDeps) {
    throw new SecurityError(
      'DESTRUCTIVE_UNAVAILABLE',
      '破坏性文件工具未初始化;本次没有执行任何操作。'
    )
  }
  return destructiveDeps
}

function planFromContext(ctx: ToolContext): DestructivePlan | null {
  const plan = ctx.destructivePlan
  return plan && typeof plan === 'object' ? (plan as DestructivePlan) : null
}

async function runDestructive(
  toolName: 'delete_files' | 'move_files',
  args: Record<string, unknown>,
  ctx: ToolContext
) {
  const deps = requireDestructiveDeps()
  const request = destructiveRequestFromTool(toolName, args)
  const fresh = await inspectDestructiveRequest(request, {
    workspaceRoot: ctx.workspaceRoot,
    ...(deps.home ? { home: deps.home } : {}),
    ...(deps.platform ? { platform: deps.platform } : {})
  })
  const approved = planFromContext(ctx)
  if (!approved) {
    throw new SecurityError(
      'APPROVAL_PLAN_MISSING',
      '缺少审批时生成的清单,本次没有执行。请重新发起操作。'
    )
  }
  const result = await executeDestructivePlan(approved, fresh, {
    backupRoot: deps.backupRoot,
    trash: deps.trash ?? platformTrashAdapter(deps.platform)
  })
  return {
    operation: result.operation,
    deleted: result.operation === 'delete' ? result.completed.length : 0,
    moved: result.operation === 'move' ? result.completed.length : 0,
    backupDir: result.backupDir,
    manifestPath: result.manifestPath,
    trash: result.trashKind,
    items: result.completed
  }
}

const deleteParams = z.object({
  paths: z.array(z.string().min(1)).min(1).max(MAX_DESTRUCTIVE_BATCH)
    .describe('要删除的路径,绝对路径或相对工作区;单批最多 10 项')
})

export const deleteFilesTool: ToolDescriptor<z.infer<typeof deleteParams>, Awaited<ReturnType<typeof runDestructive>>> = {
  name: 'delete_files',
  description:
    '删除文件或目录:执行前会先备份并送入系统回收站,单批最多 10 项。' +
    '清理/扫描类请求必须先出报告,下一轮再调用本工具。不要用 shell 的 rm/del 删除。',
  parameters: deleteParams,
  effects: { writesFilesystem: true, accessesNetwork: false, mayIncurCost: false },
  async execute(input, ctx) {
    return await runDestructive('delete_files', input as Record<string, unknown>, ctx)
  }
}

const moveParams = z.object({
  items: z.array(z.object({
    from: z.string().min(1).describe('原路径'),
    to: z.string().min(1).describe('新路径;父目录必须已存在,且不会覆盖已有文件')
  })).min(1).max(MAX_DESTRUCTIVE_BATCH).describe('移动清单,单批最多 10 项')
})

export const moveFilesTool: ToolDescriptor<z.infer<typeof moveParams>, Awaited<ReturnType<typeof runDestructive>>> = {
  name: 'move_files',
  description:
    '移动文件或目录:执行前会先备份,单批最多 10 项;目标已存在时拒绝覆盖。不要用 shell 的 mv/move 替代。',
  parameters: moveParams,
  effects: { writesFilesystem: true, accessesNetwork: false, mayIncurCost: false },
  async execute(input, ctx) {
    return await runDestructive('move_files', input as Record<string, unknown>, ctx)
  }
}

const MAX_ARTIFACT_BYTES = 200 * 1024 * 1024

const presentParams = z.object({
  items: z.array(z.object({
    /** file/html/image 用 path;url 用 url */
    path: z.string().optional().describe('工作区内的相对路径(文件类必填)'),
    url: z.string().optional().describe('外链地址(仅 http/https,url 类必填)'),
    title: z.string().min(1).max(120),
    kind: z.enum(['file', 'html', 'url', 'image']).default('file'),
    description: z.string().max(300).optional()
  })).min(1).max(20)
})

type PresentInput = z.input<typeof presentParams>
type PresentParsed = z.output<typeof presentParams>

export const presentFilesTool: ToolDescriptor<PresentInput, { presented: number }> = {
  name: 'present_files',
  description:
    '把本次任务产出的文件或网页呈现给用户。凡产出文件,必须以本工具收尾。path 必须是工作区内真实存在的文件;外链用 url。',
  parameters: presentParams,
  effects: effectsNone,
  async execute(input, ctx: ToolContext) {
    const { items } = presentParams.parse(input) as PresentParsed
    const { stat, readFile } = await import('node:fs/promises')
    const { createHash } = await import('node:crypto')
    const drafts: ArtifactDraft[] = []
    for (const item of items) {
      if (item.kind === 'url') {
        if (!item.url) throw new Error(`url 类交付物缺少 url: ${item.title}`)
        let parsed: URL
        try {
          parsed = new URL(item.url)
        } catch {
          throw new Error(`非法 url: ${item.url}`)
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error(`只允许 http/https 外链,拒绝: ${parsed.protocol}`)
        }
        drafts.push({
          kind: 'url',
          title: item.title,
          url: parsed.toString(),
          ...(item.description ? { description: item.description } : {})
        })
        continue
      }
      if (!item.path) throw new Error(`${item.kind} 类交付物缺少 path: ${item.title}`)
      const abs = await resolveInsideWorkspace(ctx.workspaceRoot, item.path)
      const s = await stat(abs)
      if (!s.isFile()) throw new Error(`不是文件: ${item.path}`)
      if (s.size > MAX_ARTIFACT_BYTES) {
        throw new Error(`文件过大(${s.size} 字节),超过 200MB 上限;请改为交付摘要: ${item.path}`)
      }
      const sha256 = createHash('sha256').update(await readFile(abs)).digest('hex')
      const lower = item.path.toLowerCase()
      const kind = item.kind === 'file'
        ? (lower.endsWith('.html') || lower.endsWith('.htm') ? 'html'
          : /\.(png|jpe?g|gif|webp|svg)$/.test(lower) ? 'image' : 'file')
        : item.kind
      drafts.push({
        kind,
        title: item.title,
        path: item.path,
        size: s.size,
        sha256,
        ...(item.description ? { description: item.description } : {})
      })
    }
    if (!ctx.artifactSink) return { presented: drafts.length }
    const inserted = await ctx.artifactSink.insert(drafts)
    return { presented: inserted.length }
  }
}

const slideBulletParams = z.object({
  text: z.string().min(1).max(400),
  level: z.union([z.literal(1), z.literal(2)]).optional()
})

const slideParams = z.object({
  title: z.string().min(1).max(200),
  bullets: z.array(slideBulletParams).max(12).optional()
})

const presentationParams = z.object({
  path: z.string().describe('相对工作区根目录的 .pptx 路径,例如 report.pptx'),
  title: z.string().min(1).max(200).describe('封面主标题'),
  subtitle: z.string().max(240).optional().describe('封面副标题'),
  slides: z
    .array(slideParams)
    .min(1)
    .max(60)
    .describe('幻灯片顺序。第一页渲染为封面,正文版式从第二页开始')
})

/**
 * 直接产出 .pptx。
 *
 * 让模型自己写 Python 或拼 OOXML 的失败率很高,用户机器也未必装了
 * python-pptx。这里把"生成合法演示文稿"收敛成一次确定性调用:
 * 参数只有标题、要点与文件名,产物结构由宿主保证。
 */
export const createPresentationTool: ToolDescriptor<
  z.infer<typeof presentationParams>,
  { path: string; bytes: number; slides: number }
> = {
  name: 'create_presentation',
  description:
    '生成 .pptx 演示文稿并写入工作区。传入逐页标题与要点即可,不要自己拼接 OOXML 或调用 python-pptx。' +
    '生成后必须再调用 present_files 交付,否则用户拿不到文件。',
  parameters: presentationParams,
  effects: { writesFilesystem: true, accessesNetwork: false, mayIncurCost: false },
  async execute({ path, title, subtitle, slides }, ctx: ToolContext) {
    const rel = path.trim()
    if (!rel.toLowerCase().endsWith('.pptx')) throw new Error('演示文稿路径必须以 .pptx 结尾')
    const abs = await resolveInsideWorkspace(ctx.workspaceRoot, rel)
    const deck = buildDeck({
      title,
      ...(subtitle ? { subtitle } : {}),
      slides: slides.map((slide) => ({
        title: slide.title,
        ...(slide.bullets && slide.bullets.length > 0
          ? {
              bullets: slide.bullets.map((bullet) => ({
                text: bullet.text,
                ...(bullet.level === 2 ? { level: 2 as const } : {})
              }))
            }
          : {})
      }))
    })
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, deck.buffer)
    return { path: rel, bytes: deck.buffer.length, slides: deck.slideCount }
  }
}
export function builtinTools(): Array<ToolDescriptor<any, any>> {
  return [
    readFileTool,
    writeFileTool,
    globTool,
    grepTool,
    shellTool,
    createPresentationTool,
    presentFilesTool,
    deleteFilesTool,
    moveFilesTool
  ]
}

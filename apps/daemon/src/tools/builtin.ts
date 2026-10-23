import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, sep, dirname } from 'node:path'
import { z } from 'zod'
import type { ToolDescriptor, ToolContext } from '@openwb/tools'

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
      child.stdout.on('data', (b) => { stdout += String(b) })
      child.stderr.on('data', (b) => { stderr += String(b) })
      child.on('error', (err) => {
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
      child.on('close', (code) => res({
        code,
        stdout: stdout.slice(0, 20000),
        stderr: stderr.slice(0, 8000)
      }))
    })
  }
}

export const presentFilesTool: ToolDescriptor<{ items: Array<{ path: string; title: string }> }, { presented: number }> = {
  name: 'present_files',
  description: '把本次任务产出的文件呈现给用户。凡产出文件,必须以本工具收尾。',
  parameters: z.object({
    items: z.array(z.object({
      path: z.string().describe('相对工作区的路径'),
      title: z.string().max(120)
    })).min(1).max(20)
  }),
  effects: effectsNone,
  async execute({ items }, ctx: ToolContext) {
    const { stat } = await import('node:fs/promises')
    for (const item of items) {
      const abs = await resolveInsideWorkspace(ctx.workspaceRoot, item.path)
      const s = await stat(abs)
      if (!s.isFile()) throw new Error(`不是文件: ${item.path}`)
    }
    return { presented: items.length }
  }
}

export function builtinTools(): Array<ToolDescriptor<any, any>> {
  return [readFileTool, writeFileTool, globTool, grepTool, shellTool, presentFilesTool]
}

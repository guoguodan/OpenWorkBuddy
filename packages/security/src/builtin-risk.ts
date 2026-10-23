import type { BuiltinRisk, ToolCallView } from './risk.js'

const DESTRUCTIVE_COMMANDS = new Set([
  'rm',
  'rmdir',
  'del',
  'erase',
  'format',
  'diskpart',
  'shutdown',
  'reboot',
  'mkfs',
  'dd',
  'fdisk'
])

/** 永久删除类命令:即使用户点了"允许",也不应通过 shell 执行。 */
const PERMANENT_DELETE_COMMANDS = new Set([
  'rm',
  'rmdir',
  'del',
  'erase',
  'format',
  'diskpart',
  'mkfs',
  'dd',
  'fdisk'
])

const DESTRUCTIVE_ARGS: Array<{ command: string; args: RegExp }> = [
  { command: 'git', args: /^(reset)$/ },
  { command: 'git', args: /^clean$/ },
  { command: 'npm', args: /^(unpublish)$/ },
  { command: 'pnpm', args: /^(unpublish)$/ },
  { command: 'reg', args: /^delete$/ }
]

/**
 * 内置高危判定。
 *
 * 只拦"明确具备破坏语义"的命令;普通 pnpm/node/git 构建不打扰用户。
 * 参数匹配看完整参数序列,避免 `git log --grep=clean` 之类被误判。
 */
export function builtinRisk(call: ToolCallView): BuiltinRisk | null {
  if (call.name !== 'shell') return null
  const command = typeof call.arguments.command === 'string' ? call.arguments.command : ''
  // Windows 上完整路径常带 .exe/.com/.cmd/.bat/.ps1:不剥扩展名就等于漏判。
  const base = (command.split(/[\\/]/).pop()?.toLowerCase() ?? '').replace(/\.(exe|com|cmd|bat|ps1)$/, '')
  const args = Array.isArray(call.arguments.args)
    ? call.arguments.args.filter((item): item is string => typeof item === 'string')
    : []

  if (DESTRUCTIVE_COMMANDS.has(base)) {
    if (PERMANENT_DELETE_COMMANDS.has(base)) {
      return {
        kind: 'blocked-command',
        groupKey: `builtin:shell:${base}`,
        title: '不能通过 shell 永久删除',
        detail:
          `检测到 ${base}。宿主只允许通过 delete_files 删除:它会先备份、送入系统回收站,并限制单批数量。` +
          ' 请改用 delete_files。',
        code: 'USE_DELETE_TOOL'
      }
    }
    return {
      kind: 'high-risk',
      groupKey: `builtin:shell:${base}`,
      title: '该命令可能删除或破坏数据',
      detail: `检测到高危命令 ${base};确认后才执行。`
    }
  }
  for (const rule of DESTRUCTIVE_ARGS) {
    if (rule.command !== base) continue
    const first = args[0]?.toLowerCase() ?? ''
    if (rule.args.test(first)) {
      return {
        kind: 'high-risk',
        groupKey: `builtin:shell:${base}:${first}`,
        title: '该命令可能丢弃未保存的改动',
        detail: `检测到高危子命令 ${base} ${first};确认后才执行。`
      }
    }
  }
  return null
}

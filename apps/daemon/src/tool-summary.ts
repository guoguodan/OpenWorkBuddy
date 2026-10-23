/**
 * 工具结果的界面投影(IMPLEMENTATION §3.8)。
 *
 * 单独成模块是为了能被单元测试直接覆盖:这里的分支顺序很敏感,
 * 通用的"字符串按原样展示"分支一旦放在专用分支之前,
 * read_file/write_file 的可读摘要就会被静默吞掉。
 */

/**
 * 工具失败必须是「可回填的结果」,而不是让整轮对话崩掉。
 *
 * AI SDK v4 里 execute 抛错会终止整个 streamText:模型收不到失败原因,
 * 客户端也收不到 tool.finished,工具行会永远停在转圈。这里统一包成
 * { ok: false, error } 交给模型,由它决定重试或换一种做法。
 */
export interface ToolFailure {
  ok: false
  error: string
  code: string
}

export function isToolFailure(value: unknown): value is ToolFailure {
  return Boolean(
    value && typeof value === 'object' && (value as { ok?: unknown }).ok === false &&
      typeof (value as { error?: unknown }).error === 'string'
  )
}

export function toToolFailure(err: unknown): ToolFailure {
  const message = err instanceof Error ? err.message : String(err)
  const code = (err as { code?: unknown })?.code
  return { ok: false, error: message, code: typeof code === 'string' ? code : 'TOOL_FAILED' }
}

/**
 * 把工具返回值压成界面能读的一行。原始 JSON 直接甩到界面上很像报错,
 * 而且 shell 的非零退出码在语义上也应当算失败。
 */
export function summarizeToolResult(name: string, result: unknown): { ok: boolean; summary: string } {
  if (isToolFailure(result)) return { ok: false, summary: result.error }
  if (name === 'load_skill') return { ok: true, summary: '技能已加载' }

  if (name === 'shell' && result && typeof result === 'object') {
    const r = result as { code?: number | null; stdout?: string; stderr?: string }
    const output = (r.stdout || r.stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(0, 2).join(' / ')
    return {
      ok: r.code === 0,
      summary: `退出码 ${r.code ?? 'null'}${output ? ` · ${output.slice(0, 140)}` : ''}`
    }
  }
  if (name === 'read_file' && typeof result === 'string') {
    return { ok: true, summary: `${Buffer.byteLength(result, 'utf8')} 字节` }
  }
  if (name === 'write_file' && typeof result === 'string') return { ok: true, summary: result }
  if ((name === 'delete_files' || name === 'move_files') && result && typeof result === 'object') {
    const r = result as { deleted?: number; moved?: number; backupDir?: string }
    const count = name === 'delete_files' ? r.deleted ?? 0 : r.moved ?? 0
    const verb = name === 'delete_files' ? '已删除并送入回收站' : '已移动'
    return {
      ok: true,
      // 备份路径必须出现在工具行里:用户不打开详情也能知道去哪找回文件。
      summary: `${verb} ${count} 项 · 备份: ${r.backupDir ?? '(未知)'}`
    }
  }
  // 插件工具通常返回一段纯文本,按原样展示比一串转义 JSON 可读得多
  if (typeof result === 'string') {
    const oneLine = result.trim().replace(/\s+/g, ' ')
    return { ok: true, summary: oneLine.length > 140 ? `${oneLine.slice(0, 140)}…` : oneLine }
  }
  if (Array.isArray(result)) {
    return { ok: true, summary: result.length > 0 ? `${result.length} 项` : '无结果' }
  }
  if (result && typeof result === 'object' && 'presented' in result) {
    return { ok: true, summary: `已呈现 ${(result as { presented: number }).presented} 个文件` }
  }
  return { ok: true, summary: JSON.stringify(result).slice(0, 140) }
}

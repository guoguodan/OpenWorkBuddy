import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AssembledPrompt } from './assembler.js'

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export interface PromptTrace {
  modeId: string
  fragments: Array<{ name: string; bytes: number }>
  /** 模式模板自身的哈希(不含项目/助理/场景等动态注入),用于 P2 的提示词稳定性比对 */
  outputSha256: string
  outputBytes: number
  timestamp: string
  /** 本次会话实际下发给模型的工具白名单,便于核对模式边界 */
  allowedTools?: string[]
  /** 本轮激活的技能名;未加载技能时不写该字段 */
  skill?: string
  /** 本轮生效的项目 ID(仅用于核对项目上下文是否进入运行链) */
  projectId?: string
  /** 本轮最终 system 文本的摘要:包含项目、助理、场景、上下文文件等动态注入 */
  systemSha256?: string
  systemBytes?: number
  /** 本轮注入 system 的上下文段落名(只记类型,不落原文,避免泄漏记忆与文件内容) */
  injected?: string[]
  /** 本轮实际完成(或最终失败)的模型名;发生降级时记录备用模型。 */
  model?: string
}

export function buildTrace(
  modeId: string,
  assembled: AssembledPrompt,
  allowedTools?: string[],
  skill?: string,
  projectId?: string,
  systemText?: string,
  injected?: string[],
  model?: string
): PromptTrace {
  return {
    modeId,
    fragments: assembled.fragments,
    outputSha256: sha256(assembled.text),
    outputBytes: Buffer.byteLength(assembled.text, 'utf8'),
    timestamp: new Date().toISOString(),
    ...(allowedTools ? { allowedTools } : {}),
    ...(skill ? { skill } : {}),
    ...(projectId ? { projectId } : {}),
    ...(systemText !== undefined
      ? {
          systemSha256: sha256(systemText),
          systemBytes: Buffer.byteLength(systemText, 'utf8')
        }
      : {}),
    ...(injected && injected.length > 0 ? { injected } : {}),
    ...(model ? { model } : {})
  }
}

export async function writeTrace(traceDir: string, trace: PromptTrace): Promise<string> {
  await mkdir(traceDir, { recursive: true })
  const file = join(traceDir, `prompt-${trace.modeId}-${Date.now()}.json`)
  await writeFile(file, JSON.stringify(trace, null, 2), 'utf8')
  return file
}

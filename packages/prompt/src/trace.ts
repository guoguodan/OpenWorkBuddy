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
  outputSha256: string
  outputBytes: number
  timestamp: string
  /** 本次会话实际下发给模型的工具白名单,便于核对模式边界 */
  allowedTools?: string[]
  /** 本轮激活的技能名;未加载技能时不写该字段 */
  skill?: string
}

export function buildTrace(
  modeId: string,
  assembled: AssembledPrompt,
  allowedTools?: string[],
  skill?: string
): PromptTrace {
  return {
    modeId,
    fragments: assembled.fragments,
    outputSha256: sha256(assembled.text),
    outputBytes: Buffer.byteLength(assembled.text, 'utf8'),
    timestamp: new Date().toISOString(),
    ...(allowedTools ? { allowedTools } : {}),
    ...(skill ? { skill } : {})
  }
}

export async function writeTrace(traceDir: string, trace: PromptTrace): Promise<string> {
  await mkdir(traceDir, { recursive: true })
  const file = join(traceDir, `prompt-${trace.modeId}-${Date.now()}.json`)
  await writeFile(file, JSON.stringify(trace, null, 2), 'utf8')
  return file
}

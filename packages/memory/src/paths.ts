import { realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 防路径穿越:目标必须真的落在工作区内(解析符号链接后再比较) */
export async function assertInside(root: string, target: string): Promise<string> {
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(target)
  const rel = relative(resolvedRoot, resolvedTarget)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径越界: ${target} 不在工作区 ${resolvedRoot} 内`)
  }
  // 已存在的父目录再做一次真实路径校验,防止软链接把写入带出去
  let probe = resolvedTarget
  for (let i = 0; i < 16; i++) {
    try {
      const real = await realpath(probe)
      const realRoot = await realpath(resolvedRoot).catch(() => resolvedRoot)
      const relReal = relative(realRoot, real)
      if (relReal.startsWith('..') || isAbsolute(relReal)) {
        throw new Error(`路径经符号链接越界: ${target}`)
      }
      return resolvedTarget
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      const parent = probe.slice(0, probe.lastIndexOf(sep))
      if (!parent || parent === probe) return resolvedTarget
      probe = parent
    }
  }
  return resolvedTarget
}

export function userMemoryPath(dataDir: string): string {
  return join(dataDir, 'memory', 'MEMORY.md')
}

export function workspaceMemoryDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.openwb', 'memory')
}

export function workspaceDailyPath(workspaceRoot: string, isoDate: string): string {
  return join(workspaceMemoryDir(workspaceRoot), `${isoDate}.md`)
}
import { homedir } from 'node:os'
import { isAbsolute, resolve, sep } from 'node:path'

export type PathCategory = 'workspace' | 'personal' | 'system' | 'other'

/**
 * 系统目录直接拒绝写入/删除。
 *
 * 这里只做"静态已知根目录"判定,不尝试枚举注册表或挂载点:
 * 判定不确定时返回 other(需确认),而不是 allow。
 */
export function defaultSystemRoots(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') {
    const drive = process.env.SystemDrive ?? 'C:'
    return [
      `${drive}\\Windows`,
      `${drive}\\Program Files`,
      `${drive}\\Program Files (x86)`,
      `${drive}\\ProgramData`
    ]
  }
  if (platform === 'darwin') {
    return ['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/private/etc', '/var', '/private/var']
  }
  return ['/usr', '/bin', '/sbin', '/etc', '/lib', '/lib64', '/boot', '/sys', '/proc', '/dev']
}

export function normalizePathForCompare(input: string, platform: NodeJS.Platform = process.platform): string {
  let out = resolve(input)
  // Windows 路径大小写不敏感,同时统一分隔符,避免 C:\Windows 与 c:/windows 判定不一致
  if (platform === 'win32') out = out.replace(/\//g, '\\').toLowerCase()
  return out.replace(/[\\/]+$/, '')
}

function contains(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const p = normalizePathForCompare(parent, platform)
  const c = normalizePathForCompare(child, platform)
  if (p === c) return true
  const withSep = p.endsWith(sep) ? p : p + sep
  return c.startsWith(withSep)
}

/**
 * 路径类别。分类顺序很重要:
 * 工作区优先(默认工作区就位于"文档"下),其次系统目录,再次个人目录。
 */
export function classifyPath(
  target: string,
  workspaceRoot: string,
  options: {
    platform?: NodeJS.Platform
    home?: string
    systemRoots?: string[]
  } = {}
): PathCategory {
  if (typeof target !== 'string' || target.trim().length === 0) throw new Error('路径不能为空')
  if (target.includes('\0')) throw new Error('路径含非法字符')
  const platform = options.platform ?? process.platform
  const workspace = resolve(workspaceRoot)
  const abs = isAbsolute(target) ? resolve(target) : resolve(workspace, target)

  if (contains(workspace, abs, platform)) return 'workspace'

  const roots = options.systemRoots ?? defaultSystemRoots(platform)
  if (roots.some((root) => contains(root, abs, platform))) return 'system'

  const home = options.home ?? homedir()
  const personalNames = ['Desktop', 'Downloads', 'Documents', 'Pictures', 'Music', 'Videos']
  const personalRoots = personalNames.map((name) => resolve(home, name))
  const oneDrive = process.env.OneDrive ? resolve(process.env.OneDrive) : null
  if (oneDrive) personalRoots.push(oneDrive)
  if (personalRoots.some((root) => contains(root, abs, platform))) return 'personal'

  return 'other'
}

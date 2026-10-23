import { join } from 'node:path'
import type { PluginManifest } from './manifest.js'
import { expandRefs } from './manifest.js'

/** 宿主凭据一律不进入插件子进程;例外只能是插件自己声明的凭据 key */
export const HOST_SECRET_PATTERN = /^(OPENAI_|ANTHROPIC_|AWS_|AZURE_|GITHUB_|GH_|SSH_|OPENWB_)/i

export interface EnvInput {
  pluginRoot: string
  dataDir: string
  /** 运行时由主进程解密的凭据;P5 阶段为空对象,表示"尚未配置" */
  credentials: Record<string, string>
  platform?: NodeJS.Platform
}

export class CredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CredentialError'
  }
}

/** `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` / 已声明凭据;其余引用原样报错,不做静默替换 */
export function expandVars(template: string, input: EnvInput): string {
  return template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    if (name === 'PLUGIN_ROOT') return input.pluginRoot
    if (name === 'PLUGIN_DATA') return input.dataDir
    const value = input.credentials[name]
    if (value !== undefined) return value
    throw new CredentialError(`没有可用的变量 ${name}(凭据未配置或未声明)`)
  })
}

/**
 * 子进程环境 = 最小系统变量 + 插件声明且可解析的变量。
 *
 * 关键点:
 * - 不从 process.env 复制任何东西,只显式给出 PATH/TEMP 等系统必需项;
 * - 即使插件在 env 里写了 OPENAI_API_KEY,只要没在 credentials 里声明就直接拒绝;
 * - 声明了但没有运行时值 → 报错,避免以"空字符串"悄悄跑起来。
 */
export function buildSafeEnv(
  manifest: PluginManifest,
  input: EnvInput,
  declared: Record<string, string>
): Record<string, string> {
  const platform = input.platform ?? process.platform
  const pathKey = platform === 'win32' ? 'Path' : 'PATH'
  const base: Record<string, string> = {}
  const path = process.env[pathKey] ?? process.env.PATH ?? ''
  if (path) base[pathKey] = path
  if (platform === 'win32') {
    if (process.env.SystemRoot) base.SystemRoot = process.env.SystemRoot
    if (process.env.TEMP) base.TEMP = process.env.TEMP
    if (process.env.TMP) base.TMP = process.env.TMP
    if (process.env.USERPROFILE) base.USERPROFILE = process.env.USERPROFILE
    if (process.env.APPDATA) base.APPDATA = process.env.APPDATA
    if (process.env.LOCALAPPDATA) base.LOCALAPPDATA = process.env.LOCALAPPDATA
    if (process.env.COMSPEC) base.COMSPEC = process.env.COMSPEC
    if (process.env.PATHEXT) base.PATHEXT = process.env.PATHEXT
  } else {
    if (process.env.TMPDIR) base.TMPDIR = process.env.TMPDIR
    if (process.env.HOME) base.HOME = process.env.HOME
  }
  base.PLUGIN_ROOT = input.pluginRoot
  base.PLUGIN_DATA = input.dataDir

  const declaredKeys = new Set(manifest.credentials.map((c) => c.key))
  const resolved: Record<string, string> = {}

  for (const [key, template] of Object.entries(declared)) {
    if (HOST_SECRET_PATTERN.test(key) && !declaredKeys.has(key)) {
      throw new CredentialError(`插件 ${manifest.name} 试图读取未声明凭据 ${key}`)
    }
    for (const ref of expandRefs(template)) {
      if (!declaredKeys.has(ref) && ref !== 'PLUGIN_ROOT' && ref !== 'PLUGIN_DATA') {
        throw new CredentialError(`插件 ${manifest.name} 引用了未声明变量 ${ref}`)
      }
    }
    resolved[key] = expandVars(template, input)
  }

  // 只注入插件声明且当前有值的凭据
  for (const credential of manifest.credentials) {
    const value = input.credentials[credential.key]
    if (value !== undefined) {
      resolved[credential.key] = value
    } else if (credential.required) {
      throw new CredentialError(`缺少必需凭据 ${credential.key}(${credential.label})`)
    }
  }

  return { ...base, ...resolved }
}

export function pluginDataDir(pluginsDataRoot: string, pluginName: string): string {
  return join(pluginsDataRoot, pluginName)
}

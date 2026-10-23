import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseManifest, assertManifestCoherent, compareSemver, type PluginManifest } from './manifest.js'
import { assertInsidePlugin, formatBytes, scanPluginDir, PluginScanError } from './files.js'

export interface InstallOptions {
  /** 插件源目录 */
  sourceDir: string
  /** <dataDir>/plugins */
  pluginsRoot: string
  hostVersion: string
  /** 含 shell 权限时必须显式确认 */
  confirmShell?: boolean
}

export interface InstalledPlugin {
  name: string
  manifest: PluginManifest
  dir: string
  /** 未提供 signature.json 时为 false,UI 需显示"未验证发布者" */
  verifiedPublisher: boolean
  warnings: string[]
}

export class PluginInstallError extends Error {
  constructor(
    readonly stage: string,
    readonly detail: string
  ) {
    super(`插件安装失败(${stage}): ${detail}`)
    this.name = 'PluginInstallError'
  }
}

/**
 * 安装校验(IMPLEMENTATION §6.4),顺序即失败优先级:
 * 1. plugin.json 存在且结构合法
 * 2. name 与目录名一致 / version 是 semver(schema 已保证)
 * 3. minHostVersion <= 宿主版本
 * 4. 权限枚举合法,shell 需人工确认
 * 5. 入口文件存在且不含 ..
 * 6. 体积 / 文件数上限
 * 7. 明文凭据扫描
 * 8. signature.json 可选,未签名只警告
 *
 * 只有全部通过才复制到 pluginsRoot;复制后若最终状态不完整,回滚删除。
 */
export async function installPlugin(options: InstallOptions): Promise<InstalledPlugin> {
  const source = resolve(options.sourceDir)
  const info = await stat(source).catch(() => null)
  if (!info?.isDirectory()) throw new PluginInstallError('source', `不是目录: ${source}`)

  let raw: string
  try {
    raw = await readFile(join(source, 'plugin.json'), 'utf8')
  } catch {
    throw new PluginInstallError('manifest', '缺少 plugin.json')
  }

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    throw new PluginInstallError('manifest', `plugin.json 不是合法 JSON: ${(err as Error).message}`)
  }

  let manifest: PluginManifest
  try {
    manifest = parseManifest(data)
    assertManifestCoherent(manifest)
  } catch (err) {
    throw new PluginInstallError('manifest', (err as Error).message)
  }

  const dirName = basename(source)
  if (manifest.name !== dirName) {
    throw new PluginInstallError('naming', `name (${manifest.name}) 与目录名 (${dirName}) 不一致`)
  }

  if (compareSemver(manifest.minHostVersion, options.hostVersion) > 0) {
    throw new PluginInstallError(
      'compat',
      `插件要求宿主 >= ${manifest.minHostVersion},当前 ${options.hostVersion}`
    )
  }

  if (manifest.permissions.includes('shell') && options.confirmShell !== true) {
    throw new PluginInstallError('permission', '插件申请 shell 权限,必须人工确认后才能安装')
  }

  // 入口文件检查:所有 mcpServers 里出现的 ${PLUGIN_ROOT}/... 都要真实存在
  for (const [serverName, spec] of Object.entries(manifest.mcpServers)) {
    for (const arg of spec.args) {
      if (!arg.startsWith('${PLUGIN_ROOT}/') && !arg.startsWith('${PLUGIN_ROOT}\\')) continue
      const rel = arg.slice('${PLUGIN_ROOT}/'.length)
      let abs: string
      try {
        abs = assertInsidePlugin(source, rel)
      } catch (err) {
        throw new PluginInstallError('entry', (err as Error).message)
      }
      const entryInfo = await stat(abs).catch(() => null)
      if (!entryInfo?.isFile()) {
        throw new PluginInstallError('entry', `${serverName} 的入口不存在: ${rel}`)
      }
    }
  }

  let scan
  try {
    scan = await scanPluginDir(source)
  } catch (err) {
    if (err instanceof PluginScanError) throw new PluginInstallError('scan', err.message)
    throw err
  }

  if (scan.credentialHits.length > 0) {
    const detail = scan.credentialHits.map((h) => `${h.path} (${h.label})`).join(', ')
    throw new PluginInstallError('credentials', `插件内含明文凭据: ${detail}`)
  }

  const warnings: string[] = []
  if (scan.partiallyScanned.length > 0) {
    warnings.push(`${scan.partiallyScanned.length} 个文件超过 256KB,凭据扫描只覆盖前 256KB`)
  }
  if (scan.skippedLinks.length > 0) {
    warnings.push(`跳过 ${scan.skippedLinks.length} 个符号链接(不随插件安装)`)
  }

  let verifiedPublisher = false
  try {
    const sigRaw = await readFile(join(source, 'signature.json'), 'utf8')
    const sig = JSON.parse(sigRaw) as { publisher?: string; signature?: string }
    // P5 只校验字段完整性;真正的公钥验签需要发布者公钥分发,属于 P8 发布链路。
    verifiedPublisher = Boolean(sig.publisher && sig.signature)
    if (!verifiedPublisher) warnings.push('signature.json 缺少 publisher 或 signature 字段')
  } catch {
    warnings.push('未验证发布者(没有 signature.json)')
  }

  await mkdir(options.pluginsRoot, { recursive: true })
  const target = join(options.pluginsRoot, manifest.name)
  const staging = join(options.pluginsRoot, `.staging-${manifest.name}-${Date.now()}`)

  try {
    // 不把符号链接带进宿主目录:先记录,复制后逐条删除
    await cp(source, staging, { recursive: true, force: true, dereference: false })
    for (const link of scan.skippedLinks) {
      await rm(join(staging, link), { recursive: true, force: true }).catch(() => undefined)
    }
    await rm(target, { recursive: true, force: true })
    await cp(staging, target, { recursive: true, force: true, dereference: false })
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw new PluginInstallError('copy', (err as Error).message)
  }
  await rm(staging, { recursive: true, force: true }).catch(() => undefined)

  // 复制后复核一次:中途被截断的文件不应留成"看起来装好了"
  const copied = await scanPluginDir(target).catch(() => null)
  if (!copied || copied.files === 0) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
    throw new PluginInstallError('verify', '复制后的插件目录不完整,已回滚')
  }

  if (!verifiedPublisher) warnings.push('该插件未验证发布者,请确认来源可信')

  await writeFile(
    join(target, '.openwb-install.json'),
    JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        installedAt: new Date().toISOString(),
        hostVersion: options.hostVersion,
        verifiedPublisher,
        bytes: formatBytes(copied.bytes),
        warnings
      },
      null,
      2
    ),
    'utf8'
  )

  return {
    name: manifest.name,
    manifest,
    dir: target,
    verifiedPublisher,
    warnings: [...new Set(warnings)]
  }
}

export interface DiscoveredPlugin {
  name: string
  dir: string
  manifest: PluginManifest
  /** 未验证发布者 / 扫描告警等非致命信息 */
  warnings: string[]
  /** 安装时是否提供了 signature.json(P5 只检查字段完整性) */
  verifiedPublisher: boolean
}

export interface DiscoverPluginsResult {
  plugins: DiscoveredPlugin[]
  issues: Array<{ path: string; reason: string }>
}

/**
 * 发现已安装插件。坏插件只记 issue,不阻塞其它插件加载;
 * 这是 P5 的最低要求:单个插件损坏不能让 daemon 起不来。
 */
export async function discoverPlugins(pluginsRoot: string): Promise<DiscoverPluginsResult> {
  const { readdir } = await import('node:fs/promises')
  const plugins: DiscoveredPlugin[] = []
  const issues: Array<{ path: string; reason: string }> = []

  let entries: string[]
  try {
    entries = await readdir(pluginsRoot)
  } catch {
    return { plugins, issues }
  }

  for (const entry of entries.sort()) {
    if (entry.startsWith('.')) continue
    const dir = join(pluginsRoot, entry)
    try {
      const raw = await readFile(join(dir, 'plugin.json'), 'utf8')
      const manifest = parseManifest(JSON.parse(raw))
      assertManifestCoherent(manifest)
      if (manifest.name !== entry) {
        issues.push({ path: dir, reason: `name (${manifest.name}) 与目录名 (${entry}) 不一致` })
        continue
      }
      const warnings: string[] = []
      if (manifest.permissions.includes('shell')) {
        warnings.push('该插件申请 shell 权限,默认不启用')
      }
      let verifiedPublisher = false
      try {
        const installMeta = JSON.parse(await readFile(join(dir, '.openwb-install.json'), 'utf8')) as {
          verifiedPublisher?: boolean
          warnings?: string[]
        }
        verifiedPublisher = installMeta.verifiedPublisher === true
        if (Array.isArray(installMeta.warnings)) warnings.push(...installMeta.warnings)
      } catch {
        // 手工放入的插件没有安装元数据,按未验证处理
      }
      plugins.push({ name: manifest.name, dir, manifest, warnings: [...new Set(warnings)], verifiedPublisher })
    } catch (err) {
      issues.push({ path: dir, reason: (err as Error).message })
    }
  }

  return { plugins, issues }
}

export async function uninstallPlugin(pluginsRoot: string, name: string): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new PluginInstallError('uninstall', `非法插件名: ${name}`)
  await rm(join(pluginsRoot, name), { recursive: true, force: true })
}

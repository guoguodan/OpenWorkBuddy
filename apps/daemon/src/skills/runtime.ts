import { resolve } from 'node:path'
import { homedir } from 'node:os'
import {
  discoverSkills,
  loadSkill,
  narrowTools,
  renderSkillIndex,
  type SkillIndexEntry,
  type SkillIssue,
  type SkillRoot
} from '@openwb/skills'
import { rm } from 'node:fs/promises'

const MAX_INJECT_BYTES = 12 * 1024

export interface ActiveSkill {
  name: string
  allowedTools?: string[]
}

export interface SkillStatusEntry extends SkillIndexEntry {
  enabled: boolean
}

/**
 * 用户级技能目录:
 *   Windows: %APPDATA%\OpenWorkBuddy\skills
 *   macOS:   ~/Library/Application Support/OpenWorkBuddy/skills
 *   Linux:   $XDG_CONFIG_HOME/OpenWorkBuddy/skills
 * 项目级技能目录:<workspace>/.OpenWorkBuddy/skills
 *
 * 顺序即优先级:越靠前越优先(同名时先到先得,scope 由调用方声明)。
 */
export function defaultSkillRoots(workspaceRoot: string, bundledSkillsDir?: string): SkillRoot[] {
  const appData =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? resolve(homedir(), 'AppData/Roaming'))
      : process.platform === 'darwin'
        ? resolve(homedir(), 'Library/Application Support')
        : (process.env.XDG_CONFIG_HOME ?? resolve(homedir(), '.config'))

  const roots: SkillRoot[] = [
    { path: resolve(workspaceRoot, '.OpenWorkBuddy/skills'), scope: 'project' },
    { path: resolve(appData, 'OpenWorkBuddy/skills'), scope: 'user' }
  ]
  if (bundledSkillsDir) roots.push({ path: resolve(bundledSkillsDir), scope: 'project' })
  return roots
}

export class SkillRuntime {
  private entries: SkillIndexEntry[] = []
  private problemList: SkillIssue[] = []
  private active: ActiveSkill | null = null
  private allowedNames: string[] | null = null
  private disabledNames = new Set<string>()

  constructor(private readonly roots: SkillRoot[]) {}

  async refresh(): Promise<{ entries: SkillIndexEntry[]; issues: SkillIssue[] }> {
    const result = await discoverSkills(this.roots)
    this.entries = result.entries
    this.problemList = result.issues
    return result
  }

  list(): SkillIndexEntry[] {
    return this.entries.filter(
      (entry) =>
        !this.disabledNames.has(entry.name) &&
        (!this.allowedNames || this.allowedNames.includes(entry.name))
    )
  }

  /** 设置页需要看到已安装但已关闭的技能,因此状态列表不受禁用集合过滤。 */
  statusList(): SkillStatusEntry[] {
    return this.entries.map((entry) => ({ ...entry, enabled: !this.disabledNames.has(entry.name) }))
  }

  entryOf(name: string): SkillIndexEntry | undefined {
    return this.entries.find((entry) => entry.name === name)
  }

  /** 只接受已发现的技能名;未知名字保留在设置里会导致以后重装同名技能时意外关闭。 */
  setDisabled(names: string[]): void {
    const known = new Set(this.entries.map((entry) => entry.name))
    this.disabledNames = new Set(
      names.filter((name) => typeof name === 'string' && known.has(name.trim())).map((name) => name.trim())
    )
  }

  disabled(): string[] {
    return [...this.disabledNames].sort()
  }

  /** 只允许删除用户级技能目录下的技能;内置与项目级技能由仓库/项目维护。 */
  async removeUserSkill(name: string): Promise<SkillIndexEntry> {
    const entry = this.entries.find((item) => item.name === name)
    if (!entry) throw new Error(`未知技能: ${name}`)
    if (entry.scope !== 'user') throw new Error(`技能 ${name} 属于项目目录或内置技能,不能在这里卸载`)
    await rm(entry.dir, { recursive: true, force: true })
    this.entries = this.entries.filter((item) => item.name !== name)
    this.disabledNames.delete(name)
    return entry
  }

  issues(): SkillIssue[] {
    return [...this.problemList]
  }

  find(name: string): SkillIndexEntry | undefined {
    return this.list().find((e) => e.name === name)
  }

  /** 只有 name + description,正文按需加载 */
  indexText(): string {
    // 索引也必须遵循助理白名单;否则模型会看到一个"可加载"但 load 时被拒绝的技能。
    return renderSkillIndex(this.list())
  }

  activeSkill(): ActiveSkill | null {
    return this.active
  }

  reset(): void {
    this.active = null
    this.allowedNames = null
  }

  /** 助理绑定的技能白名单:null 表示不限制(沿用全局索引)。 */
  setAllowed(names: string[] | null): void {
    this.allowedNames = names === null ? null : [...new Set(names.filter((name) => name.length > 0))]
  }

  async load(name: string): Promise<{ name: string; body: string; allowedTools?: string[] }> {
    if (this.disabledNames.has(name)) {
      throw new Error(`技能 ${name} 已关闭自动触发,请先在「专家·技能·连接器」中开启`)
    }
    const entry = this.find(name)
    if (!entry) {
      const available = this.entries.map((e) => e.name).join(', ') || '(无)'
      throw new Error(`未知技能: ${name}。可用技能: ${available}`)
    }
    const manifest = await loadSkill(entry)

    let body = manifest.body
    const bytes = Buffer.byteLength(body, 'utf8')
    let truncated = false
    if (bytes > MAX_INJECT_BYTES) {
      body = body.slice(0, MAX_INJECT_BYTES)
      truncated = true
    }

    this.active = {
      name: manifest.name,
      ...(manifest.allowedTools ? { allowedTools: manifest.allowedTools } : {})
    }

    const toolsLine = manifest.allowedTools
      ? `\n\n[本技能声明可用工具: ${manifest.allowedTools.join(', ')};与当前模式取交集后生效]`
      : '\n\n[本技能未声明 allowed-tools,不额外收窄工具集]'
    const footer = truncated
      ? `\n\n[已截断:原文 ${bytes} 字节,仅注入前 ${MAX_INJECT_BYTES} 字节]`
      : ''

    return {
      name: manifest.name,
      body: `[技能 ${manifest.name}]\n\n${body}${toolsLine}${footer}`,
      ...(manifest.allowedTools ? { allowedTools: manifest.allowedTools } : {})
    }
  }

  /** 模式允许 ∩ 技能声明;技能未声明则不收窄 */
  narrow(modeAllowed: string[]): string[] {
    return narrowTools(modeAllowed, this.active?.allowedTools)
  }

  /** 工具执行前的第二道闸:技能声明了但没列出的工具一律拒绝 */
  assertAllowed(toolName: string): void {
    if (toolName === 'load_skill') return
    const allowed = this.active?.allowedTools
    if (!allowed) return
    if (!allowed.includes(toolName)) {
      throw new Error(`技能 ${this.active?.name} 只允许使用 [${allowed.join(', ')}],${toolName} 被拒绝`)
    }
  }
}

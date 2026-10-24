import { resolve } from 'node:path'
import { homedir } from 'node:os'
import {
  discoverSkills,
  missingDependencies,
  loadSkill,
  narrowTools,
  renderSkillIndex,
  runSkillScript,
  type SkillIndexEntry,
  type SkillIssue,
  type SkillRoot,
  type SkillScriptResult,
  type SkillTriggerConflict
} from '@openwb/skills'
import { rm } from 'node:fs/promises'

const MAX_INJECT_BYTES = 12 * 1024
const MAX_DEPENDENCY_DEPTH = 16

export interface ActiveSkill {
  name: string
  allowedTools?: string[]
  /** 依赖链上声明的脚本并集;只有这里列出的脚本可执行 */
  scripts?: string[]
}

export interface SkillStatusEntry extends SkillIndexEntry {
  enabled: boolean
  missingDependencies?: string[]
  disabledDependencies?: string[]
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
  private conflictList: SkillTriggerConflict[] = []
  private active: ActiveSkill | null = null
  private activeChain: string[] = []
  private allowedNames: string[] | null = null
  private disabledNames = new Set<string>()

  constructor(private readonly roots: SkillRoot[]) {}

  async refresh(): Promise<{ entries: SkillIndexEntry[]; issues: SkillIssue[] }> {
    const result = await discoverSkills(this.roots)
    this.entries = result.entries
    this.conflictList = result.conflicts
    const issues = [...result.issues]

    for (const entry of result.entries) {
      const problem = missingDependencies(entry, result.entries, this.disabled())
      if (problem.missing.length > 0) {
        issues.push({
          path: entry.path,
          reason: `缺少依赖技能 [${problem.missing.join(', ')}];安装依赖后可恢复正常加载`
        })
      }
    }
    for (const conflict of result.conflicts) {
      if (conflict.winner !== null) continue
      issues.push({
        path: conflict.skills.join(', '),
        reason: `触发域冲突: ${conflict.reason}`
      })
    }
    this.problemList = issues
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
    return this.entries.map((entry) => {
      const problem = missingDependencies(entry, this.entries, this.disabled())
      return {
        ...entry,
        enabled: !this.disabledNames.has(entry.name),
        ...(problem.missing.length > 0 ? { missingDependencies: problem.missing } : {}),
        ...(problem.disabled.length > 0 ? { disabledDependencies: problem.disabled } : {})
      }
    })
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
    // 依赖状态随开关变化,重算一次 issue 列表。
    const issues = [...this.problemList.filter((issue) => !issue.reason.startsWith('缺少依赖技能'))]
    for (const entry of this.entries) {
      const problem = missingDependencies(entry, this.entries, this.disabled())
      if (problem.missing.length > 0 || problem.disabled.length > 0) {
        const parts: string[] = []
        if (problem.missing.length > 0) parts.push(`缺少 [${problem.missing.join(', ')}]`)
        if (problem.disabled.length > 0) parts.push(`依赖已关闭 [${problem.disabled.join(', ')}]`)
        issues.push({ path: entry.path, reason: parts.join(';') })
      }
    }
    this.problemList = issues
  }

  disabled(): string[] {
    return [...this.disabledNames].sort()
  }

  /** 只允许删除用户级技能目录下的技能;内置与项目级技能由仓库/项目维护。 */
  async removeUserSkill(name: string): Promise<SkillIndexEntry> {
    const entry = this.entries.find((item) => item.name === name)
    if (!entry) throw new Error(`未知技能: ${name}`)
    if (entry.scope !== 'user') throw new Error(`技能 ${name} 属于项目目录或内置技能,不能在这里卸载`)
    const dependents = this.entries.filter((item) => (item.requires ?? []).includes(name))
    if (dependents.length > 0) {
      throw new Error(
        `技能 ${name} 仍被 [${dependents.map((item) => item.name).join(', ')}] 依赖,请先处理这些技能的 requires`
      )
    }
    await rm(entry.dir, { recursive: true, force: true })
    this.entries = this.entries.filter((item) => item.name !== name)
    this.disabledNames.delete(name)
    return entry
  }

  issues(): SkillIssue[] {
    return [...this.problemList]
  }

  conflicts(): SkillTriggerConflict[] {
    return this.conflictList.map((conflict) => ({ ...conflict, skills: [...conflict.skills] }))
  }

  /** 按触发域选择技能:唯一最高 priority 自动胜出;平局返回候选,交给用户选择。 */
  resolveTrigger(trigger: string): {
    trigger: string
    skill: string | null
    candidates: string[]
    reason: string
  } {
    const conflict = this.conflictList.find((item) => item.trigger === trigger)
    if (!conflict) {
      const only = this.list().filter((entry) => (entry.triggers ?? []).includes(trigger))
      if (only.length === 1) {
        return {
          trigger,
          skill: only[0]!.name,
          candidates: [only[0]!.name],
          reason: `只有 ${only[0]!.name} 声明了该触发域`
        }
      }
      return { trigger, skill: null, candidates: only.map((entry) => entry.name), reason: '没有技能声明该触发域' }
    }
    return {
      trigger,
      skill: conflict.winner,
      candidates: [...conflict.skills],
      reason: conflict.reason
    }
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
    this.activeChain = []
    this.allowedNames = null
  }

  /** 助理绑定的技能白名单:null 表示不限制(沿用全局索引)。 */
  setAllowed(names: string[] | null): void {
    this.allowedNames = names === null ? null : [...new Set(names.filter((name) => name.length > 0))]
  }

  async load(name: string): Promise<{
    name: string
    body: string
    allowedTools?: string[]
    loaded: string[]
    scripts?: string[]
  }> {
    if (this.disabledNames.has(name)) {
      throw new Error(`技能 ${name} 已关闭自动触发,请先在「专家·技能·连接器」中开启`)
    }
    const entry = this.find(name)
    if (!entry) {
      const available = this.entries.map((e) => e.name).join(', ') || '(无)'
      throw new Error(`未知技能: ${name}。可用技能: ${available}`)
    }

    const manifests = await this.loadClosure(entry)
    const root = manifests[manifests.length - 1]!
    const allowedTools = intersectAllowed(manifests)
    const scripts = [...new Set(manifests.flatMap((item) => item.scripts ?? []))].sort()
    const loaded = manifests.map((item) => item.name)

    const bodyParts = manifests.map((item) =>
      item.name === root.name ? item.body : `## 依赖技能 ${item.name}\n\n${item.body}`
    )
    let body = bodyParts.join('\n\n---\n\n')
    const bytes = Buffer.byteLength(body, 'utf8')
    let truncated = false
    if (bytes > MAX_INJECT_BYTES) {
      body = body.slice(0, MAX_INJECT_BYTES)
      truncated = true
    }

    this.active = {
      name: root.name,
      ...(allowedTools ? { allowedTools } : {}),
      ...(scripts.length > 0 ? { scripts } : {})
    }
    this.activeChain = loaded

    const toolsLine = allowedTools
      ? `\n\n[本技能链声明可用工具: ${allowedTools.join(', ')};与当前模式取交集后生效]`
      : '\n\n[本技能未声明 allowed-tools,不额外收窄工具集]'
    const chainLine =
      manifests.length > 1
        ? `\n\n[已加载依赖技能: ${manifests.slice(0, -1).map((item) => item.name).join(', ')}]`
        : ''
    const scriptsLine =
      scripts.length > 0
        ? `\n\n[可执行脚本: ${scripts.join(', ')};调用 run_skill_script(script, args) 在受限环境中运行]`
        : ''
    const footer = truncated
      ? `\n\n[已截断:原文 ${bytes} 字节,仅注入前 ${MAX_INJECT_BYTES} 字节]`
      : ''

    return {
      name: root.name,
      body: `[技能 ${root.name}]\n\n${body}${toolsLine}${chainLine}${scriptsLine}${footer}`,
      ...(allowedTools ? { allowedTools } : {}),
      loaded,
      ...(scripts.length > 0 ? { scripts } : {})
    }
  }

  /** 深度优先加载依赖,依赖在前、根技能在后;循环与缺失都在这里变成可操作错误。 */
  private async loadClosure(root: SkillIndexEntry): Promise<Array<Awaited<ReturnType<typeof loadSkill>>>> {
    const visiting: string[] = []
    const manifests: Array<Awaited<ReturnType<typeof loadSkill>>> = []
    const done = new Set<string>()

    const walk = async (entry: SkillIndexEntry, depth: number): Promise<void> => {
      if (depth > MAX_DEPENDENCY_DEPTH) {
        throw new Error(`技能依赖层级超过上限(${MAX_DEPENDENCY_DEPTH}): ${root.name}`)
      }
      if (visiting.includes(entry.name)) {
        throw new Error(`技能依赖形成循环: ${[...visiting, entry.name].join(' -> ')}`)
      }
      if (done.has(entry.name)) return
      if (this.disabledNames.has(entry.name)) {
        throw new Error(`技能 ${root.name} 依赖的技能 ${entry.name} 已关闭,请先在「专家·技能·连接器」中开启`)
      }

      visiting.push(entry.name)
      const missing: string[] = []
      for (const depName of entry.requires ?? []) {
        const dep = this.entries.find((item) => item.name === depName)
        if (!dep) {
          missing.push(depName)
          continue
        }
        await walk(dep, depth + 1)
      }
      visiting.pop()
      if (missing.length > 0) {
        throw new Error(
          `技能 ${entry.name} 缺少依赖 [${missing.join(', ')}]。请先把依赖技能目录放入技能目录,再刷新技能列表。`
        )
      }

      const manifest = await loadSkill(entry)
      manifests.push(manifest)
      done.add(entry.name)
    }

    await walk(root, 0)
    return manifests
  }

  /** 模式允许 ∩ 技能声明;技能未声明则不收窄 */
  narrow(modeAllowed: string[]): string[] {
    return narrowTools(modeAllowed, this.active?.allowedTools)
  }

  /** 工具执行前的第二道闸:技能声明了但没列出的工具一律拒绝 */
  assertAllowed(toolName: string): void {
    if (toolName === 'load_skill' || toolName === 'run_skill_script') return
    const allowed = this.active?.allowedTools
    if (!allowed) return
    if (!allowed.includes(toolName)) {
      throw new Error(`技能 ${this.active?.name} 只允许使用 [${allowed.join(', ')}],${toolName} 被拒绝`)
    }
  }

  /** 执行当前技能链声明的脚本;未激活技能或未声明的脚本一律拒绝。 */
  async runScript(
    script: string,
    args: string[],
    workspaceRoot: string,
    signal?: AbortSignal
  ): Promise<SkillScriptResult> {
    const active = this.active
    if (!active) throw new Error('当前没有激活的技能,不能执行技能脚本')
    if (!active.scripts?.includes(script)) {
      throw new Error(
        `技能 ${active.name} 未声明脚本 ${script};可用脚本: ${(active.scripts ?? []).join(', ') || '(无)'}`
      )
    }

    const owners = this.activeChain.filter((name) => {
      const entry = this.entries.find((item) => item.name === name)
      return entry?.scripts?.includes(script)
    })
    if (owners.length !== 1) {
      throw new Error(
        `脚本 ${script} 在技能链中有多个来源(${owners.join(', ') || '无'}),无法确定执行哪一个`
      )
    }
    const entry = this.entries.find((item) => item.name === owners[0]!)
    if (!entry) throw new Error(`技能 ${owners[0]} 已不存在`)
    const result = await runSkillScript(entry, { script, args, workspaceRoot, ...(signal ? { signal } : {}) })
    if (result.code !== 0) {
      throw new Error(
        `脚本 ${script} 退出码 ${result.code ?? 'null'}${result.stderr ? `: ${result.stderr.slice(0, 2000)}` : ''}`
      )
    }
    return result
  }
}

function intersectAllowed(manifests: Array<{ allowedTools?: string[] }>): string[] | undefined {
  const declared = manifests.filter((item) => item.allowedTools)
  if (declared.length === 0) return undefined
  return declared
    .map((item) => item.allowedTools!)
    .reduce((acc, list) => acc.filter((name) => list.includes(name)))
    .sort()
}

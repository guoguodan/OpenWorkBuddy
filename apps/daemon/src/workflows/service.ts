import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, resolve, sep } from 'node:path'
import type { AppDatabase } from '@openwb/storage'
import {
  appendEvent,
  claimAutomation,
  createAutomation,
  createConversation,
  createTask,
  deleteAutomation,
  dueAutomations,
  getAutomation,
  listAutomations,
  markAutomationResult,
  recordAutomationOutcome,
  skipAutomation,
  transitionTask,
  updateAutomation,
  getWorkspaceSettings,
  type AutomationRecord
} from '@openwb/storage'
import type { ArtifactDraft, ArtifactSink, ToolRegistry } from '@openwb/tools'
import {
  AutomationScheduler,
  FileRunStore,
  computeNextRun,
  loadWorkflows,
  planStartup,
  type AutomationRow,
  type LoadWorkflowsResult,
  type WorkflowEvent,
  type WorkflowManifest
} from '@openwb/workflow'
import { loadWorkflowById, newRunId, normalizeInputs, runWorkflow, workflowDirs } from './runtime.js'

export interface WorkflowServiceDeps {
  db: AppDatabase
  workspaceId: string
  workspaceRoot: string
  dataDir: string
  builtinDir: string
  registry: ToolRegistry
  emit: (event: Record<string, unknown> & { type: string }) => void
  runAutomationPrompt: (input: {
    conversationId: string
    prompt: string
    modeId: string
    automationId: string
    /** 第几次尝试,从 1 开始;重试不应重复写入同一条用户消息 */
    attempt: number
  }) => Promise<{ status: 'done' | 'failed' | 'interrupted'; message?: string }>
  /** 工作流里的工具步骤同样要过审批闸门:否则自动化会绕过计费/路径确认 */
  gateToolExecution: (input: {
    name: string
    args: Record<string, unknown>
    conversationId: string
    signal?: AbortSignal
  }) => Promise<unknown>
  log: (message: string) => void
  /** 交付物写入器:工作流输出要进 artifact 表,不能只留在 run.json 里 */
  artifactSinkFor?: (taskId: string, conversationId: string) => ArtifactSink
  /** 定时任务结果进入消息中心;失败不能影响调度状态落库 */
  onAutomationFinished?: (input: {
    id: string
    name: string
    status: string
    conversationId: string
    consecutiveFailures: number
    failureAlerted: boolean
    /** 本次刚好跨过阈值;同一段连续失败只会为 true 一次 */
    shouldAlert: boolean
    threshold: number
    attempts: number
    workflowId?: string
    runId?: string
    outputBindings?: Array<{ name: string; path: string }>
  }) => void
  /** 测试注入:重试退避 */
  sleep?: (ms: number) => Promise<void>
  /** 测试注入:模拟时钟 */
  now?: () => Date
}

export interface StartWorkflowInput {
  workflowId: string
  inputs: Record<string, unknown>
  runId?: string
  resume?: boolean
  conversationId: string
}

interface ActiveRun {
  controller: AbortController
  taskId: string
  execution: Promise<void>
}

interface SettledRun {
  status: 'done' | 'failed' | 'interrupted'
  outputBindings: Array<{ name: string; path: string }>
  error?: { code?: string; message: string }
}

function toSchedulerRow(row: AutomationRecord): AutomationRow {
  return {
    id: row.id,
    name: row.name,
    scheduleType: row.scheduleType,
    rrule: row.rrule,
    scheduledAt: row.scheduledAt,
    timezone: row.timezone,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    prompt: row.prompt,
    modeId: row.modeId,
    enabled: row.enabled,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    lastStatus: row.lastStatus
  }
}

/**
 * 工作流与自动化服务。
 *
 * daemon 的帧处理是串行队列:workflow.run 必须"启动后立刻返回",
 * 否则同一个进程里的 workflow.cancel 永远排在它后面,取消信号进不来。
 * 这里把执行放在后台 promise 中,队列只负责建任务、注册 controller 与回帧。
 */
export class WorkflowService {
  private readonly dirs
  private readonly runs = new Map<string, ActiveRun>()
  private readonly automationRuns = new Set<Promise<void>>()
  private readonly settled = new Map<string, SettledRun>()
  private readonly settleWaiters = new Map<string, Array<(value: SettledRun) => void>>()
  private readonly now: () => Date
  private readonly sleep: (ms: number) => Promise<void>
  private scheduler: AutomationScheduler | null = null
  private timer: NodeJS.Timeout | null = null
  private ticking = false

  constructor(private readonly deps: WorkflowServiceDeps) {
    this.dirs = workflowDirs(deps.workspaceRoot, deps.dataDir, deps.builtinDir)
    this.now = deps.now ?? (() => new Date())
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)))
  }

  async list(): Promise<{ workflows: Array<Record<string, unknown>>; issues: Array<{ path: string; reason: string }> }> {
    const result: LoadWorkflowsResult = await loadWorkflows(this.dirs)
    return {
      workflows: [...result.workflows.values()].map(({ manifest, source }) => ({
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        mode: manifest.mode,
        phases: manifest.phases.map((phase) => ({
          id: phase.id,
          title: phase.title ?? phase.id,
          parallel: phase.parallel,
          ...(phase.fanout ? { fanout: true } : {}),
          steps: phase.steps.length
        })),
        inputs: manifest.inputs,
        outputs: manifest.outputs,
        scope: source.scope,
        path: source.path
      })),
      issues: result.issues
    }
  }

  /**
   * 最近运行列表。
   *
   * 以磁盘 run.json 为准而不是内存表:重启后历史仍可见,且 UI 不需要读工作区文件。
   * running 状态若不在活动表里,说明上次进程退出时没有收尾。这里不篡改 run.json,
   * 只额外返回 active=false,由界面按“已中断”展示并允许续跑。
   */
  async listRuns(limit = 30): Promise<{ runs: Array<Record<string, unknown>>; active: string[] }> {
    const store = new FileRunStore(this.deps.workspaceRoot)
    let entries: string[] = []
    try {
      entries = await readdir(store.runDir, { withFileTypes: true }).then((list) =>
        list.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      )
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { runs: [], active: [] }
      throw err
    }
    const bounded = Math.max(1, Math.min(limit, 100))
    const records = await Promise.all(
      entries.map(async (runId) => {
        try {
          const record = await store.readRun(runId)
          return { ...record, active: this.runs.has(runId) }
        } catch {
          return null
        }
      })
    )
    const runs = records
      .filter((record): record is NonNullable<typeof record> => record !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, bounded)
    return { runs, active: this.activeRuns() }
  }

  /**
   * 启动一次运行;返回 runId/taskId 后立即返回,执行在后台继续。
   * 同一 runId 不允许并发执行:续跑必须等上一次真正结束。
   */
  async start(input: StartWorkflowInput): Promise<{ runId: string; taskId: string }> {
    const loaded = await loadWorkflowById(this.dirs, input.workflowId)
    const manifest = loaded.manifest
    const inputs = normalizeInputs(manifest, input.inputs)
    const runId = input.runId ?? newRunId(this.now())
    if (this.runs.has(runId)) throw new Error(`该运行仍在进行中,不能并发启动: ${runId}`)

    if (input.resume) {
      const store = new FileRunStore(this.deps.workspaceRoot)
      const prior = await store.readRun(runId).catch(() => null)
      if (!prior) throw new Error(`无法续跑:找不到运行记录 ${runId}`)
      if (prior.workflowId !== manifest.id) {
        throw new Error(`无法续跑:运行 ${runId} 属于 ${prior.workflowId},不是 ${manifest.id}`)
      }
    }

    const controller = new AbortController()
    const taskId = createTask(this.deps.db, {
      conversationId: input.conversationId,
      title: `工作流 ${manifest.name}`,
      ...(input.resume ? { phase: 'resume' } : {})
    })
    transitionTask(this.deps.db, taskId, 'running')

    // 先登记占位:execute 内部会在 first await 后继续,
    // 但注册必须在启动前完成,否则极短工作流可能先结束再被重新写回 runs。
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    this.runs.set(runId, { controller, taskId, execution: done })
    const execution = this.execute({
      manifest,
      inputs,
      runId,
      taskId,
      conversationId: input.conversationId,
      controller,
      resume: Boolean(input.resume)
    })
    void execution
      .catch((err) => {
        this.deps.log(`[workflow] 后台执行异常: ${(err as Error).message}`)
      })
      .finally(resolveDone)
    return { runId, taskId }
  }

  cancel(runId: string): boolean {
    const active = this.runs.get(runId)
    if (!active) return false
    active.controller.abort(new Error('用户取消'))
    return true
  }

  isRunning(runId: string): boolean {
    return this.runs.has(runId)
  }

  /**
   * 等待某次运行收尾。
   *
   * 自动化需要知道运行结果才能计数/重试,而 run 接口必须立刻返回给界面;
   * 结果先落内存表,极短运行在调用方开始等待前也能立刻拿到,不会卡死。
   */
  waitForRun(runId: string): Promise<SettledRun> {
    const done = this.settled.get(runId)
    if (done) return Promise.resolve(done)
    return new Promise<SettledRun>((resolveWait) => {
      const list = this.settleWaiters.get(runId) ?? []
      list.push(resolveWait)
      this.settleWaiters.set(runId, list)
    })
  }

  private settleRun(runId: string, value: SettledRun): void {
    this.settled.set(runId, value)
    const waiters = this.settleWaiters.get(runId)
    if (waiters) {
      this.settleWaiters.delete(runId)
      for (const waiter of waiters) waiter(value)
    }
    // 自动化历史很长时不能让结果表无限增长;只保留最近 100 次查询窗口。
    while (this.settled.size > 100) {
      const oldest = this.settled.keys().next().value
      if (oldest === undefined) break
      this.settled.delete(oldest)
    }
  }

  activeRuns(): string[] {
    return [...this.runs.keys()]
  }

  /**
   * 关闭前收尾:取消仍在跑的工作流并等待其落盘,避免 stdin 关闭后
   * 先关数据库、后台任务再写库导致 "database connection is not open"。
   */
  async shutdown(): Promise<void> {
    this.stopScheduler()
    const active = [...this.runs.values()]
    for (const run of active) {
      if (!run.controller.signal.aborted) run.controller.abort(new Error('daemon 关闭'))
    }
    await Promise.allSettled([
      ...active.map((run) => run.execution),
      ...this.automationRuns
    ])
  }

  /** 续跑:以磁盘上的 run.json 为准,不允许调用方另传 inputs 篡改历史 */
  async resume(runId: string, conversationId: string): Promise<{ runId: string; taskId: string }> {
    const store = new FileRunStore(this.deps.workspaceRoot)
    const prior = await store.readRun(runId)
    return await this.start({
      workflowId: prior.workflowId,
      inputs: prior.inputs,
      runId,
      resume: true,
      conversationId
    })
  }

  private emit(event: Record<string, unknown> & { type: string }): void {
    this.deps.emit(event)
  }

  private async execute(input: {
    manifest: WorkflowManifest
    inputs: Record<string, unknown>
    runId: string
    taskId: string
    conversationId: string
    controller: AbortController
    resume: boolean
  }): Promise<void> {
    const { db } = this.deps
    const { manifest, runId, taskId, conversationId } = input
    const phaseTasks = new Map<string, string>()

    const onEvent = (event: WorkflowEvent) => {
      try {
        if (event.type === 'workflow.phase') {
          if (event.status === 'started') {
            const childId = createTask(db, {
              conversationId,
              parentId: taskId,
              title: `阶段 ${event.phaseId}`,
              phase: event.phaseId
            })
            transitionTask(db, childId, 'running')
            phaseTasks.set(event.phaseId, childId)
          }
          if (event.status === 'done') {
            const childId = phaseTasks.get(event.phaseId)
            if (childId) {
              try {
                transitionTask(db, childId, 'done', {
                  resultRef: `.openwb/runs/${runId}/${event.phaseId}.json`
                })
              } catch (err) {
                this.deps.log(`[workflow] phase task 迁移失败: ${(err as Error).message}`)
              }
            }
          }
          if (event.status === 'failed') {
            const childId = phaseTasks.get(event.phaseId)
            if (childId) {
              try {
                // 用户取消时子任务应标记 interrupted,否则界面会显示成"代码失败"
                if (input.controller.signal.aborted) transitionTask(db, childId, 'interrupted')
                else transitionTask(db, childId, 'failed', { errorCode: 'PHASE_FAILED' })
              } catch (err) {
                this.deps.log(`[workflow] phase task 失败迁移异常: ${(err as Error).message}`)
              }
            }
          }
        }
        this.emit({ ...event })
      } catch (err) {
        // 事件回填失败不能打断工作流本身
        this.deps.log(`[workflow] 事件处理失败: ${(err as Error).message}`)
      }
    }

    try {
      const { outcome } = await runWorkflow({
        manifest,
        runId,
        modelName: getWorkspaceSettings(this.deps.db, this.deps.workspaceId).model,
        inputs: input.inputs,
        workspaceRoot: this.deps.workspaceRoot,
        registry: this.deps.registry,
        executeTool: this.deps.gateToolExecution,
        signal: input.controller.signal,
        resume: input.resume,
        conversationId,
        onEvent,
        log: this.deps.log
      })

      const finalStatus =
        outcome.status === 'done' ? 'done' : outcome.status === 'interrupted' ? 'interrupted' : 'failed'
      try {
        transitionTask(db, taskId, finalStatus, {
          ...(outcome.error ? { errorCode: outcome.error.code } : {})
        })
      } catch (err) {
        this.deps.log(`[workflow] 根任务状态迁移失败: ${(err as Error).message}`)
      }
      appendEvent(db, conversationId, `workflow.${finalStatus}`, {
        runId,
        workflowId: manifest.id,
        modelCalls: outcome.modelCalls,
        outputs: outcome.outputBindings
      })
      if (outcome.status === 'done' && outcome.outputBindings.length > 0) {
        await this.deliverOutputs({
          taskId,
          conversationId,
          workflowName: manifest.name,
          bindings: outcome.outputBindings
        })
      }
      this.settleRun(runId, {
        status: finalStatus,
        outputBindings: outcome.outputBindings,
        ...(outcome.error ? { error: outcome.error } : {})
      })
      this.emit({
        type: 'workflow.settled',
        runId,
        taskId,
        status: finalStatus,
        modelCalls: outcome.modelCalls,
        outputBindings: outcome.outputBindings,
        ...(outcome.error ? { error: outcome.error } : {})
      })
    } catch (err) {
      // 校验/落盘等引擎外层异常:任务必须落到终态,不能永久 running
      try {
        transitionTask(db, taskId, input.controller.signal.aborted ? 'interrupted' : 'failed', {
          errorCode: 'WORKFLOW_FAILED'
        })
      } catch {
        // 已经是终态则忽略
      }
      const failedStatus = input.controller.signal.aborted ? 'interrupted' : 'failed'
      this.settleRun(runId, {
        status: failedStatus,
        outputBindings: [],
        error: { message: (err as Error).message }
      })
      this.emit({
        type: 'workflow.settled',
        runId,
        taskId,
        status: failedStatus,
        error: { message: (err as Error).message }
      })
    } finally {
      this.runs.delete(runId)
    }
  }

  /**
   * 把工作流声明的文件输出写进 artifact 表。
   *
   * 文件已由引擎写入工作区,这里只做校验/哈希与交付留痕;任何单个文件
   * 读不到都不能把已完成的运行改判失败,否则用户会看到"跑完了但没有结果"。
   */
  private async deliverOutputs(input: {
    taskId: string
    conversationId: string
    workflowName: string
    bindings: Array<{ name: string; path: string }>
  }): Promise<void> {
    const sink = this.deps.artifactSinkFor?.(input.taskId, input.conversationId)
    if (!sink) return
    const drafts: ArtifactDraft[] = []
    for (const binding of input.bindings) {
      try {
        const abs = resolve(this.deps.workspaceRoot, binding.path)
        if (abs !== this.deps.workspaceRoot && !abs.startsWith(`${this.deps.workspaceRoot}${sep}`)) {
          this.deps.log(`[workflow] 产物路径越界,已跳过: ${binding.path}`)
          continue
        }
        const info = await stat(abs)
        if (!info.isFile()) continue
        const sha256 = createHash('sha256').update(await readFile(abs)).digest('hex')
        const lower = binding.path.toLowerCase()
        const kind: ArtifactDraft['kind'] = /\.html?$/.test(lower)
          ? 'html'
          : /\.(png|jpe?g|gif|webp|svg)$/.test(lower)
            ? 'image'
            : 'file'
        drafts.push({
          kind,
          title: `${input.workflowName} · ${basename(binding.path) || binding.name}`,
          description: `工作流产物 ${binding.name}`,
          path: binding.path,
          size: info.size,
          sha256
        })
      } catch (err) {
        this.deps.log(`[workflow] 产物读取失败 ${binding.path}: ${(err as Error).message}`)
      }
    }
    if (drafts.length === 0) return
    try {
      await sink.insert(drafts)
    } catch (err) {
      this.deps.log(`[workflow] 产物写入失败: ${(err as Error).message}`)
    }
  }

  // ---------------- 自动化 ----------------

  listAutomations(): AutomationRecord[] {
    return listAutomations(this.deps.db, this.deps.workspaceId)
  }

  createAutomation(input: Parameters<typeof createAutomation>[1]): AutomationRecord {
    // 建任务时就要有下一次时间,否则要等下次 daemon 启动才会被排上
    let nextRunAt = input.nextRunAt ?? null
    if (nextRunAt === null) {
      if (input.scheduleType === 'once') {
        nextRunAt = input.scheduledAt ?? null
      } else {
        nextRunAt = computeNextRun({
          scheduleType: 'rrule',
          rule: input.rrule ?? null,
          timezone: input.timezone ?? 'Asia/Shanghai',
          validUntil: input.validUntil ?? null,
          after: this.now()
        })
      }
    }
    return createAutomation(this.deps.db, { ...input, nextRunAt })
  }

  updateAutomation(id: string, patch: Parameters<typeof updateAutomation>[2]): void {
    updateAutomation(this.deps.db, id, patch)
  }

  deleteAutomation(id: string): void {
    deleteAutomation(this.deps.db, id)
  }

  /**
   * 启动补跑 + 周期扫描。
   * intervalMs 可被 OPENWB_AUTOMATION_INTERVAL_MS 覆盖(验收脚本用 50ms 加速)。
   */
  startScheduler(intervalMs = Number(process.env.OPENWB_AUTOMATION_INTERVAL_MS ?? 30_000)): void {
    if (this.timer) return
    this.ensureScheduler()
    void this.startupCatchUp()
    this.timer = setInterval(() => void this.tick(), Math.max(20, intervalMs))
    this.timer.unref?.()
  }

  private ensureScheduler(): AutomationScheduler {
    if (this.scheduler) return this.scheduler
    this.scheduler = new AutomationScheduler(
      {
        claim: (input) =>
          claimAutomation(this.deps.db, {
            id: input.id,
            expectedNextRunAt: input.expectedNextRunAt,
            now: input.now.toISOString(),
            nextRunAt: input.nextRunAt
          }).claimed,
        markResult: (id, status, nextRunAt) => {
          markAutomationResult(this.deps.db, id, { status, nextRunAt })
        }
      },
      this.now
    )
    return this.scheduler
  }

  stopScheduler(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 验收脚本用:手动推进一次扫描(可带模拟 now 由构造参数注入) */
  async tick(nowIso?: string): Promise<string[]> {
    if (this.ticking) return []
    this.ticking = true
    try {
      const scheduler = this.ensureScheduler()
      const now = nowIso ? new Date(nowIso) : this.now()
      const rows = dueAutomations(this.deps.db, this.deps.workspaceId, now.toISOString())
      const claimed = scheduler.due(rows.map(toSchedulerRow), { now })
      for (const row of claimed) {
        // 抢占时 next_run_at 已推进;执行失败也不阻塞下一轮
        this.launchAutomation(row.id, row, now)
      }
      return claimed.map((row) => row.id)
    } finally {
      this.ticking = false
    }
  }

  /** 验收入口:可以用模拟时钟跑一次启动补跑 + 到期扫描 */
  async scan(nowIso?: string, options: { startup?: boolean } = {}): Promise<string[]> {
    const now = nowIso ? new Date(nowIso) : this.now()
    this.ensureScheduler()
    const startupClaimed = options.startup ? await this.startupCatchUp(now) : []
    const tickClaimed = await this.tick(now.toISOString())
    // 补跑与普通扫描可能都触及同一任务,返回值必须去重
    return [...new Set([...startupClaimed, ...tickClaimed])]
  }

  private async startupCatchUp(now: Date = this.now()): Promise<string[]> {
    const claimedIds: string[] = []
    for (const record of this.listAutomations()) {
      if (!record.enabled) continue
      const row = toSchedulerRow(record)
      let action
      try {
        action = planStartup(row, now)
      } catch (err) {
        this.deps.log(`[automation] ${record.name} 计划失败: ${(err as Error).message}`)
        updateAutomation(this.deps.db, record.id, { lastStatus: `invalid:${(err as Error).message}`.slice(0, 200) })
        continue
      }
      if (action.kind === 'reschedule') {
        updateAutomation(this.deps.db, record.id, { nextRunAt: action.nextRunAt })
        continue
      }
      if (action.kind === 'skipped') {
        skipAutomation(this.deps.db, record.id, {
          now: now.toISOString(),
          nextRunAt: action.nextRunAt,
          skipped: action.missed
        })
        this.emit({ type: 'automation.skipped', id: record.id, skipped: action.missed, nextRunAt: action.nextRunAt })
        continue
      }
      if (action.kind === 'run_now') {
        // 补跑必须也走抢占,避免两个 daemon 同时补跑
        const claimed = claimAutomation(this.deps.db, {
          id: record.id,
          expectedNextRunAt: record.nextRunAt,
          now: now.toISOString(),
          nextRunAt: action.nextRunAt
        })
        if (claimed.claimed) {
          claimedIds.push(record.id)
          this.launchAutomation(record.id, row, now)
        }
      }
    }
    return claimedIds
  }

  /** 自动化执行不在请求队列里,仍需登记 promise 以便关闭时等待 */
  private launchAutomation(id: string, row: AutomationRow, startedAt: Date): void {
    const task: Promise<void> = this.runAutomation(id, row, startedAt)
      .catch((err) => {
        this.deps.log(`[automation] 后台执行异常: ${(err as Error).message}`)
      })
      .finally(() => {
        this.automationRuns.delete(task)
      })
    this.automationRuns.add(task)
  }

  private async runAutomation(id: string, row: AutomationRow, startedAt: Date): Promise<void> {
    const record = getAutomation(this.deps.db, id)
    if (!record) return
    // WM-AUTO-03:自包含,新建独立会话,不读历史
    const conversation = createConversation(this.deps.db, {
      workspaceId: this.deps.workspaceId,
      title: `自动化: ${record.name}`,
      modeId: record.modeId
    })
    this.emit({
      type: 'automation.started',
      id,
      name: record.name,
      conversationId: conversation.id,
      ...(record.workflowId ? { workflowId: record.workflowId } : {})
    })
    const execution = await this.executeAutomation(record, conversation.id)
    const status = execution.status

    const nextRunAt =
      record.scheduleType === 'once'
        ? null
        : computeNextRun({
            scheduleType: 'rrule',
            rule: record.rrule,
            timezone: record.timezone,
            validUntil: record.validUntil,
            after: startedAt
          })
    const outcome = recordAutomationOutcome(this.deps.db, id, {
      status,
      outcome: status === 'done' ? 'done' : status === 'interrupted' ? 'interrupted' : 'failed',
      nextRunAt,
      ...(record.scheduleType === 'once' ? { disable: true } : {}),
      now: startedAt.toISOString()
    })
    try {
      this.deps.onAutomationFinished?.({
        id,
        name: record.name,
        status,
        conversationId: conversation.id,
        consecutiveFailures: outcome.consecutiveFailures,
        failureAlerted: outcome.failureAlerted,
        shouldAlert: outcome.shouldAlert,
        threshold: record.failureThreshold,
        attempts: execution.attempts,
        ...(record.workflowId ? { workflowId: record.workflowId } : {}),
        ...(execution.runId ? { runId: execution.runId } : {}),
        ...(execution.outputBindings ? { outputBindings: execution.outputBindings } : {})
      })
    } catch (err) {
      this.deps.log(`[automation] 消息通知写入失败: ${(err as Error).message}`)
    }
    this.emit({
      type: 'automation.finished',
      id,
      status,
      nextRunAt,
      attempts: execution.attempts,
      consecutiveFailures: outcome.consecutiveFailures,
      failureAlerted: outcome.failureAlerted,
      shouldAlert: outcome.shouldAlert,
      ...(execution.runId ? { runId: execution.runId } : {}),
      ...(execution.outputBindings ? { outputBindings: execution.outputBindings } : {})
    })
  }

  /**
   * 一次自动化执行 = 至多 maxAttempts 次尝试。
   *
   * interrupted 是用户/进程主动停止,不重试也不计失败;只有 exhausted 才计一次
   * "连续失败",否则内部重试会让阈值计数虚高。
   */
  private async executeAutomation(
    record: AutomationRecord,
    conversationId: string
  ): Promise<{
    status: 'done' | 'failed' | 'interrupted'
    attempts: number
    runId?: string
    outputBindings?: Array<{ name: string; path: string }>
  }> {
    const maxAttempts = Math.min(5, Math.max(1, record.maxAttempts))
    const baseDelayRaw = Number(process.env.OPENWB_AUTOMATION_RETRY_BASE_MS ?? 500)
    const baseDelay = Number.isFinite(baseDelayRaw) && baseDelayRaw >= 0 ? baseDelayRaw : 500
    let runId: string | undefined
    let outputBindings: Array<{ name: string; path: string }> | undefined

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let status: 'done' | 'failed' | 'interrupted' = 'failed'
      let message: string | undefined
      try {
        if (record.workflowId) {
          const started = await this.start({
            workflowId: record.workflowId,
            inputs: record.workflowInputs ?? {},
            conversationId,
            ...(runId ? { runId, resume: true } : {})
          })
          runId = started.runId
          const settled = await this.waitForRun(started.runId)
          status = settled.status
          outputBindings = settled.outputBindings
          message = settled.error?.message
        } else {
          const result = await this.deps.runAutomationPrompt({
            conversationId,
            prompt: record.prompt,
            modeId: record.modeId,
            automationId: record.id,
            attempt
          })
          status = result.status
          message = result.message
        }
      } catch (err) {
        message = (err as Error).message
        status = 'failed'
      }
      if (status === 'done' || status === 'interrupted') {
        return { status, attempts: attempt, ...(runId ? { runId } : {}), ...(outputBindings ? { outputBindings } : {}) }
      }
      this.deps.log(
        `[automation] ${record.name} 第 ${attempt}/${maxAttempts} 次失败${message ? `: ${message}` : ''}`
      )
      if (attempt < maxAttempts && baseDelay > 0) {
        await this.sleep(Math.min(30_000, baseDelay * 2 ** (attempt - 1)))
      }
    }
    return { status: 'failed', attempts: maxAttempts, ...(runId ? { runId } : {}), ...(outputBindings ? { outputBindings } : {}) }
  }
}

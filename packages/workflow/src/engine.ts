import { evaluate, evaluateValue, type Scope } from './expr.js'
import { extractJson, validateJsonSchema } from './json.js'
import type { WorkflowManifest, WorkflowPhase, WorkflowStep } from './manifest.js'
import type { FileRunStore, PhaseRecord, RunRecord } from './store.js'
import { resolveOutputPath } from './store.js'

export type StepErrorCode =
  | 'STEP_FAILED'
  | 'STEP_OUTPUT_INVALID'
  | 'STEP_MISSING_TOOL'
  | 'STEP_TIMEOUT'
  | 'WORKFLOW_CANCELLED'
  | 'WORKFLOW_TIMEOUT'
  | 'LIMIT_EXCEEDED'

export class WorkflowRunError extends Error {
  constructor(
    readonly code: StepErrorCode,
    message: string,
    readonly phaseId?: string,
    readonly stepId?: string
  ) {
    super(message)
    this.name = 'WorkflowRunError'
  }
}

export interface PromptRequest {
  prompt: string
  output: 'text' | 'json' | 'markdown'
  schema?: unknown
  phaseId: string
  stepId: string
  signal: AbortSignal
  /** 校验失败后的重试会带上一次的错误信息 */
  repair?: string
}

export interface WorkflowToolContext {
  workspaceRoot: string
  signal: AbortSignal
  phaseId: string
  stepId: string
  /** 宿主会话;工作流工具审批的记忆与审计都按会话归属 */
  conversationId?: string
}

export type PromptFn = (request: PromptRequest) => Promise<string>
export type ToolFn = (name: string, args: Record<string, unknown>, ctx: WorkflowToolContext) => Promise<unknown>

export interface EngineHooks {
  prompt: PromptFn
  tool: ToolFn
  store: FileRunStore
  onEvent?: (event: WorkflowEvent) => void
  now?: () => Date
  /** 测试用:把 sleep 换成可控实现 */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

export type WorkflowEvent =
  | { type: 'workflow.started'; runId: string; workflowId: string }
  | { type: 'workflow.phase'; runId: string; phaseId: string; status: 'started' | 'done' | 'failed' }
  | {
      type: 'workflow.step'
      runId: string
      phaseId: string
      stepId: string
      status: 'started' | 'done' | 'retry' | 'failed'
      attempt: number
      message?: string
    }
  | { type: 'workflow.delta'; runId: string; phaseId: string; stepId: string; text: string }
  | { type: 'workflow.output'; runId: string; name: string; path?: string }
  | {
      type: 'workflow.finished'
      runId: string
      status: 'done' | 'failed' | 'interrupted'
      errorCode?: string
      message?: string
    }

export interface RunOptions {
  runId: string
  inputs: Record<string, unknown>
  workspaceRoot: string
  conversationId?: string
  signal?: AbortSignal
  /** 续跑时读取已落盘的 phase 结果,跳过它们 */
  resume?: boolean
  concurrency?: number
}

export interface RunOutcome {
  runId: string
  status: 'done' | 'failed' | 'interrupted'
  outputs: Record<string, unknown>
  modelCalls: number
  outputBindings: Array<{ name: string; path: string }>
  error?: { code: StepErrorCode; message: string; phaseId?: string; stepId?: string }
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason
  if (reason instanceof Error) return reason
  return new Error('已取消')
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal)
}

function isAbort(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  if (!(err instanceof Error)) return false
  if (err instanceof WorkflowRunError && err.code !== 'WORKFLOW_CANCELLED') return false
  return err.name === 'AbortError' || /abort|取消/i.test(err.message)
}

function validateOutput(value: unknown, schema: unknown): string[] {
  return validateJsonSchema(value, schema).map((issue) => `${issue.path}: ${issue.message}`)
}

/** 并发上限 4;单个任务失败不取消兄弟任务,但要保留已完成结果并把首个错误抛出去 */
async function runLimited<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let cursor = 0
  const errors: unknown[] = []
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      try {
        await worker(items[index]!, index)
      } catch (err) {
        errors.push(err)
      }
    }
  })
  await Promise.all(runners)
  if (errors.length > 0) throw errors[0]
}

function buildScope(base: Scope, steps: Record<string, unknown>, item: unknown, hasItem: boolean): Scope {
  return { ...base, steps, ...(hasItem ? { item } : {}) }
}

export class WorkflowEngine {
  private readonly now: () => Date
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>

  constructor(
    private readonly manifest: WorkflowManifest,
    private readonly hooks: EngineHooks
  ) {
    this.now = hooks.now ?? (() => new Date())
    this.sleep = hooks.sleep ?? defaultSleep
  }

  private emit(event: WorkflowEvent, runId: string): void {
    this.hooks.onEvent?.({ ...event, runId } as WorkflowEvent)
  }

  async run(options: RunOptions): Promise<RunOutcome> {
    const { manifest } = this
    const controller = new AbortController()
    const external = options.signal
    const onExternalAbort = () => controller.abort(external?.reason ?? new Error('已取消'))
    if (external) {
      if (external.aborted) controller.abort(external.reason ?? new Error('已取消'))
      else external.addEventListener('abort', onExternalAbort, { once: true })
    }

    const signal = controller.signal
    const timeout = setTimeout(() => {
      controller.abort(new WorkflowRunError('WORKFLOW_TIMEOUT', `工作流超过 ${manifest.limits.maxDurationSec}s 上限`))
    }, manifest.limits.maxDurationSec * 1000)

    const startedAt = this.now().toISOString()
    const stepsOutputs: Record<string, unknown> = {}
    const completedPhases: string[] = []
    let modelCalls = 0
    let status: RunOutcome['status'] | 'running' = 'running'
    let error: RunOutcome['error']

    const prior = options.resume ? await this.hooks.store.readRun(options.runId).catch(() => null) : null
    if (prior) {
      modelCalls = prior.modelCalls
      completedPhases.push(...prior.completedPhases)
    }
    const record: RunRecord = {
      runId: options.runId,
      workflowId: manifest.id,
      inputs: options.inputs,
      status: 'running',
      createdAt: prior?.createdAt ?? startedAt,
      updatedAt: startedAt,
      completedPhases,
      modelCalls
    }

    await this.hooks.store.init(record)
    this.emit({ type: 'workflow.started', runId: options.runId, workflowId: manifest.id }, options.runId)

    // steps 常驻于 scope:首个 phase 之前它为空对象,后续 phase 直接读累积结果,
    // 避免表达式在"尚未用到 steps"和"已经有了"之间出现两套行为。
    const baseScope: Scope = {
      inputs: options.inputs,
      run: { id: options.runId },
      workflow: { id: manifest.id, name: manifest.name },
      steps: {}
    }

    try {
      if (options.resume) {
        for (const phase of manifest.phases) {
          const saved = await this.hooks.store.readPhase(options.runId, phase.id)
          if (!saved || saved.status !== 'done') continue
          Object.assign(stepsOutputs, saved.outputs)
          if (!completedPhases.includes(phase.id)) completedPhases.push(phase.id)
        }
      }

      for (const phase of manifest.phases) {
        throwIfAborted(signal)
        if (completedPhases.includes(phase.id)) continue
        if (modelCalls >= manifest.limits.maxModelCalls) {
          throw new WorkflowRunError('LIMIT_EXCEEDED', `模型调用超过上限 ${manifest.limits.maxModelCalls}`, phase.id)
        }
        record.currentPhase = phase.id
        record.updatedAt = this.now().toISOString()
        await this.hooks.store.writeRun(record)
        this.emit({ type: 'workflow.phase', runId: options.runId, phaseId: phase.id, status: 'started' }, options.runId)

        const phaseStartedAt = this.now().toISOString()
        try {
          // phase 之间必须看到同一份累积结果;每次传入新对象,表达式永远不会读到上一次的快照
          const phaseScope: Scope = { ...baseScope, steps: stepsOutputs }
          const produced = await this.runPhase(phase, options, phaseScope, stepsOutputs, signal, (delta) => {
            modelCalls += delta
            record.modelCalls = modelCalls
          })
          Object.assign(stepsOutputs, produced)
          completedPhases.push(phase.id)
          record.completedPhases = completedPhases
          record.modelCalls = modelCalls
          record.updatedAt = this.now().toISOString()
          delete record.currentPhase
          const phaseRecord: PhaseRecord = {
            phaseId: phase.id,
            workflowId: manifest.id,
            status: 'done',
            startedAt: phaseStartedAt,
            finishedAt: this.now().toISOString(),
            outputs: produced
          }
          await this.hooks.store.writePhase(options.runId, phaseRecord)
          await this.hooks.store.writeRun(record)
          this.emit({ type: 'workflow.phase', runId: options.runId, phaseId: phase.id, status: 'done' }, options.runId)
        } catch (err) {
          // 并行/扇出部分成功的结果要保留:失败前把已产出的结果合进来
          const partial = (err as { partialOutputs?: Record<string, unknown> }).partialOutputs
          const aborted = isAbort(err, signal)
          const timeoutError = controller.signal.reason
          const code: StepErrorCode =
            err instanceof WorkflowRunError
              ? err.code
              : aborted && timeoutError instanceof WorkflowRunError
                ? timeoutError.code
                : aborted
                  ? 'WORKFLOW_CANCELLED'
                  : 'STEP_FAILED'
          const message = err instanceof Error ? err.message : String(err)
          status = aborted ? 'interrupted' : 'failed'
          error = { code, message, phaseId: phase.id }
          const phaseRecord: PhaseRecord = {
            phaseId: phase.id,
            workflowId: manifest.id,
            status: aborted ? 'interrupted' : 'failed',
            startedAt: phaseStartedAt,
            finishedAt: this.now().toISOString(),
            outputs: { ...(partial ?? {}) }
          }
          await this.hooks.store.writePhase(options.runId, phaseRecord)
          this.emit(
            { type: 'workflow.phase', runId: options.runId, phaseId: phase.id, status: 'failed' },
            options.runId
          )
          break
        }
      }
      if (status === 'running') status = 'done'
    } catch (err) {
      if (isAbort(err, signal)) {
        status = 'interrupted'
        const reason = controller.signal.reason
        error = {
          code: reason instanceof WorkflowRunError ? reason.code : 'WORKFLOW_CANCELLED',
          message: err instanceof Error ? err.message : String(err)
        }
      } else {
        status = 'failed'
        error = {
          code: err instanceof WorkflowRunError ? err.code : 'STEP_FAILED',
          message: err instanceof Error ? err.message : String(err)
        }
      }
    } finally {
      clearTimeout(timeout)
      external?.removeEventListener('abort', onExternalAbort)
    }

    let outputBindings: Array<{ name: string; path: string }> = []
    if (status === 'done') {
      try {
        outputBindings = await this.writeOutputs(options, baseScope, stepsOutputs)
      } catch (err) {
        status = 'failed'
        error = { code: 'STEP_FAILED', message: `写输出失败: ${(err as Error).message}` }
      }
    }

    record.status = status
    record.updatedAt = this.now().toISOString()
    record.modelCalls = modelCalls
    record.completedPhases = completedPhases
    if (error) {
      record.errorCode = error.code
      record.errorMessage = error.message
    }
    await this.hooks.store.writeRun(record)
    this.emit(
      {
        type: 'workflow.finished',
        runId: options.runId,
        status,
        ...(error ? { errorCode: error.code, message: error.message } : {})
      },
      options.runId
    )

    return {
      runId: options.runId,
      status,
      outputs: stepsOutputs,
      modelCalls,
      outputBindings,
      ...(error ? { error } : {})
    }
  }

  private async runPhase(
    phase: WorkflowPhase,
    options: RunOptions,
    baseScope: Scope,
    steps: Record<string, unknown>,
    signal: AbortSignal,
    addModelCall: (delta: number) => void
  ): Promise<Record<string, unknown>> {
    throwIfAborted(signal)
    if (!phase.fanout) {
      return await this.runSteps(
        phase,
        baseScope,
        signal,
        addModelCall,
        options.runId,
        options.workspaceRoot,
        options.conversationId
      )
    }

    const raw = phase.fanout.trim()
    const expr = raw.startsWith('{{') && raw.endsWith('}}') ? raw.slice(2, -2) : raw
    const value = evaluate(expr, buildScope(baseScope, steps, undefined, false))
    if (!Array.isArray(value)) {
      throw new WorkflowRunError('STEP_FAILED', `phase ${phase.id} 的 fanout 结果不是数组`, phase.id)
    }
    const outputs: Record<string, unknown> = {}
    const worker = async (item: unknown) => {
      throwIfAborted(signal)
      const scope = buildScope(baseScope, steps, item, true)
      // parallel 描述的是扇出项之间的并发;单个 item 内部的步骤仍需顺序执行,
      // 例如 code-review 必须先 read_one 再 review_one。
      const produced = await this.runSteps(
        { ...phase, parallel: false },
        scope,
        signal,
        addModelCall,
        options.runId,
        options.workspaceRoot,
        options.conversationId
      )
      for (const [key, val] of Object.entries(produced)) {
        const merged = outputs[key]
        outputs[key] = merged === undefined ? [val] : Array.isArray(merged) ? [...merged, val] : [merged, val]
      }
    }
    try {
      if (phase.parallel) await runLimited(value, options.concurrency ?? 4, worker)
      else for (const item of value) await worker(item)
    } catch (err) {
      throw attachPartial(err, outputs)
    }
    return outputs
  }

  private async runSteps(
    phase: WorkflowPhase,
    scope: Scope,
    signal: AbortSignal,
    addModelCall: (delta: number) => void,
    runId: string,
    workspaceRoot: string,
    conversationId?: string
  ): Promise<Record<string, unknown>> {
    const outputs: Record<string, unknown> = {}
    const local: Scope = { ...scope }
    const worker = async (step: WorkflowStep) => {
      throwIfAborted(signal)
      const result = await this.runStep(
        phase,
        step,
        local,
        signal,
        addModelCall,
        runId,
        workspaceRoot,
        conversationId
      )
      if (step.save_as) {
        const merged = { ...(local.steps as Record<string, unknown>), [step.save_as]: result }
        local.steps = merged
        outputs[step.save_as] = result
      }
    }
    if (phase.parallel) {
      try {
        await runLimited(phase.steps, 4, worker)
      } catch (err) {
        throw attachPartial(err, outputs)
      }
    } else {
      for (const step of phase.steps) await worker(step)
    }
    return outputs
  }

  private async runStep(
    phase: WorkflowPhase,
    step: WorkflowStep,
    scope: Scope,
    signal: AbortSignal,
    addModelCall: (delta: number) => void,
    runId: string,
    workspaceRoot: string,
    conversationId?: string
  ): Promise<unknown> {
    const retry = step.retry ?? { maxAttempts: 1, backoffMs: 0 }
    // 结构化输出失败必须至少再给一次机会(WM: 非法 JSON 重试 1 次),
    // 与工具类 step 的 retry 配置互相独立。
    const maxAttempts = step.output === 'json' ? Math.max(retry.maxAttempts, 2) : retry.maxAttempts
    let attempt = 0
    let repair: string | undefined
    while (true) {
      attempt += 1
      throwIfAborted(signal)
      this.emit(
        {
          type: 'workflow.step',
          runId,
          phaseId: phase.id,
          stepId: step.id,
          status: attempt === 1 ? 'started' : 'retry',
          attempt
        },
        runId
      )
      try {
        if (step.type === 'prompt') {
          addModelCall(1)
          const text = await this.invokePrompt(step, scope, signal, phase.id, repair)
          return await this.coerceOutput(step, text)
        }
        const toolName = step.tool!
        const args = (step.args ? evaluateValue(step.args, scope) : {}) as Record<string, unknown>
        const result = await this.hooks.tool(toolName, args, {
          workspaceRoot,
          signal,
          phaseId: phase.id,
          stepId: step.id,
          ...(conversationId ? { conversationId } : {})
        })
        if (step.output === 'json') {
          if (typeof result === 'string') return await this.coerceOutput(step, result)
          const issues = validateOutput(result, step.schema)
          if (issues.length > 0) {
            throw new WorkflowRunError('STEP_OUTPUT_INVALID', `JSON 校验失败: ${issues.join('; ')}`, phase.id, step.id)
          }
        }
        return result
      } catch (err) {
        if (isAbort(err, signal)) throw err
        if (attempt >= maxAttempts) {
          this.emit(
            {
              type: 'workflow.step',
              runId,
              phaseId: phase.id,
              stepId: step.id,
              status: 'failed',
              attempt,
              message: (err as Error).message
            },
            runId
          )
          if (err instanceof WorkflowRunError) throw err
          throw new WorkflowRunError('STEP_FAILED', `step ${step.id} 失败: ${(err as Error).message}`, phase.id, step.id)
        }
        repair = step.type === 'prompt' ? (err as Error).message : undefined
        if (retry.backoffMs > 0) await this.sleep(retry.backoffMs, signal)
      }
    }
  }

  private async invokePrompt(
    step: WorkflowStep,
    scope: Scope,
    signal: AbortSignal,
    phaseId: string,
    repair?: string
  ): Promise<string> {
    const prompt = evaluateValue(step.prompt ?? '', scope) as string
    return await this.hooks.prompt({
      prompt,
      output: step.output,
      ...(step.schema ? { schema: step.schema } : {}),
      phaseId,
      stepId: step.id,
      signal,
      ...(repair ? { repair } : {})
    })
  }

  private async coerceOutput(step: WorkflowStep, text: string): Promise<unknown> {
    if (step.output !== 'json') return text
    try {
      const value = extractJson(text)
      const issues = validateOutput(value, step.schema)
      if (issues.length > 0) {
        throw new WorkflowRunError('STEP_OUTPUT_INVALID', `JSON 校验失败: ${issues.join('; ')}`)
      }
      return value
    } catch (err) {
      if (err instanceof WorkflowRunError) throw err
      throw new WorkflowRunError('STEP_OUTPUT_INVALID', (err as Error).message)
    }
  }

  private async writeOutputs(
    options: RunOptions,
    baseScope: Scope,
    steps: Record<string, unknown>
  ): Promise<Array<{ name: string; path: string }>> {
    const { writeFile, mkdir } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    const bindings: Array<{ name: string; path: string }> = []
    const scope = buildScope(baseScope, steps, undefined, false)
    for (const output of this.manifest.outputs) {
      if (output.kind === 'text' || !output.path) continue
      const rel = evaluateValue(output.path, scope) as string
      const abs = resolveOutputPath(options.workspaceRoot, rel)
      await mkdir(dirname(abs), { recursive: true })
      const value = steps[output.name]
      const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      await writeFile(abs, text.endsWith('\n') ? text : `${text}\n`, 'utf8')
      const normalized = rel.split('\\').join('/')
      bindings.push({ name: output.name, path: normalized })
      this.emit({ type: 'workflow.output', runId: options.runId, name: output.name, path: normalized }, options.runId)
    }
    return bindings
  }
}

function attachPartial(err: unknown, partialOutputs: Record<string, unknown>): unknown {
  if (err !== null && typeof err === 'object') {
    Object.defineProperty(err, 'partialOutputs', { value: { ...partialOutputs }, enumerable: false })
  }
  return err
}

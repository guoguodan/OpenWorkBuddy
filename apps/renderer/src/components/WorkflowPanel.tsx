import { useCallback, useEffect, useMemo, useState } from 'react'
import { IconFile, IconLoader, IconPlay, IconRefresh, IconSparkle, IconStop, IconX } from './Icons'

interface WorkflowPanelProps {
  onClose: () => void
  onNotify: (kind: 'system' | 'info', text: string) => void
  onOpenOutput: (path: string, title: string) => void
}

type InputKind = 'text' | 'number' | 'boolean'

const POLL_INTERVAL_MS = 1200

function inputKind(input: WorkflowInfo['inputs'][number]): InputKind {
  if (typeof input.default === 'boolean') return 'boolean'
  if (typeof input.default === 'number') return 'number'
  return 'text'
}

function initialValue(input: WorkflowInfo['inputs'][number]): string {
  if (input.default === undefined || input.default === null) return ''
  if (typeof input.default === 'boolean') return String(input.default)
  if (typeof input.default === 'number') return String(input.default)
  return String(input.default)
}

function runStatus(run: WorkflowRunInfo): { label: string; tone: 'running' | 'done' | 'failed' | 'interrupted' } {
  if (run.active) return { label: '运行中', tone: 'running' }
  if (run.status === 'running') return { label: '已中断', tone: 'interrupted' }
  if (run.status === 'done') return { label: '已完成', tone: 'done' }
  if (run.status === 'failed') return { label: '失败', tone: 'failed' }
  return { label: '已中断', tone: 'interrupted' }
}

function timeText(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN')
}

function phaseLabel(workflow: WorkflowInfo | undefined, phaseId: string): string {
  return workflow?.phases.find((phase) => phase.id === phaseId)?.title ?? phaseId
}

/**
 * 工作流运行面板。
 *
 * 表单完全由 manifest.inputs 生成,不在界面里硬编码某一套参数;
 * 运行记录读取磁盘上的 run.json,因此重启后历史与产物仍然可点开。
 * 只有 daemon 报告的活动运行才能取消,已退出进程的运行只能续跑。
 */
export function WorkflowPanel({ onClose, onNotify, onOpenOutput }: WorkflowPanelProps) {
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([])
  const [issues, setIssues] = useState<Array<{ path: string; reason: string }>>([])
  const [runs, setRuns] = useState<WorkflowRunInfo[]>([])
  const [active, setActive] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState<string | null>(null)
  const [lastStarted, setLastStarted] = useState<string | null>(null)

  const selected = useMemo(
    () => workflows.find((workflow) => workflow.id === selectedId) ?? null,
    [workflows, selectedId]
  )
  const workflowById = useMemo(() => {
    const map = new Map<string, WorkflowInfo>()
    for (const workflow of workflows) map.set(workflow.id, workflow)
    return map
  }, [workflows])
  const hasActive = active.length > 0 || runs.some((run) => run.active)

  const loadRuns = useCallback(async () => {
    const result = await window.openwb.workflow.runs({ limit: 30 })
    setRuns(result.runs)
    setActive(result.active)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [list] = await Promise.all([window.openwb.workflow.list(), loadRuns()])
      setWorkflows(list.workflows)
      setIssues(list.issues)
      setSelectedId((current) => {
        if (current && list.workflows.some((workflow) => workflow.id === current)) return current
        return list.workflows[0]?.id ?? null
      })
    } catch (err) {
      onNotify('system', `工作流加载失败: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [loadRuns, onNotify])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!hasActive) return
    const timer = window.setInterval(() => {
      void loadRuns().catch((err: Error) => onNotify('system', `运行状态刷新失败: ${err.message}`))
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [hasActive, loadRuns, onNotify])

  useEffect(() => {
    if (!selected) {
      setValues({})
      return
    }
    setValues(Object.fromEntries(selected.inputs.map((input) => [input.name, initialValue(input)])))
  }, [selected])

  const missing = selected
    ? selected.inputs
        .filter((input) => input.required && String(values[input.name] ?? '').trim() === '')
        .map((input) => input.name)
    : []

  const buildInputs = (): Record<string, unknown> | null => {
    if (!selected) return {}
    const inputs: Record<string, unknown> = {}
    for (const input of selected.inputs) {
      const raw = values[input.name] ?? ''
      const kind = inputKind(input)
      if (kind === 'boolean') {
        inputs[input.name] = raw === 'true'
        continue
      }
      if (raw.trim() === '') {
        if (input.required) continue
        if (input.default === undefined) continue
      }
      if (kind === 'number') {
        const parsed = Number(raw)
        if (!Number.isFinite(parsed)) {
          onNotify('system', `输入 ${input.name} 必须是数字`)
          return null
        }
        inputs[input.name] = parsed
        continue
      }
      inputs[input.name] = raw
    }
    return inputs
  }

  const start = async () => {
    if (!selected) return
    if (missing.length > 0) {
      onNotify('system', `请填写必填输入: ${missing.join(', ')}`)
      return
    }
    const inputs = buildInputs()
    if (!inputs) return
    setWorking('start')
    try {
      const started = await window.openwb.workflow.run({ workflowId: selected.id, inputs })
      setLastStarted(started.runId)
      await loadRuns()
      onNotify('info', `工作流「${selected.name}」已开始`)
    } catch (err) {
      onNotify('system', `启动失败: ${(err as Error).message}`)
    } finally {
      setWorking(null)
    }
  }

  const resume = async (run: WorkflowRunInfo) => {
    setWorking(`resume:${run.runId}`)
    try {
      await window.openwb.workflow.resume({ runId: run.runId })
      setLastStarted(run.runId)
      await loadRuns()
      onNotify('info', '已从上次完成的阶段续跑')
    } catch (err) {
      onNotify('system', `续跑失败: ${(err as Error).message}`)
    } finally {
      setWorking(null)
    }
  }

  const cancel = async (run: WorkflowRunInfo) => {
    setWorking(`cancel:${run.runId}`)
    try {
      const result = await window.openwb.workflow.cancel(run.runId)
      await loadRuns()
      onNotify(result.cancelled ? 'info' : 'system', result.cancelled ? '已请求取消运行' : '运行已经结束')
    } catch (err) {
      onNotify('system', `取消失败: ${(err as Error).message}`)
    } finally {
      setWorking(null)
    }
  }

  return (
    <section className="owb-sheet owb-sheet--workflow" role="dialog" aria-modal="true" aria-label="工作流">
      <header className="owb-sheet__header">
        <div>
          <h2>工作流</h2>
          <p>选择工作流、填写输入，按阶段推进并查看产物</p>
        </div>
        <div className="owb-sheet__header-actions">
          <button
            className="owb-sheet__action"
            onClick={() => void refresh()}
            disabled={loading || working !== null}
            title="刷新"
          >
            <IconRefresh size={13} />
            刷新
          </button>
          <button className="owb-icon-btn" onClick={onClose} aria-label="关闭工作流">
            <IconX size={16} />
          </button>
        </div>
      </header>

      <div className="owb-workflow">
        <aside className="owb-workflow__list" aria-label="工作流列表">
          {loading ? (
            <div className="owb-empty">加载中…</div>
          ) : workflows.length === 0 ? (
            <div className="owb-empty">
              <IconSparkle size={26} />
              <strong>没有可用工作流</strong>
              <span>在 .openwb/workflows 或内置资源目录添加 manifest 后重试。</span>
            </div>
          ) : (
            <div data-testid="workflow-list">
              {workflows.map((workflow) => (
                <button
                  key={workflow.id}
                  className={`owb-workflow__item${workflow.id === selectedId ? ' owb-workflow__item--on' : ''}`}
                  onClick={() => setSelectedId(workflow.id)}
                  data-testid={`workflow-item-${workflow.id}`}
                  aria-pressed={workflow.id === selectedId}
                >
                  <span className="owb-workflow__item-title">{workflow.name}</span>
                  <span className="owb-workflow__item-sub">
                    {workflow.phases.length} 个阶段 · {workflow.scope === 'builtin' ? '内置' : '项目'}
                  </span>
                </button>
              ))}
            </div>
          )}
          {issues.length > 0 ? (
            <div className="owb-workflow__issues">
              <strong>{issues.length} 个工作流无法加载</strong>
              {issues.slice(0, 4).map((issue) => (
                <span key={`${issue.path}:${issue.reason}`} title={issue.reason}>
                  {issue.path}
                </span>
              ))}
            </div>
          ) : null}
        </aside>

        <div className="owb-workflow__main">
          {selected ? (
            <div className="owb-workflow__detail">
              <div className="owb-workflow__detail-head">
                <div>
                  <h3>{selected.name}</h3>
                  <p>{selected.description}</p>
                </div>
                <span className="owb-workflow__mode">{selected.mode}</span>
              </div>

              <ol className="owb-workflow__phases" data-testid="workflow-phases">
                {selected.phases.map((phase, index) => (
                  <li key={phase.id}>
                    <span className="owb-workflow__phase-index">{index + 1}</span>
                    <span className="owb-workflow__phase-title">{phase.title}</span>
                    <span className="owb-workflow__phase-meta">
                      {phase.fanout ? '扇出' : phase.parallel ? '并行' : '顺序'} · {phase.steps} 步
                    </span>
                  </li>
                ))}
              </ol>

              <div className="owb-form owb-workflow__form" data-testid="workflow-form">
                {selected.inputs.length === 0 ? (
                  <p className="owb-settings-hint">该工作流不需要输入，直接开始即可。</p>
                ) : (
                  selected.inputs.map((input) => {
                    const kind = inputKind(input)
                    const id = `wf-input-${selected.id}-${input.name}`
                    return (
                      <label className="owb-field" key={input.name} htmlFor={id}>
                        <span>
                          {input.name}
                          {input.required ? <em className="owb-workflow__required">必填</em> : null}
                        </span>
                        {kind === 'boolean' ? (
                          <input
                            id={id}
                            type="checkbox"
                            checked={(values[input.name] ?? 'false') === 'true'}
                            onChange={(event) =>
                              setValues((current) => ({ ...current, [input.name]: String(event.target.checked) }))
                            }
                            data-testid={`workflow-input-${input.name}`}
                          />
                        ) : kind === 'number' ? (
                          <input
                            id={id}
                            type="number"
                            value={values[input.name] ?? ''}
                            onChange={(event) =>
                              setValues((current) => ({ ...current, [input.name]: event.target.value }))
                            }
                            data-testid={`workflow-input-${input.name}`}
                          />
                        ) : (
                          <textarea
                            id={id}
                            rows={input.name === 'question' || input.name === 'topic' ? 3 : 2}
                            value={values[input.name] ?? ''}
                            placeholder={input.description || input.name}
                            onChange={(event) =>
                              setValues((current) => ({ ...current, [input.name]: event.target.value }))
                            }
                            data-testid={`workflow-input-${input.name}`}
                          />
                        )}
                        {input.description ? <small className="owb-settings-hint">{input.description}</small> : null}
                      </label>
                    )
                  })
                )}
                <div className="owb-form__actions">
                  <button
                    className="owb-sheet__primary"
                    onClick={() => void start()}
                    disabled={working !== null || missing.length > 0}
                    data-testid="workflow-start"
                  >
                    {working === 'start' ? <IconLoader size={13} /> : <IconPlay size={13} />}
                    {working === 'start' ? '启动中…' : '开始运行'}
                  </button>
                </div>
                {missing.length > 0 ? (
                  <p className="owb-workflow__warn">还需要填写: {missing.join('、')}</p>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="owb-empty">
              <IconSparkle size={28} />
              <strong>选择一个工作流</strong>
              <span>左侧列出内置与项目级 manifest。</span>
            </div>
          )}

          <section className="owb-workflow__runs" aria-label="运行记录">
            <div className="owb-workflow__runs-head">
              <h3>最近运行</h3>
              {hasActive ? <span className="owb-workflow__live">有运行进行中</span> : null}
            </div>
            {runs.length === 0 ? (
              <div className="owb-empty">
                <IconFile size={24} />
                <strong>还没有运行记录</strong>
                <span>运行一次后，阶段、错误与产物会显示在这里。</span>
              </div>
            ) : (
              <div className="owb-workflow__run-list" data-testid="workflow-runs">
                {runs.map((run) => {
                  const status = runStatus(run)
                  const workflow = workflowById.get(run.workflowId)
                  const phases = workflow?.phases ?? []
                  const canResume = !run.active && (run.status === 'failed' || run.status === 'interrupted' || run.status === 'running')
                  return (
                    <article
                      key={run.runId}
                      className={`owb-workflow__run owb-workflow__run--${status.tone}${
                        run.runId === lastStarted ? ' owb-workflow__run--new' : ''
                      }`}
                      data-testid={`workflow-run-${run.runId}`}
                    >
                      <div className="owb-workflow__run-head">
                        <div className="owb-workflow__run-title">
                          <strong>{workflow?.name ?? run.workflowId}</strong>
                          <span className={`owb-workflow__badge owb-workflow__badge--${status.tone}`}>{status.label}</span>
                        </div>
                        <span className="owb-workflow__run-time">{timeText(run.updatedAt)}</span>
                      </div>

                      <div className="owb-workflow__progress" aria-label="阶段进度">
                        {phases.length > 0
                          ? phases.map((phase) => {
                              const done = run.completedPhases.includes(phase.id)
                              const current = run.active && run.currentPhase === phase.id
                              return (
                                <span
                                  key={phase.id}
                                  className={`owb-workflow__dot${done ? ' owb-workflow__dot--done' : ''}${
                                    current ? ' owb-workflow__dot--current' : ''
                                  }`}
                                  title={`${phase.title}${done ? '（已完成）' : current ? '（进行中）' : ''}`}
                                >
                                  {phase.title}
                                </span>
                              )
                            })
                          : run.completedPhases.map((phaseId) => (
                              <span key={phaseId} className="owb-workflow__dot owb-workflow__dot--done">
                                {phaseLabel(workflow, phaseId)}
                              </span>
                            ))}
                      </div>

                      <div className="owb-workflow__run-meta">
                        <span>模型调用 {run.modelCalls}</span>
                        <span>更新于 {timeText(run.updatedAt)}</span>
                        <span className="owb-workflow__run-id" title={run.runId}>
                          {run.runId}
                        </span>
                      </div>

                      {run.errorMessage ? (
                        <p className="owb-workflow__error">
                          {run.errorCode ? `${run.errorCode}: ` : ''}
                          {run.errorMessage}
                        </p>
                      ) : null}

                      {run.outputs && run.outputs.length > 0 ? (
                        <div className="owb-workflow__outputs">
                          {run.outputs.map((output) => (
                            <button
                              key={output.name}
                              className="owb-sheet__action"
                              data-testid={`workflow-output-${output.name}`}
                              onClick={() => onOpenOutput(output.path, `${workflow?.name ?? run.workflowId} · ${output.name}`)}
                              title={output.path}
                            >
                              <IconFile size={13} />
                              {output.name}
                            </button>
                          ))}
                        </div>
                      ) : null}

                      {run.active || canResume ? (
                        <div className="owb-workflow__run-actions">
                          {run.active ? (
                            <button
                              className="owb-sheet__action owb-sheet__action--danger"
                              onClick={() => void cancel(run)}
                              disabled={working !== null}
                              data-testid={`workflow-cancel-${run.runId}`}
                            >
                              {working === `cancel:${run.runId}` ? <IconLoader size={13} /> : <IconStop size={13} />}
                              取消
                            </button>
                          ) : null}
                          {canResume ? (
                            <button
                              className="owb-sheet__action"
                              onClick={() => void resume(run)}
                              disabled={working !== null}
                              data-testid={`workflow-resume-${run.runId}`}
                            >
                              {working === `resume:${run.runId}` ? <IconLoader size={13} /> : <IconPlay size={13} />}
                              续跑
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  )
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </section>
  )
}

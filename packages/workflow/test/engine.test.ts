import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkflowEngine, type EngineHooks, type PromptRequest } from '../src/engine.js'
import { workflowSchema } from '../src/manifest.js'
import { FileRunStore } from '../src/store.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'owb-engine-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function manifest(raw: Record<string, unknown>) {
  const parsed = workflowSchema.safeParse(raw)
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues))
  return parsed.data
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: 'test-flow',
    name: '测试',
    description: '',
    mode: 'craft',
    limits: { maxDurationSec: 30, maxModelCalls: 20 },
    inputs: [{ name: 'question', required: true, description: '' }],
    outputs: [{ name: 'report', kind: 'file', path: 'reports/{{run.id}}/report.md' }],
    phases: [
      {
        id: 'scope',
        parallel: false,
        steps: [{ id: 'angles', type: 'prompt', prompt: 'Q={{inputs.question}}', save_as: 'angles', output: 'text' }]
      },
      {
        id: 'write',
        parallel: false,
        steps: [{ id: 'report', type: 'prompt', prompt: 'A={{steps.angles}}', save_as: 'report', output: 'markdown' }]
      }
    ],
    ...overrides
  }
}

function makeHooks(target: ReturnType<typeof manifest>, overrides: Partial<EngineHooks> = {}): EngineHooks {
  return {
    prompt: async (req: PromptRequest) => `out:${req.stepId}`,
    tool: async () => null,
    store: new FileRunStore(dir),
    ...overrides
  }
}

describe('workflow engine', () => {
  it('runs phases in order, persists each phase and writes outputs', async () => {
    const wf = manifest(base())
    const store = new FileRunStore(dir)
    const engine = new WorkflowEngine(wf, makeHooks(wf, { store }))
    const outcome = await engine.run({ runId: 'run-a', inputs: { question: 'q' }, workspaceRoot: dir })
    expect(outcome.error?.message ?? outcome.status).toBe('done')
    expect(outcome.modelCalls).toBe(2)
    expect(outcome.outputBindings).toEqual([{ name: 'report', path: 'reports/run-a/report.md' }])
    const text = await readFile(join(dir, 'reports/run-a/report.md'), 'utf8')
    expect(text).toContain('out:report')
    const phase = await store.readPhase('run-a', 'scope')
    expect(phase?.outputs).toEqual({ angles: 'out:angles' })
  })

  it('runs parallel phases concurrently (max 4)', async () => {
    let active = 0
    let peak = 0
    const wf = manifest(
      base({
        phases: [
          {
            id: 'parallel',
            parallel: true,
            steps: [
              { id: 'aa', type: 'prompt', prompt: 'a', save_as: 'aa' },
              { id: 'bb', type: 'prompt', prompt: 'b', save_as: 'bb' },
              { id: 'cc', type: 'prompt', prompt: 'c', save_as: 'cc' },
              { id: 'dd', type: 'prompt', prompt: 'd', save_as: 'dd' },
              { id: 'ee', type: 'prompt', prompt: 'e', save_as: 'ee' }
            ]
          }
        ],
        outputs: []
      })
    )
    const engine = new WorkflowEngine(
      wf,
      makeHooks(wf, {
        prompt: async (req) => {
          active += 1
          peak = Math.max(peak, active)
          await new Promise((r) => setTimeout(r, 30))
          active -= 1
          return `done:${req.stepId}`
        }
      })
    )
    const outcome = await engine.run({ runId: 'run-b', inputs: { question: 'q' }, workspaceRoot: dir })
    expect(outcome.status).toBe('done')
    expect(peak).toBe(4)
    expect(Object.keys(outcome.outputs).sort()).toEqual(['aa', 'bb', 'cc', 'dd', 'ee'])
  })

  it('retries a failing tool step and finishes done', async () => {
    let calls = 0
    const wf = manifest(
      base({
        phases: [
          {
            id: 'single',
            parallel: false,
            steps: [
              {
                id: 'flaky',
                type: 'tool',
                tool: 'flaky',
                save_as: 'ok',
                retry: { maxAttempts: 3, backoffMs: 5 }
              }
            ]
          }
        ],
        outputs: []
      })
    )
    const events: string[] = []
    const engine = new WorkflowEngine(
      wf,
      makeHooks(wf, {
        tool: async () => {
          calls += 1
          if (calls < 2) throw new Error('first fails')
          return { ok: true }
        },
        onEvent: (e) => {
          if (e.type === 'workflow.step') events.push(`${e.status}:${e.attempt}`)
        }
      })
    )
    const outcome = await engine.run({ runId: 'run-c', inputs: { question: 'q' }, workspaceRoot: dir })
    expect(outcome.status).toBe('done')
    expect(calls).toBe(2)
    expect(events).toEqual(['started:1', 'retry:2'])
  })

  it('stops at the failed phase and keeps earlier phase artifacts', async () => {
    const wf = manifest(
      base({
        phases: [
          {
            id: 'first-phase',
            parallel: false,
            steps: [{ id: 'first-step', type: 'prompt', prompt: 'a', save_as: 'first-out' }]
          },
          {
            id: 'second-phase',
            parallel: false,
            steps: [{ id: 'boom-step', type: 'tool', tool: 'boom', retry: { maxAttempts: 2, backoffMs: 1 } }]
          },
          {
            id: 'third-phase',
            parallel: false,
            steps: [{ id: 'third-step', type: 'prompt', prompt: 'c', save_as: 'third-out' }]
          }
        ],
        outputs: []
      })
    )
    let thirdCalls = 0
    const engine = new WorkflowEngine(
      wf,
      makeHooks(wf, {
        prompt: async () => 'ok',
        tool: async () => {
          throw new Error('always fails')
        },
        onEvent: (e) => {
          if (e.type === 'workflow.step' && e.stepId === 'third-step') thirdCalls += 1
        }
      })
    )
    const outcome = await engine.run({ runId: 'run-d', inputs: { question: 'q' }, workspaceRoot: dir })
    expect(outcome.status).toBe('failed')
    expect(thirdCalls).toBe(0)
    const store = new FileRunStore(dir)
    expect((await store.readPhase('run-d', 'first-phase'))?.outputs).toEqual({ 'first-out': 'ok' })
    expect(await store.readPhase('run-d', 'third-phase')).toBeNull()
  })

  it('resumes from the failed phase without repeating completed model calls', async () => {
    const wf = manifest(
      base({
        phases: [
          { id: 'first-phase', parallel: false, steps: [{ id: 'first-step', type: 'prompt', prompt: 'a', save_as: 'first-out' }] },
          { id: 'second-phase', parallel: false, steps: [{ id: 'second-step', type: 'prompt', prompt: 'b', save_as: 'second-out' }] }
        ],
        outputs: []
      })
    )
    let failFirstRun = true
    const prompts: string[] = []
    const hooks = makeHooks(wf, {
      prompt: async (req) => {
        prompts.push(req.stepId)
        if (req.stepId === 'second-step' && failFirstRun) throw new Error('model failed')
        return `x:${req.stepId}`
      }
    })
    const engine = new WorkflowEngine(wf, hooks)
    const first = await engine.run({ runId: 'run-e', inputs: { question: 'q' }, workspaceRoot: dir })
    expect(first.status).toBe('failed')
    expect(prompts).toEqual(['first-step', 'second-step'])

    failFirstRun = false
    prompts.length = 0
    const resumed = await engine.run({ runId: 'run-e', inputs: { question: 'q' }, workspaceRoot: dir, resume: true })
    expect(resumed.status).toBe('done')
    expect(prompts).toEqual(['second-step'])
  })

  it('extracts prefixed JSON and validates it', async () => {
    const wf = manifest(
      base({
        phases: [
          {
            id: 'json-phase',
            parallel: false,
            steps: [
              {
                id: 'json-step',
                type: 'prompt',
                prompt: 'j',
                save_as: 'json-out',
                output: 'json',
                schema: { type: 'object', required: ['angles'], properties: { angles: { type: 'array', minItems: 1, items: { type: 'string' } } } }
              }
            ]
          }
        ],
        outputs: []
      })
    )
    const engine = new WorkflowEngine(
      wf,
      makeHooks(wf, { prompt: async () => '```json\n{"angles":["x"],"note":"} not the end"}\n```' })
    )
    const outcome = await engine.run({ runId: 'run-f', inputs: { question: 'q' }, workspaceRoot: dir })
    expect(outcome.status).toBe('done')
    expect(outcome.outputs['json-out']).toEqual({ angles: ['x'], note: '} not the end' })
  })

  it('retries invalid JSON once, then reports STEP_OUTPUT_INVALID', async () => {
    const wf = manifest(
      base({
        phases: [
          {
            id: 'bad-phase',
            parallel: false,
            steps: [
              {
                id: 'bad-step',
                type: 'prompt',
                prompt: 'bad',
                save_as: 'bad-out',
                output: 'json',
                schema: { type: 'object', required: ['x'] }
              }
            ]
          }
        ],
        outputs: []
      })
    )
    const repairs: Array<string | undefined> = []
    const engine = new WorkflowEngine(
      wf,
      makeHooks(wf, {
        prompt: async (req) => {
          repairs.push(req.repair)
          return 'not json at all'
        }
      })
    )
    const outcome = await engine.run({ runId: 'run-g', inputs: { question: 'q' }, workspaceRoot: dir })
    expect(outcome.status).toBe('failed')
    expect(outcome.error?.code).toBe('STEP_OUTPUT_INVALID')
    expect(repairs).toHaveLength(2)
    expect(repairs[0]).toBeUndefined()
    expect(repairs[1]).toMatch(/JSON/)
  })

  it('cancels a running tool via AbortSignal within the deadline', async () => {
    const wf = manifest(
      base({
        phases: [
          {
            id: 'sleep-phase',
            parallel: false,
            steps: [{ id: 'sleepy', type: 'tool', tool: 'sleepy', save_as: 'sleepy-out' }]
          }
        ],
        outputs: []
      })
    )
    const controller = new AbortController()
    let stopped = false
    const engine = new WorkflowEngine(
      wf,
      makeHooks(wf, {
        tool: async (_name, _args, ctx) => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 5000)
            ctx.signal.addEventListener('abort', () => {
              clearTimeout(timer)
              stopped = true
              reject(new Error('aborted'))
            }, { once: true })
          })
          return 'done'
        }
      })
    )
    const started = Date.now()
    setTimeout(() => controller.abort(new Error('user cancel')), 50)
    const outcome = await engine.run({
      runId: 'run-h',
      inputs: { question: 'q' },
      workspaceRoot: dir,
      signal: controller.signal
    })
    expect(outcome.status).toBe('interrupted')
    expect(stopped).toBe(true)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('fans out and flattens results across iterations', async () => {
    const wf = manifest(
      base({
        inputs: [],
        phases: [
          { id: 'scope', parallel: false, steps: [{ id: 'angles', type: 'prompt', prompt: 'a', save_as: 'angles' }] },
          {
            id: 'search',
            parallel: true,
            fanout: '{{steps.angles}}',
            steps: [{ id: 'one', type: 'tool', tool: 'search', args: { q: '{{item}}' }, save_as: 'results' }]
          },
          {
            id: 'fetch',
            parallel: false,
            steps: [
              { id: 'pages', type: 'tool', tool: 'fetch', args: { urls: '{{steps.results | flatten | unique}}' }, save_as: 'pages' }
            ]
          }
        ],
        outputs: []
      })
    )
    const seen: unknown[] = []
    const engine = new WorkflowEngine(
      wf,
      makeHooks(wf, {
        prompt: async () => 'return me',
        tool: async (name, args) => {
          if (name === 'search') return [`${args.q}-1`, `${args.q}-2`]
          seen.push(args.urls)
          return 'pages'
        }
      })
    )
    const outcome = await engine.run({ runId: 'run-i', inputs: {}, workspaceRoot: dir })
    expect(outcome.status).toBe('failed')
    // prompt 返回的是文本,fanout 需要数组;这条先证明"非数组会被拒绝",下面是合法的数组分支
    expect(outcome.error?.message).toMatch(/不是数组/)
    expect(seen).toHaveLength(0)
  })

  it('fans out over an array and flattens results', async () => {
    const wf = manifest(
      base({
        inputs: [],
        phases: [
          {
            id: 'scope',
            parallel: false,
            steps: [
              {
                id: 'angles',
                type: 'tool',
                tool: 'angles',
                save_as: 'angles'
              }
            ]
          },
          {
            id: 'search',
            parallel: true,
            fanout: '{{steps.angles}}',
            steps: [{ id: 'one', type: 'tool', tool: 'search', args: { q: '{{item}}' }, save_as: 'results' }]
          },
          {
            id: 'fetch',
            parallel: false,
            steps: [{ id: 'pages', type: 'tool', tool: 'fetch', args: { urls: '{{steps.results | flatten | unique}}' }, save_as: 'pages' }]
          }
        ],
        outputs: []
      })
    )
    const seen: unknown[] = []
    const engine = new WorkflowEngine(
      wf,
      makeHooks(wf, {
        tool: async (name, args) => {
          if (name === 'angles') return ['a', 'b']
          if (name === 'search') return [`${args.q}-1`, `${args.q}-2`]
          seen.push(args.urls)
          return 'pages'
        }
      })
    )
    const outcome = await engine.run({ runId: 'run-j', inputs: {}, workspaceRoot: dir })
    expect(outcome.status).toBe('done')
    expect(seen).toEqual([['a-1', 'a-2', 'b-1', 'b-2']])
  })

  it('runs steps sequentially inside each fanout item', async () => {
    const wf = manifest(
      base({
        inputs: [],
        phases: [
          {
            id: 'scope',
            parallel: false,
            steps: [{ id: 'items', type: 'tool', tool: 'items', save_as: 'items' }]
          },
          {
            id: 'review',
            parallel: true,
            fanout: '{{steps.items}}',
            steps: [
              { id: 'read-one', type: 'tool', tool: 'read', args: { item: '{{item}}' }, save_as: 'content' },
              {
                id: 'review-one',
                type: 'tool',
                tool: 'review',
                args: { item: '{{item}}', content: '{{steps.content}}' },
                save_as: 'findings'
              }
            ]
          }
        ],
        outputs: []
      })
    )
    const order: string[] = []
    const engine = new WorkflowEngine(
      wf,
      makeHooks(wf, {
        tool: async (name, args) => {
          if (name === 'items') return ['a', 'b']
          if (name === 'read') {
            await new Promise((r) => setTimeout(r, 20))
            order.push(`read:${args.item}`)
            return `body-${args.item}`
          }
          order.push(`review:${args.item}:${args.content}`)
          return `finding-${args.item}`
        }
      })
    )
    const outcome = await engine.run({ runId: 'run-l', inputs: {}, workspaceRoot: dir })
    expect(outcome.status).toBe('done')
    // 每个 item 内部必须先读后审;item 之间可以交错
    for (const item of ['a', 'b']) {
      expect(order.indexOf(`read:${item}`)).toBeLessThan(order.indexOf(`review:${item}:body-${item}`))
    }
    expect(outcome.outputs.findings).toEqual(expect.arrayContaining(['finding-a', 'finding-b']))
  })

  it('rejects expressions that try to execute code before any step runs', async () => {
    const wf = manifest(
      base({
        phases: [
          {
            id: 'eval-phase',
            parallel: false,
            steps: [{ id: 'eval-step', type: 'prompt', prompt: '{{eval("1+1")}}', save_as: 'eval-out' }]
          }
        ],
        outputs: []
      })
    )
    let called = 0
    const engine = new WorkflowEngine(wf, makeHooks(wf, { prompt: async () => { called += 1; return 'x' } }))
    const outcome = await engine.run({ runId: 'run-k', inputs: { question: 'q' }, workspaceRoot: dir })
    expect(outcome.status).toBe('failed')
    expect(called).toBe(0)
    expect(outcome.error?.message).toMatch(/eval/)
  })
})

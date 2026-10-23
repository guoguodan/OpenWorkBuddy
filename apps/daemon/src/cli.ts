import { resolve } from 'node:path'
import { ToolRegistry } from '@openwb/tools'
import { loadWorkflows } from '@openwb/workflow'
import { builtinTools } from './tools/builtin.js'
import {
  loadWorkflowById,
  newRunId,
  normalizeInputs,
  runWorkflow,
  workflowDirs
} from './workflows/runtime.js'

const USAGE = `用法:
  openwb workflow list
  openwb workflow run <id> --input key=value [--input k=v ...] [--run-id <id>] [--resume]

环境变量:
  OPENWB_WORKSPACE       工作区根目录(默认当前目录)
  OPENWB_DATA_DIR        数据目录(默认 <workspace>/.openwb-data)
  OPENWB_WORKFLOWS_DIR   内置工作流目录(默认 <repo>/resources/workflows)
  OPENWB_MOCK=1          离线执行(不调用真实模型)
`

function parseArgs(argv: string[]) {
  const positional: string[] = []
  const inputs: Record<string, string> = {}
  let runId: string | undefined
  let resume = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--input') {
      const value = argv[++i]
      if (!value) throw new Error('--input 需要 key=value')
      const at = value.indexOf('=')
      if (at <= 0) throw new Error(`--input 格式必须是 key=value: ${value}`)
      inputs[value.slice(0, at)] = value.slice(at + 1)
      continue
    }
    if (arg === '--run-id') {
      const value = argv[++i]
      if (!value) throw new Error('--run-id 需要值')
      runId = value
      continue
    }
    if (arg === '--resume') {
      resume = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE)
      process.exit(0)
    }
    positional.push(arg)
  }
  return { positional, inputs, runId, resume }
}

function workspaceRoot(): string {
  return resolve(process.env.OPENWB_WORKSPACE ?? process.cwd())
}

function dataDir(workspace: string): string {
  return resolve(process.env.OPENWB_DATA_DIR ?? resolve(workspace, '.openwb-data'))
}

function builtinDir(): string {
  // 构建产物在 apps/daemon/dist;源码运行在 apps/daemon/src
  return resolve(process.env.OPENWB_WORKFLOWS_DIR ?? resolve(import.meta.dirname, '../../..', 'resources', 'workflows'))
}

async function main(): Promise<void> {
  const { positional, inputs, runId, resume } = parseArgs(process.argv.slice(2))
  const [group, command, id] = positional
  if (group !== 'workflow') {
    process.stderr.write(USAGE)
    process.exit(2)
  }

  const workspace = workspaceRoot()
  const dirs = workflowDirs(workspace, dataDir(workspace), builtinDir())

  if (command === 'list') {
    const result = await loadWorkflows(dirs)
    for (const { manifest, source } of result.workflows.values()) {
      process.stdout.write(
        `${manifest.id}\t[${source.scope}]\t${manifest.name}\t${manifest.phases.map((p) => p.id).join(' -> ')}\n`
      )
    }
    for (const issue of result.issues) {
      process.stderr.write(`[跳过] ${issue.path}: ${issue.reason}\n`)
    }
    return
  }

  if (command === 'run') {
    if (!id) throw new Error('缺少工作流 id')
    const loaded = await loadWorkflowById(dirs, id)
    const normalized = normalizeInputs(loaded.manifest, inputs)
    const registry = new ToolRegistry()
    // CLI 没有审批通道:破坏性文件工具必须从命令入口移除,
    // 否则工作流一旦声明 delete_files 会走到执行器才发现无人可确认。
    for (const tool of builtinTools()) {
      if (tool.name === 'delete_files' || tool.name === 'move_files') continue
      registry.register(tool)
    }

    const controller = new AbortController()
    const onSignal = () => controller.abort(new Error('用户取消'))
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)

    const { outcome } = await runWorkflow({
      manifest: loaded.manifest,
      runId: runId ?? newRunId(),
      inputs: normalized,
      workspaceRoot: workspace,
      registry,
      signal: controller.signal,
      resume,
      onEvent: (event) => {
        if (event.type === 'workflow.phase') {
          process.stderr.write(`[phase] ${event.phaseId} ${event.status}\n`)
        }
        if (event.type === 'workflow.output') {
          process.stderr.write(`[output] ${event.name} -> ${event.path ?? '(text)'}\n`)
        }
      },
      log: (message) => process.stderr.write(`${message}\n`)
    })

    process.stdout.write(
      `${JSON.stringify(
        {
          runId: outcome.runId,
          status: outcome.status,
          modelCalls: outcome.modelCalls,
          outputBindings: outcome.outputBindings,
          ...(outcome.error ? { error: outcome.error } : {})
        },
        null,
        2
      )}\n`
    )
    process.exitCode = outcome.status === 'done' ? 0 : 1
    return
  }

  process.stderr.write(USAGE)
  process.exit(2)
}

main().catch((err) => {
  process.stderr.write(`[cli] ${(err as Error).message}\n`)
  process.exit(1)
})

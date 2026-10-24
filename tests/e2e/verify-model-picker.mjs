/**
 * 模型选择验收:界面切换 -> daemon 持久化 -> 重启恢复。
 *
 * 覆盖:
 *   - 模型胶囊展示 env 提供的默认模型,而不是硬编码占位文案;
 *   - 点击胶囊可展开菜单并选择自定义模型;
 *   - settings.get 返回解析后的当前模型,settings.model 记录用户选择;
 *   - 重启后从 SQLite 恢复,且覆盖 env 默认值;
 *   - 清空选择后回到 env 默认值,而不是空模型名。
 *
 * 用法: node tests/e2e/verify-model-picker.mjs
 * 前置: pnpm --filter @openwb/daemon build && pnpm --filter @openwb/desktop build
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const electron = resolve(root, 'apps/desktop/node_modules/electron/dist/electron.exe')
const port = 9341
const endpoint = `http://127.0.0.1:${port}/json/list`
const defaultModel = 'test/default-model'
const customModel = 'test/custom-model'

if (!existsSync(electron)) {
  console.error(`缺少 Electron 可执行文件: ${electron}`)
  console.error('先执行: node apps/desktop/node_modules/electron/install.js')
  process.exit(1)
}

let failed = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (ok, label, detail = '') => {
  if (ok) console.log(`PASS ${label}`)
  else {
    failed++
    console.log(`FAIL ${label}${detail ? ` :: ${detail}` : ''}`)
  }
}

async function waitForPage(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await (await fetch(endpoint)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch {}
    await sleep(400)
  }
  throw new Error('Electron 页面未在 30s 内就绪')
}

function connect(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const waiting = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && waiting.has(m.id)) {
        waiting.get(m.id)(m)
        waiting.delete(m.id)
      }
    })
    const timer = setTimeout(() => rej(new Error('CDP 连接超时 10s')), 10000)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      const send = (method, params = {}, timeoutMs = 15000) =>
        new Promise((resolveCall, rejectCall) => {
          const myId = ++id
          const t = setTimeout(() => {
            waiting.delete(myId)
            rejectCall(new Error(`CDP ${method} 超时 ${timeoutMs}ms`))
          }, timeoutMs)
          waiting.set(myId, (m) => {
            clearTimeout(t)
            resolveCall(m)
          })
          ws.send(JSON.stringify({ id: myId, method, params }))
        })
      const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
        if (r.result?.exceptionDetails) {
          throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)
        }
        return r.result?.result?.value
      }
      res({ ws, evaluate })
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      rej(new Error('CDP 连接失败'))
    })
  })
}

async function waitFor(evaluate, expression, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await evaluate(expression)) return true
    await sleep(150)
  }
  return false
}

function launch(workdir, dataDir) {
  const child = spawn(electron, [resolve(root, 'apps/desktop'), `--remote-debugging-port=${port}`], {
    cwd: workdir,
    env: {
      ...process.env,
      OPENWB_DAEMON_ENTRY: resolve(root, 'apps/daemon/dist/index.js'),
      OPENWB_WORKSPACE: workdir,
      OPENWB_DATA_DIR: dataDir,
      OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
      OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts'),
      OPENWB_MODEL: defaultModel,
      OPENWB_MOCK: '1',
      OPENWB_AUTOMATION_AUTOSTART: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stdout.on('data', () => {})
  child.stderr.on('data', (b) => {
    stderr += String(b)
  })
  return { child, stderr: () => stderr }
}

async function stop(child) {
  child.kill()
  await Promise.race([new Promise((r) => child.on('exit', r)), sleep(3000)])
  await sleep(600)
}

const workdir = await mkdtemp(join(tmpdir(), 'owb-model-ui-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-model-ui-data-'))
await writeFile(join(workdir, 'package.json'), '{"name":"model-ui-ws"}\n', 'utf8')

let app = launch(workdir, dataDir)
let client
try {
  const page = await waitForPage()
  client = await connect(page.webSocketDebuggerUrl)
  const { evaluate } = client

  check(await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="model-picker-trigger"]'))`), 'model-picker-rendered')

  // 设置经 IPC 异步到达;加载态不能显示成“未配置模型”,就绪后必须跟随 env。
  const loaded = await waitFor(
    evaluate,
    `document.querySelector('[data-testid="model-picker-trigger"]')?.innerText.includes(${JSON.stringify(defaultModel)}) ?? false`,
    20000
  )
  const initial = await evaluate(`document.querySelector('[data-testid="model-picker-trigger"]')?.innerText ?? ''`)
  check(loaded, 'model-label-follows-env', JSON.stringify(initial))

  // 占位文案不能出现在菜单候选里,更不能被保存成模型名。
  await evaluate(`document.querySelector('[data-testid="model-picker-trigger"]').click()`)
  check(await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="model-picker"]'))`), 'model-menu-opens')
  const placeholderOption = await evaluate(
    `Boolean(document.querySelector('[data-testid="model-option-未配置模型"]'))`
  )
  check(!placeholderOption, 'placeholder-not-an-option')

  await evaluate(`(() => {
    const input = document.querySelector('[data-testid="model-input"]')
    if (!input) throw new Error('找不到自定义模型输入框')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(customModel)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(150)
  await evaluate(`document.querySelector('[data-testid="model-use-custom"]').click()`)

  const changed = await waitFor(
    evaluate,
    `document.querySelector('[data-testid="model-picker-trigger"]')?.innerText.includes(${JSON.stringify(customModel)}) ?? false`,
    15000
  )
  check(changed, 'model-label-updated', JSON.stringify(await evaluate(`document.body.innerText.slice(0, 400)`)))

  const stored = await evaluate(`window.openwb.settings.get()`)
  check(stored?.settings?.model === customModel, 'settings-persist-selection', JSON.stringify(stored?.settings ?? stored))
  check(stored?.model === customModel, 'settings-return-resolved-model', JSON.stringify(stored?.model ?? null))

  client.ws.close()
  client = undefined
  await stop(app.child)

  // 同一 dataDir 重启:用户选择必须覆盖 env 默认值。
  app = launch(workdir, dataDir)
  const page2 = await waitForPage(60000)
  client = await connect(page2.webSocketDebuggerUrl)
  const restored = await waitFor(
    client.evaluate,
    `document.querySelector('[data-testid="model-picker-trigger"]')?.innerText.includes(${JSON.stringify(customModel)}) ?? false`,
    30000
  )
  check(restored, 'model-restored-after-restart')
  const after = await client.evaluate(`window.openwb.settings.get()`)
  check(after?.settings?.model === customModel, 'settings-restored-model', JSON.stringify(after?.settings?.model ?? null))
  check(after?.model === customModel, 'resolved-model-restored', JSON.stringify(after?.model ?? null))

  // 清空选择后应回到 env 默认值,而不是空模型名。
  const cleared = await client.evaluate(`window.openwb.settings.set({ key: 'model', value: null })`)
  check(cleared?.settings?.model === null, 'model-clear-persists-null', JSON.stringify(cleared?.settings?.model ?? null))
  check(cleared?.model === defaultModel, 'model-clear-falls-back-to-env', JSON.stringify(cleared?.model ?? null))
} catch (err) {
  failed++
  console.error(`FAIL 运行异常: ${err?.message ?? err}`)
} finally {
  try {
    client?.ws.close()
  } catch {}
  await stop(app.child)
  const err = app.stderr()
  if (failed > 0 && err.trim()) {
    console.log(`--- app stderr ---\n${err.trim().split('\n').slice(-15).join('\n')}`)
  }
  await rm(workdir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }).catch(() => undefined)
  await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }).catch(() => undefined)
}

process.exit(failed === 0 ? 0 : 1)

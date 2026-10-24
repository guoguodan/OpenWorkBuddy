/**
 * 模型清单降级验收。
 *
 * 网关不可达时菜单不能只显示错误就结束:必须明确提示原因,
 * 同时保留自定义模型输入,否则用户无法在没有 /v1/models 的网关上使用。
 *
 * 用法: node tests/e2e/verify-models-offline.mjs
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
const port = 9347
const endpoint = `http://127.0.0.1:${port}/json/list`
// 未监听端口:连接会被立即拒绝,用来模拟网关不支持 /v1/models。
const deadGateway = 'http://127.0.0.1:18993/v1'
const defaultModel = 'local/offline-default'
const customModel = 'local/manual-entry'

if (!existsSync(electron)) {
  console.error(`缺少 Electron 可执行文件: ${electron}`)
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

const workdir = await mkdtemp(join(tmpdir(), 'owb-models-offline-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-models-offline-data-'))
await writeFile(join(workdir, 'package.json'), '{"name":"models-offline-ws"}\n', 'utf8')

const app = spawn(electron, [resolve(root, 'apps/desktop'), `--remote-debugging-port=${port}`], {
  cwd: workdir,
  env: {
    ...process.env,
    OPENWB_DAEMON_ENTRY: resolve(root, 'apps/daemon/dist/index.js'),
    OPENWB_WORKSPACE: workdir,
    OPENWB_DATA_DIR: dataDir,
    OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
    OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts'),
    OPENWB_MODEL: defaultModel,
    OPENAI_BASE_URL: deadGateway,
    OPENAI_API_KEY: 'test-key',
    OPENWB_AUTOMATION_AUTOSTART: '0',
    OPENWB_ENV_FILE: join(workdir, 'nonexistent.env')
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
let appStderr = ''
app.stdout.on('data', () => {})
app.stderr.on('data', (b) => {
  appStderr += String(b)
})

let client
try {
  const page = await waitForPage()
  client = await connect(page.webSocketDebuggerUrl)
  const { evaluate } = client

  check(
    await waitFor(
      evaluate,
      `document.querySelector('[data-testid="model-picker-trigger"]')?.innerText.includes(${JSON.stringify(defaultModel)}) ?? false`,
      20000
    ),
    'model-label-ready'
  )
  await evaluate(`document.querySelector('[data-testid="model-picker-trigger"]').click()`)
  check(await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="model-picker"]'))`), 'model-menu-opens')
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="model-empty"]'))`, 20000),
    'empty-state-shown'
  )
  const empty = await evaluate(`document.querySelector('[data-testid="model-empty"]')?.textContent ?? ''`)
  check(empty.includes('未能读取模型清单'), 'empty-state-explains-reason', JSON.stringify(empty))
  check(
    await evaluate(`Boolean(document.querySelector('[data-testid="model-input"]'))`),
    'custom-input-still-available'
  )

  // 降级路径必须真的能保存:否则错误提示只是装饰。
  await evaluate(`(() => {
    const input = document.querySelector('[data-testid="model-input"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(customModel)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(150)
  await evaluate(`document.querySelector('[data-testid="model-use-custom"]').click()`)
  check(
    await waitFor(
      evaluate,
      `document.querySelector('[data-testid="model-picker-trigger"]')?.innerText.includes(${JSON.stringify(customModel)}) ?? false`,
      15000
    ),
    'custom-model-applied'
  )
  const stored = await evaluate(`window.openwb.settings.get()`)
  check(stored?.settings?.model === customModel, 'custom-model-persisted', JSON.stringify(stored?.settings?.model ?? null))
} catch (err) {
  failed++
  console.error(`FAIL 运行异常: ${err?.message ?? err}`)
} finally {
  try {
    client?.ws.close()
  } catch {}
  app.kill()
  await Promise.race([new Promise((r) => app.on('exit', r)), sleep(3000)])
  if (failed > 0 && appStderr.trim()) {
    console.log(`--- app stderr ---\n${appStderr.trim().split('\n').slice(-15).join('\n')}`)
  }
  await rm(workdir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }).catch(() => undefined)
  await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }).catch(() => undefined)
}

process.exit(failed === 0 ? 0 : 1)

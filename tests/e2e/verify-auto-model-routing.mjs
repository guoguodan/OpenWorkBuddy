/**
 * 自动路由验收:确认开关、任务规则、路由原因都真实生效。
 *
 * 做法:起一个本地 OpenAI 兼容桩记录 /v1/chat/completions 的 model 字段,
 * 再按"关闭 → 开启 → 快速模式 → 代码任务 → 手动优先"的顺序发送消息,
 * 逐项核对网关实际收到的模型与界面展示的原因。不调用任何真实模型。
 *
 * 用法: node tests/e2e/verify-auto-model-routing.mjs
 * 前置: pnpm --filter @openwb/daemon build && pnpm --filter @openwb/desktop build
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const electron = resolve(root, 'apps/desktop/node_modules/electron/dist/electron.exe')
const cdpPort = 9377
const endpoint = `http://127.0.0.1:${cdpPort}/json/list`
const gatewayPort = 18997
const defaultModel = 'route/default-model'
const deepModel = 'route/deep-model'
const codeModel = 'route/code-model'
const manualModel = 'route/manual-model'

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

const requests = []

const gateway = createServer((req, res) => {
  let raw = ''
  req.setEncoding('utf8')
  req.on('data', (chunk) => {
    raw += chunk
  })
  req.on('end', () => {
    let body = {}
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      body = {}
    }
    if (req.url?.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          object: 'list',
          data: [defaultModel, deepModel, codeModel, manualModel].map((id) => ({ id }))
        })
      )
      return
    }
    if (!req.url?.includes('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }
    const lastUser = Array.isArray(body.messages)
      ? [...body.messages].reverse().find((m) => m.role === 'user')?.content
      : ''
    requests.push({ model: body.model, lastUser, stream: body.stream === true })

    const content = '自动路由验收通过'
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model ?? 'unknown',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        })
      )
      return
    }
    const base = {
      id: `chatcmpl-stream-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? 'unknown'
    }
    const frames = [
      { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: { content }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    ]
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

await new Promise((res, rej) => {
  gateway.once('error', rej)
  gateway.listen(gatewayPort, '127.0.0.1', res)
})

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
    await sleep(200)
  }
  return false
}

const workdir = await mkdtemp(join(tmpdir(), 'owb-route-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-route-data-'))
const userData = await mkdtemp(join(tmpdir(), 'owb-route-user-'))
await writeFile(join(workdir, 'package.json'), '{"name":"auto-route-ws"}\n', 'utf8')

const app = spawn(
  electron,
  [
    resolve(root, 'apps/desktop'),
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userData}`
  ],
  {
    cwd: workdir,
    env: {
      ...process.env,
      OPENWB_DAEMON_ENTRY: resolve(root, 'apps/daemon/dist/index.js'),
      OPENWB_WORKSPACE: workdir,
      OPENWB_DATA_DIR: dataDir,
      OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
      OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts'),
      OPENWB_MODEL: defaultModel,
      OPENAI_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
      OPENAI_API_KEY: 'test-key',
      OPENWB_AUTOMATION_AUTOSTART: '0',
      OPENWB_ENV_FILE: join(workdir, 'nonexistent.env')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  }
)
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
    await waitFor(evaluate, `Boolean(document.querySelector('textarea[data-testid="composer-input"]'))`),
    'composer-rendered'
  )
  check(
    await waitFor(
      evaluate,
      `document.querySelector('[data-testid="model-picker-trigger"]')?.innerText.includes(${JSON.stringify(defaultModel)}) ?? false`,
      25000
    ),
    'default-model-visible'
  )

  const submit = async (text) => {
    await evaluate(`(() => {
      const input = document.querySelector('textarea[data-testid="composer-input"]')
      if (!input) throw new Error('找不到输入框')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(text)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(200)
    await evaluate(`(() => {
      const b = document.querySelector('button[aria-label="发送"]')
      if (!b) throw new Error('找不到发送按钮')
      if (b.disabled) throw new Error('发送按钮不可用')
      b.click()
      return true
    })()`)
  }

  const idle = async (timeoutMs = 60000) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const busy = await evaluate(
        `Boolean(document.querySelector('.owb-composer__send--busy, .owb-content-header__running'))`
      )
      if (!busy) return true
      await sleep(250)
    }
    return false
  }

  const lastRequest = (marker) =>
    [...requests].reverse().find((item) => String(item.lastUser).includes(marker))

  // 1) 默认为关闭:即使正文是代码任务也必须使用默认模型,且不展示路由提示。
  await evaluate(`void window.openwb.settings.set({ key: 'codeModel', value: ${JSON.stringify(codeModel)} })`)
  await submit('route-check-1 关闭时使用默认模型:修复 src/main.ts 的报错')
  check(
    await waitFor(evaluate, `document.body.innerText.includes('自动路由验收通过')`, 45000),
    'turn1-reply'
  )
  check(await idle(), 'turn1-idle')
  check(lastRequest('route-check-1')?.model === defaultModel, 'route-off-uses-default-model', JSON.stringify(lastRequest('route-check-1')))
  check(
    !(await evaluate(`document.body.innerText.includes('自动路由:')`)),
    'route-off-has-no-route-notice'
  )

  // 2) 通过设置面板开启自动路由并保存代码/长上下文模型,避免只测后端开关。
  await evaluate(`document.querySelector('.owb-account').click()`)
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="auto-route-toggle"]'))`),
    'auto-route-toggle-visible'
  )
  await evaluate(`document.querySelector('[data-testid="auto-route-toggle"]').click()`)
  check(
    await waitFor(
      evaluate,
      `(async () => (await window.openwb.settings.get()).settings.autoRouteModel === true)()`,
      15000
    ),
    'auto-route-enabled-through-ui'
  )
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="routed-model-code"]'))`, 10000),
    'routed-model-fields-shown'
  )
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="auto-route-badge"]'))`, 10000),
    'auto-route-badge-visible'
  )
  const fillAndSave = async (kind, value) => {
    await evaluate(`(() => {
      const input = document.querySelector('[data-testid="routed-model-${kind}"]')
      if (!input) throw new Error('找不到 ${kind} 模型输入框')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(value)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(150)
    await evaluate(`document.querySelector('[data-testid="routed-model-save-${kind}"]').click()`)
  }
  await fillAndSave('code', codeModel)
  check(
    await waitFor(
      evaluate,
      `(async () => (await window.openwb.settings.get()).settings.codeModel === ${JSON.stringify(codeModel)})()`,
      15000
    ),
    'code-model-saved-through-ui'
  )
  await fillAndSave('deep', deepModel)
  check(
    await waitFor(
      evaluate,
      `(async () => (await window.openwb.settings.get()).settings.deepModel === ${JSON.stringify(deepModel)})()`,
      15000
    ),
    'deep-model-saved-through-ui'
  )
  await evaluate(`document.querySelector('[aria-label="关闭设置"]').click()`)
  await sleep(200)

  // 3) 代码任务命中代码模型,并在对话里说明原因。
  await submit('route-check-2 修复 src/main.ts 的类型报错')
  check(
    await waitFor(
      evaluate,
      `(document.body.innerText.match(/自动路由验收通过/g) ?? []).length >= 2`,
      45000
    ),
    'turn2-reply'
  )
  check(await idle(), 'turn2-idle')
  check(lastRequest('route-check-2')?.model === codeModel, 'code-task-uses-code-model', JSON.stringify(lastRequest('route-check-2')))
  check(
    await waitFor(evaluate, `document.body.innerText.includes('识别为代码任务,使用代码模型')`, 15000),
    'route-reason-visible'
  )
  check(
    await waitFor(evaluate, `document.body.innerText.includes(${JSON.stringify(codeModel)})`, 15000),
    'route-notice-names-model'
  )

  // 4) 长上下文规则优先于代码规则:同一段文本既超长又包含代码信号,应走长上下文模型。
  const longText = `route-check-3 ${'请逐段检查这段业务描述并给出结论。'.repeat(400)}`
  await submit(longText)
  check(
    await waitFor(
      evaluate,
      `(document.body.innerText.match(/自动路由验收通过/g) ?? []).length >= 3`,
      45000
    ),
    'turn3-reply'
  )
  check(await idle(), 'turn3-idle')
  check(lastRequest('route-check-3')?.model === deepModel, 'long-context-uses-deep-model', JSON.stringify(lastRequest('route-check-3')))
  check(
    await waitFor(evaluate, `document.body.innerText.includes('本轮内容较长,使用长上下文模型')`, 15000),
    'long-context-reason-visible'
  )

  // 5) 手动选择优先于自动路由:同样的代码任务也必须用手动模型。
  await evaluate(`void window.openwb.settings.set({ key: 'model', value: ${JSON.stringify(manualModel)} })`)
  await sleep(300)
  await submit('route-check-4 手动指定后必须优先')
  check(
    await waitFor(
      evaluate,
      `(document.body.innerText.match(/自动路由验收通过/g) ?? []).length >= 4`,
      45000
    ),
    'turn4-reply'
  )
  check(await idle(), 'turn4-idle')
  check(lastRequest('route-check-4')?.model === manualModel, 'manual-selection-wins', JSON.stringify(lastRequest('route-check-4')))
} catch (err) {
  failed++
  console.error(`FAIL 运行异常: ${err?.message ?? err}`)
} finally {
  try {
    client?.ws.close()
  } catch {}
  app.kill()
  await Promise.race([new Promise((r) => app.on('exit', r)), sleep(3000)])
  gateway.close()
  if (failed > 0 && appStderr.trim()) {
    console.log(`--- app stderr ---\n${appStderr.trim().split('\n').slice(-15).join('\n')}`)
  }
  for (const dir of [workdir, dataDir, userData]) {
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }).catch(() => undefined)
  }
}

process.exit(failed === 0 ? 0 : 1)

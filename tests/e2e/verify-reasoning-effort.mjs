/**
 * 思考强度验收:确认档位真的写进发往网关的请求体,而不是只改标签。
 *
 * 做法:起一个本地 OpenAI 兼容桩,记录 /v1/chat/completions 的 reasoning_effort;
 * 先设 high 发一轮,再设自动发一轮,后者不得携带该字段。
 *
 * 用法: node tests/e2e/verify-reasoning-effort.mjs
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
const cdpPort = 9361
const endpoint = `http://127.0.0.1:${cdpPort}/json/list`
const gatewayPort = 18993
const modelName = 'stub/effort-model'

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
      res.end(JSON.stringify({ object: 'list', data: [{ id: modelName }] }))
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
    requests.push({
      model: body.model,
      effort: body.reasoning_effort ?? null,
      hasEffort: Object.prototype.hasOwnProperty.call(body, 'reasoning_effort'),
      lastUser
    })

    const content = '思考强度链路验收通过'
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

const workdir = await mkdtemp(join(tmpdir(), 'owb-effort-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-effort-data-'))
await writeFile(join(workdir, 'package.json'), '{"name":"effort-ws"}\n', 'utf8')

const app = spawn(electron, [resolve(root, 'apps/desktop'), `--remote-debugging-port=${cdpPort}`], {
  cwd: workdir,
  env: {
    ...process.env,
    OPENWB_DAEMON_ENTRY: resolve(root, 'apps/daemon/dist/index.js'),
    OPENWB_WORKSPACE: workdir,
    OPENWB_DATA_DIR: dataDir,
    OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
    OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts'),
    OPENWB_MODEL: modelName,
    OPENAI_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
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
    await waitFor(evaluate, `Boolean(document.querySelector('textarea[data-testid="composer-input"]'))`),
    '界面就绪'
  )
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="effort-picker-trigger"]'))`),
    '输入框提供思考强度入口'
  )
  check(
    await evaluate(`document.querySelector('[data-testid="effort-picker-trigger"]')?.innerText.includes('自动') ?? false`),
    '默认档位为自动'
  )

  await evaluate(`document.querySelector('[data-testid="effort-picker-trigger"]')?.click()`)
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="effort-picker"]'))`),
    '打开档位菜单'
  )
  check(
    await evaluate(
      `['effort-option-auto','effort-option-low','effort-option-medium','effort-option-high'].every((id) => Boolean(document.querySelector('[data-testid="' + id + '"]')))`
    ),
    '菜单列出自动/低/中/高四档'
  )
  await evaluate(`document.querySelector('[data-testid="effort-option-high"]')?.click()`)
  check(
    await waitFor(
      evaluate,
      `document.querySelector('[data-testid="effort-picker-trigger"]')?.innerText.includes('高') ?? false`
    ),
    '选择高后按钮显示当前档位'
  )
  const saved = await evaluate(`window.openwb.settings.get()`)
  check(saved?.settings?.reasoningEffort === 'high', '档位已持久化', JSON.stringify(saved?.settings ?? null))

  const submit = async (text) => {
    await evaluate(`(() => {
      const input = document.querySelector('textarea[data-testid="composer-input"]')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(text)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(200)
    await evaluate(`document.querySelector('button[aria-label="发送"]')?.click()`)
  }

  const idle = async (timeoutMs = 60000) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const busy = await evaluate(`Boolean(document.querySelector('.owb-composer__send--busy, .owb-content-header__running'))`)
      if (!busy) return true
      await sleep(250)
    }
    return false
  }

  await submit('第一轮:只回复思考强度链路验收通过')
  check(
    await waitFor(evaluate, `document.body.innerText.includes('思考强度链路验收通过')`, 45000),
    '第一轮生成完成'
  )
  check(await idle(), '第一轮结束')
  const highReq = requests.find((r) => String(r.lastUser).includes('第一轮'))
  check(highReq?.effort === 'high', '请求体携带 reasoning_effort=high', JSON.stringify(highReq ?? requests))

  await evaluate(`window.openwb.settings.set({ key: 'reasoningEffort', value: null })`)
  await submit('第二轮:只回复思考强度链路验收通过')
  await waitFor(evaluate, `(document.body.innerText.match(/思考强度链路验收通过/g) ?? []).length >= 2`, 45000)
  check(await idle(), '第二轮结束')
  const autoReq = requests.find((r) => String(r.lastUser).includes('第二轮'))
  check(autoReq && autoReq.hasEffort === false, '自动档位不传 reasoning_effort', JSON.stringify(autoReq ?? requests))
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
  await rm(workdir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }).catch(() => undefined)
  await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }).catch(() => undefined)
}

process.exit(failed === 0 ? 0 : 1)
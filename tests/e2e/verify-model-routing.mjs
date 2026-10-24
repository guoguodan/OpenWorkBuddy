/**
 * 模型路由验收:确认界面选择真的写进发往网关的请求体,而不是只改标签。
 *
 * 做法:起一个本地 OpenAI 兼容桩,记录 /v1/chat/completions 的 model 字段;
 * 第二轮清空选择后必须回落到 OPENWB_MODEL。不调用任何真实模型。
 *
 * 用法: node tests/e2e/verify-model-routing.mjs
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
const cdpPort = 9344
const endpoint = `http://127.0.0.1:${cdpPort}/json/list`
const gatewayPort = 18991
const defaultModel = 'stub/default-model'
const selectedModel = 'stub/selected-model'

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

/** 只保留定位问题所需字段:完整消息体会把测试日志变成长文,影响阅读。 */
const requests = []

function completionBody(model, content) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }
  }
}

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
    const lastUser = Array.isArray(body.messages)
      ? [...body.messages].reverse().find((m) => m.role === 'user')?.content
      : ''
    requests.push({ path: req.url, model: body.model, stream: body.stream === true, lastUser })

    if (req.url?.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: defaultModel }, { id: selectedModel }] }))
      return
    }

    if (!req.url?.includes('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }

    const content = '模型链路验收通过'
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(completionBody(body.model ?? 'unknown', content)))
      return
    }

    // 流式响应:只发一条文本 chunk,再以 stop 收尾,足以驱动 daemon 的 UI 路径。
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

const workdir = await mkdtemp(join(tmpdir(), 'owb-model-route-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-model-route-data-'))
await writeFile(join(workdir, 'package.json'), '{"name":"model-route-ws"}\n', 'utf8')

const app = spawn(electron, [resolve(root, 'apps/desktop'), `--remote-debugging-port=${cdpPort}`], {
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

  check(await waitFor(evaluate, `Boolean(document.querySelector('textarea[data-testid="composer-input"]'))`), 'composer-rendered')
  check(
    await waitFor(evaluate, `document.querySelector('[data-testid="model-picker-trigger"]')?.innerText.includes(${JSON.stringify(defaultModel)}) ?? false`, 25000),
    'default-model-visible'
  )

  const set = await evaluate(
    `window.openwb.settings.set({ key: 'model', value: ${JSON.stringify(selectedModel)} })`
  )
  check(set?.model === selectedModel, 'selection-saved', JSON.stringify(set?.model ?? null))

  const submit = async (text) => {
    await evaluate(`(() => {
      const input = document.querySelector('textarea[data-testid="composer-input"]')
      if (!input) throw new Error('找不到输入框')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(text)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return input.value
    })()`)
    await sleep(200)
    await evaluate(`(() => {
      const b = document.querySelector('button[aria-label="发送"]')
      if (!b) throw new Error('找不到发送按钮')
      if (b.disabled) throw new Error('发送按钮不可用')
      b.click(); return true
    })()`)
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

  await submit('第一轮:只回复模型链路验收通过')
  const firstOk = await waitFor(
    evaluate,
    `document.body.innerText.includes('模型链路验收通过')`,
    45000
  )
  check(firstOk, 'first-reply-streamed', (await evaluate('document.body.innerText')).slice(-400))
  check(await idle(), 'first-turn-idle')

  const firstReq = requests.find((r) => String(r.lastUser).includes('第一轮'))
  check(firstReq?.model === selectedModel, 'request-uses-selected-model', JSON.stringify(firstReq ?? requests))

  await evaluate(`window.openwb.settings.set({ key: 'model', value: null })`)
  await submit('第二轮:只回复模型链路验收通过')
  await waitFor(evaluate, `(document.body.innerText.match(/模型链路验收通过/g) ?? []).length >= 2`, 45000)
  check(await idle(), 'second-turn-idle')
  const secondReq = requests.find((r) => String(r.lastUser).includes('第二轮'))
  check(secondReq?.model === defaultModel, 'request-falls-back-to-default', JSON.stringify(secondReq ?? requests))
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

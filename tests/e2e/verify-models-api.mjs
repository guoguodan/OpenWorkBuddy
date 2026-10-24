/**
 * 网关模型清单验收。
 *
 * 覆盖:
 *   - 模型菜单的候选来自 OPENAI_BASE_URL/v1/models,而不是硬编码;
 *   - 加载中显示真实状态,失败时显示原因且不影响自定义输入;
 *   - 选择远端模型后,下一轮 chat/completions 的 model 字段确实是该模型。
 *
 * 用法: node tests/e2e/verify-models-api.mjs
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
const cdpPort = 9346
const endpoint = `http://127.0.0.1:${cdpPort}/json/list`
const gatewayPort = 18992

// 故意使用不常见的名字:如果界面仍写死候选,下列断言必然失败。
const remoteModels = ['studio/alpha-long', 'studio/beta-fast', 'studio/gamma-reason']
const defaultModel = 'studio/alpha-long'
const chosenModel = 'studio/gamma-reason'

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
function completionBody(model, content) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 }
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
    requests.push({ path: req.url, model: body.model, stream: body.stream === true })

    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: remoteModels.map((id) => ({ id, object: 'model' })) }))
      return
    }
    if (!req.url?.includes('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }

    const content = '模型清单链路验收通过'
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(completionBody(body.model ?? 'unknown', content)))
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
    await sleep(150)
  }
  return false
}

const workdir = await mkdtemp(join(tmpdir(), 'owb-models-api-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-models-api-data-'))
await writeFile(join(workdir, 'package.json'), '{"name":"models-api-ws"}\n', 'utf8')

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

  check(await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="model-picker-trigger"]'))`), 'composer-rendered')
  // 设置是异步 IPC 读取的;加载中胶囊是禁用态,过早点击不会打开菜单。
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

  const listed = await waitFor(
    evaluate,
    `document.querySelectorAll('[data-testid="model-picker"] [role="menuitemradio"]').length === 3`,
    20000
  )
  const ids = await evaluate(
    `Array.from(document.querySelectorAll('[data-testid="model-picker"] [role="menuitemradio"]')).map((b) => b.dataset.testid)`
  )
  check(listed, 'menu-lists-gateway-models', JSON.stringify(ids))
  check(
    remoteModels.every((name) => ids.includes(`model-option-${name}`)),
    'menu-uses-remote-ids',
    JSON.stringify(ids)
  )
  check(
    !ids.some((id) => id.includes('gpt-4o-mini') || id.includes('deepseek-v4-flash')),
    'no-hardcoded-candidates',
    JSON.stringify(ids)
  )
  check(
    await waitFor(evaluate, `document.querySelector('[data-testid="model-source"]')?.textContent.includes('3') ?? false`),
    'menu-shows-remote-source'
  )

  await evaluate(`document.querySelector('[data-testid="model-option-${chosenModel}"]').click()`)
  check(
    await waitFor(
      evaluate,
      `document.querySelector('[data-testid="model-picker-trigger"]')?.innerText.includes(${JSON.stringify(chosenModel)}) ?? false`
    ),
    'selection-reflected-in-trigger'
  )
  const stored = await evaluate(`window.openwb.settings.get()`)
  check(stored?.settings?.model === chosenModel, 'selection-persisted', JSON.stringify(stored?.settings?.model ?? null))

  // 真实发一轮,确认请求体用的是刚从网关清单里选的模型。
  await evaluate(`(() => {
    const input = document.querySelector('textarea[data-testid="composer-input"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(input, '只回复 ok')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('button[aria-label="发送"]').click()
    return true
  })()`)
  check(
    await waitFor(
      evaluate,
      `!document.querySelector('.owb-composer__send--busy') && document.body.innerText.includes('模型清单链路验收通过')`,
      45000
    ),
    'turn-completed'
  )
  const chat = requests.filter((r) => r.path?.includes('/chat/completions'))
  check(chat.length > 0, 'gateway-received-chat-request', JSON.stringify(requests.map((r) => r.path)))
  check(chat.every((r) => r.model === chosenModel), 'request-uses-chosen-model', JSON.stringify(chat.map((r) => r.model)))
  check(requests.some((r) => r.path?.endsWith('/models')), 'gateway-models-endpoint-called')
} catch (err) {
  failed++
  console.error(`FAIL 运行异常: ${err?.message ?? err}`)
} finally {
  try {
    client?.ws.close()
  } catch {}
  app.kill()
  await Promise.race([new Promise((r) => app.on('exit', r)), sleep(3000)])
  await new Promise((r) => gateway.close(r))
  if (failed > 0 && appStderr.trim()) {
    console.log(`--- app stderr ---\n${appStderr.trim().split('\n').slice(-15).join('\n')}`)
  }
  await rm(workdir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }).catch(() => undefined)
  await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }).catch(() => undefined)
}

process.exit(failed === 0 ? 0 : 1)

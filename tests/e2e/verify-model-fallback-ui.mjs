/**
 * 备用模型界面验收:配置入口 -> 持久化 -> 对话页降级提示。
 *
 * 桩网关让主模型连续 503、备用模型成功,确认用户不仅能在设置里配置,
 * 还能在对话里看到"已切换备用模型"而不是只看到一条失败。
 *
 * 用法: node tests/e2e/verify-model-fallback-ui.mjs
 * 前置: pnpm --filter @openwb/daemon build && pnpm --filter @openwb/desktop build
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const electron = resolve(root, 'apps/desktop/node_modules/electron/dist/electron.exe')
if (!existsSync(electron)) {
  console.error('缺少 Electron 可执行文件')
  process.exit(1)
}

const cdpPort = 9349
const gatewayPort = 18998
const endpoint = `http://127.0.0.1:${cdpPort}/json/list`
const primary = 'ui/primary-model'
const backup = 'ui/backup-model'
const reply = '备用模型界面验收通过'

let failed = 0
let calls = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (ok, label, detail = '') => {
  if (ok) console.log(`PASS ${label}`)
  else {
    failed++
    console.log(`FAIL ${label}${detail ? ` :: ${detail}` : ''}`)
  }
}

const gateway = createServer((req, res) => {
  let raw = ''
  req.setEncoding('utf8')
  req.on('data', (b) => {
    raw += b
  })
  req.on('end', () => {
    let body = {}
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {}
    if (req.url?.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: primary }, { id: backup }] }))
      return
    }
    const isTitle = String(body?.messages?.[0]?.content ?? '').startsWith('你是会话标题生成器')
    if (!isTitle) calls++
    // 自动标题单独成功;主模型的前两次真实请求失败,备用模型成功。
    if (!isTitle && calls <= 2) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'primary overloaded' } }))
      return
    }
    const base = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
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
    await sleep(180)
  }
  return false
}

const workdir = await mkdtemp(join(tmpdir(), 'owb-fallback-ui-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-fallback-ui-data-'))
await writeFile(join(workdir, 'package.json'), '{"name":"fallback-ui-ws"}\n', 'utf8')

const app = spawn(electron, [resolve(root, 'apps/desktop'), `--remote-debugging-port=${cdpPort}`], {
  cwd: workdir,
  env: {
    ...process.env,
    OPENWB_DAEMON_ENTRY: resolve(root, 'apps/daemon/dist/index.js'),
    OPENWB_WORKSPACE: workdir,
    OPENWB_DATA_DIR: dataDir,
    OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
    OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts'),
    OPENWB_MODEL: primary,
    OPENAI_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
    OPENAI_API_KEY: 'test-key',
    OPENWB_STREAM_RETRY_BASE_MS: '10',
    OPENWB_STREAM_MAX_ATTEMPTS: '2',
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
    await waitFor(
      evaluate,
      `document.querySelector('[data-testid="model-picker-trigger"]')?.innerText.includes(${JSON.stringify(primary)}) ?? false`,
      25000
    ),
    'primary-model-visible'
  )

  // 通过账号入口打开设置,手动填写备用模型并保存。
  await evaluate(`document.querySelector('.owb-account').click()`)
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[role="dialog"][aria-label="设置"]'))`),
    'settings-open'
  )
  const panelText = await evaluate(`document.querySelector('[role="dialog"][aria-label="设置"]')?.innerText ?? ''`)
  check(panelText.includes('备用模型'), 'fallback-field-visible', panelText.slice(0, 250))

  await evaluate(`(() => {
    const input = document.querySelector('[data-testid="fallback-model-input"]')
    if (!input) throw new Error('找不到备用模型输入框')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(backup)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(150)
  await evaluate(`document.querySelector('[data-testid="fallback-model-save"]').click()`)
  const saved = await waitFor(
    evaluate,
    `(async () => (await window.openwb.settings.get()).settings.fallbackModel === ${JSON.stringify(backup)})()`,
    15000
  )
  check(saved, 'fallback-saved-through-ui')
  // 欢迎页不渲染运行提示,这里以输入框回填值为准,确认用户看到已保存配置。
  check(
    await waitFor(
      evaluate,
      `document.querySelector('[data-testid="fallback-model-input"]')?.value === ${JSON.stringify(backup)}`
    ),
    'fallback-field-reflects-saved-value'
  )

  await evaluate(`document.querySelector('[aria-label="关闭设置"]').click()`)
  await sleep(200)

  const submit = async (text) => {
    await evaluate(`(() => {
      const input = document.querySelector('textarea[data-testid="composer-input"]')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(text)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(200)
    await evaluate(`document.querySelector('button[aria-label="发送"]').click()`)
  }

  await submit('验证主模型失败后界面是否提示已切换备用模型')
  check(
    await waitFor(evaluate, `document.body.innerText.includes(${JSON.stringify(reply)})`, 45000),
    'fallback-reply-visible',
    (await evaluate('document.body.innerText')).slice(-500)
  )
  check(
    await waitFor(evaluate, `document.body.innerText.includes('已切换到备用模型')`, 15000),
    'fallback-notice-visible'
  )
  check(
    await waitFor(
      evaluate,
      `document.body.innerText.includes(${JSON.stringify(primary)}) && document.body.innerText.includes(${JSON.stringify(backup)})`,
      15000
    ),
    'fallback-notice-names-both-models'
  )

  // 清除后应关闭降级,并恢复为可再次配置的空值。
  await evaluate(`document.querySelector('.owb-account').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="fallback-model-clear"]'))`)
  await evaluate(`document.querySelector('[data-testid="fallback-model-clear"]').click()`)
  check(
    await waitFor(
      evaluate,
      `(async () => (await window.openwb.settings.get()).settings.fallbackModel === null)()`,
      15000
    ),
    'fallback-cleared-through-ui'
  )
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
    console.log(`--- app stderr ---\n${appStderr.trim().split('\n').slice(-20).join('\n')}`)
  }
  await rm(workdir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }).catch(() => undefined)
  await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }).catch(() => undefined)
}

process.exit(failed === 0 ? 0 : 1)

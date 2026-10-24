/**
 * 中断生成的界面验收。
 *
 * 覆盖:
 *   - 生成中停止按钮可点击(此前只是 disabled 占位);
 *   - 点击后 daemon 确认中断,按钮回到发送态;
 *   - 已经输出的部分回复仍留在界面里,并提示"已停止生成";
 *   - 停止后可以立即发送下一轮。
 *
 * 用法: node tests/e2e/verify-cancel-ui.mjs
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
    const timer = setTimeout(() => rej(new Error('CDP WebSocket 连接超时')), 10000)
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
      rej(new Error('CDP WebSocket 连接失败'))
    })
  })
}

async function waitFor(evaluate, expression, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await evaluate(expression)) return true
    await sleep(120)
  }
  return false
}

const workdir = await mkdtemp(join(tmpdir(), 'owb-cancel-ui-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-cancel-ui-data-'))
await writeFile(join(workdir, 'package.json'), '{"name":"cancel-ui-ws"}\n', 'utf8')

const app = spawn(electron, [resolve(root, 'apps/desktop'), `--remote-debugging-port=${port}`], {
  cwd: workdir,
  env: {
    ...process.env,
    OPENWB_DAEMON_ENTRY: resolve(root, 'apps/daemon/dist/index.js'),
    OPENWB_WORKSPACE: workdir,
    OPENWB_DATA_DIR: dataDir,
    OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
    OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts'),
    OPENWB_MOCK: '1',
    OPENWB_MOCK_DELAY_MS: '30',
    OPENWB_AUTOMATION_AUTOSTART: '0'
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

  const submitted = await evaluate(`(() => {
    const input = document.querySelector('textarea[data-testid="composer-input"]')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(input, '请读取 package.json 并告诉我内容')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const send = document.querySelector('button[aria-label="发送"]')
    if (!send) return false
    send.click()
    return true
  })()`)
  check(submitted, '发送第一条消息')

  const stopReady = await waitFor(
    evaluate,
    `(() => {
      const b = document.querySelector('button[aria-label="停止生成"]')
      return Boolean(b && !b.disabled)
    })()`,
    10000
  )
  check(stopReady, '生成中停止按钮可点击')

  // 停止按钮在请求一发出就会切换,但此时模型可能还没有推出第一个片段。
  // 先等真正的增量到达,才能验收"保留已经看到的内容"而不是空回复。
  const partialReady = await waitFor(
    evaluate,
    `(Array.from(document.querySelectorAll('.owb-msg--assistant .owb-msg__text')).at(-1)?.innerText ?? '').length > 0`,
    15000
  )
  const beforeStop = await evaluate(
    `Array.from(document.querySelectorAll('.owb-msg--assistant .owb-msg__text')).at(-1)?.innerText ?? ''`
  )
  check(partialReady && beforeStop.length > 0, '停止前已有可见的部分输出', beforeStop)

  const clicked = await evaluate(`(() => {
    const b = document.querySelector('button[aria-label="停止生成"]')
    if (!b) return false
    b.click()
    return true
  })()`)
  check(clicked, '点击停止生成')

  const stopped = await waitFor(
    evaluate,
    `document.body.innerText.includes('已停止生成,已保留当前输出') ||
     document.body.innerText.includes('已停止生成，已保留当前输出')`,
    10000
  )
  check(stopped, '界面提示已停止生成')

  const idle = await waitFor(
    evaluate,
    `Boolean(document.querySelector('button[aria-label="发送"]')) &&
     !document.querySelector('button[aria-label="停止生成"]')`,
    10000
  )
  check(idle, '停止后按钮回到发送态')

  const kept = await evaluate(
    `Array.from(document.querySelectorAll('.owb-msg--assistant .owb-msg__text')).at(-1)?.innerText ?? ''`
  )
  check(kept.length > 0, '停止后部分回复仍留在界面', kept)
  check(
    kept.includes(beforeStop.slice(0, Math.min(12, beforeStop.length)).trim()),
    '停止没有撤回已经显示的内容',
    `before=${beforeStop} after=${kept}`
  )

  const stillStreaming = await evaluate(
    `Boolean(document.querySelector('.owb-msg--assistant[data-streaming="1"]'))`
  )
  check(!stillStreaming, '停止后不再显示流式状态')

  // 队列已释放:立即发送下一轮能正常完成。
  const resubmitted = await evaluate(`(() => {
    const input = document.querySelector('textarea[data-testid="composer-input"]')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(input, '再读取一次 package.json')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('button[aria-label="发送"]')?.click()
    return true
  })()`)
  check(resubmitted, '停止后可立即发送下一轮')

  const finished = await waitFor(
    evaluate,
    `Boolean(document.querySelector('button[aria-label="发送"]')) &&
     document.querySelectorAll('.owb-msg--assistant').length >= 2 &&
     !document.querySelector('button[aria-label="停止生成"]') &&
     !document.querySelector('.owb-msg--assistant[data-streaming="1"]')`,
    20000
  )
  check(finished, '下一轮正常完成')
} finally {
  try {
    client?.ws.close()
  } catch {}
  app.kill()
  await Promise.race([new Promise((r) => app.on('exit', r)), sleep(3000)])
  if (failed > 0 && appStderr.trim()) {
    console.log(`--- app stderr ---\n${appStderr.trim().split('\n').slice(-12).join('\n')}`)
  }
  await rm(workdir, { recursive: true, force: true }).catch(() => undefined)
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
}

process.exit(failed === 0 ? 0 : 1)

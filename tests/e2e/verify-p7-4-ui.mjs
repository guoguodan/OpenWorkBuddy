/**
 * P7-4 界面验收:搜索面板能打开、查询、点击结果跳到对应消息。
 * 用法: node tests/e2e/verify-p7-4-ui.mjs
 * 前置: pnpm --filter @openwb/daemon build && pnpm --filter @openwb/desktop build
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const electron = resolve(root, 'apps/desktop/node_modules/electron/dist/electron.exe')
const port = 9444
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

async function waitForPage(timeoutMs = 40_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await (await fetch(endpoint)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch {}
    await sleep(400)
  }
  throw new Error('Electron 页面未在 40s 内就绪')
}

const workdir = await mkdtemp(join(tmpdir(), 'owb-p74-ui-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-p74-ui-data-'))
await mkdir(workdir, { recursive: true })
await writeFile(join(workdir, 'package.json'), JSON.stringify({ name: 'p74-ui' }), 'utf8')

const app = spawn(electron, [resolve(root, 'apps/desktop'), `--remote-debugging-port=${port}`], {
  cwd: workdir,
  env: {
    ...process.env,
    OPENWB_MOCK: '1',
    OPENWB_DAEMON_ENTRY: resolve(root, 'apps/daemon/dist/index.js'),
    OPENWB_WORKSPACE: workdir,
    OPENWB_DATA_DIR: dataDir,
    OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
    OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts'),
    OPENWB_AUTOMATION_AUTOSTART: '0'
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
let appErr = ''
app.stdout.on('data', () => {})
app.stderr.on('data', (b) => { appErr += String(b) })

let ws
try {
  const page = await waitForPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const waiting = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && waiting.has(m.id)) {
      waiting.get(m.id)(m)
      waiting.delete(m.id)
    }
  })
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('CDP 连接超时')), 15_000)
    ws.addEventListener('open', () => { clearTimeout(timer); res() })
    ws.addEventListener('error', () => { clearTimeout(timer); rej(new Error('CDP 连接失败')) })
  })

  const evaluate = (expression, timeoutMs = 20_000) =>
    new Promise((res, rej) => {
      const myId = ++id
      const timer = setTimeout(() => {
        waiting.delete(myId)
        rej(new Error('CDP evaluate 超时'))
      }, timeoutMs)
      waiting.set(myId, (m) => {
        clearTimeout(timer)
        if (m.result?.exceptionDetails) rej(new Error(m.result.exceptionDetails.text))
        else res(m.result?.result?.value)
      })
      ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    })

  const waitFor = async (expression, label, timeoutMs = 30_000) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (await evaluate(expression)) return true
      await sleep(250)
    }
    console.log(`WAIT-TIMEOUT ${label}`)
    return false
  }

  check(await waitFor(`document.querySelector('textarea[data-testid="composer-input"]') !== null`, 'composer'), 'app-ready', appErr.slice(-300))

  await evaluate(`(() => {
    const input = document.querySelector('textarea[data-testid="composer-input"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(input, '请记住关键词 alpha,我们聊聊产品设计')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(150)
  await evaluate(`Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '发送').click()`)
  check(await waitFor(`document.body.innerText.includes('已读取') || document.body.innerText.includes('Quick') || document.body.innerText.includes('产品设计')`, 'first-reply'), 'first-run-finished', appErr.slice(-300))
  check(await waitFor(`!Array.from(document.querySelectorAll('button')).some((b) => b.textContent.includes('执行中'))`, 'idle'), 'first-run-idle')

  // 打开全局搜索:侧栏搜索按钮
  await evaluate(`document.querySelector('.owb-search-pill').click()`)
  check(await waitFor(`document.querySelector('[data-testid="search-panel"]') !== null`, 'panel'), 'search-panel-opens')

  await evaluate(`(() => {
    const input = document.querySelector('[data-testid="search-input"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '产品设计')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

  const hitReady = await waitFor(
    `document.querySelectorAll('[data-testid="search-group-message"] .owb-search-hit').length > 0`,
    'message-hit',
    15_000
  )
  check(hitReady, 'message-hit-visible', appErr.slice(-300))
  const snippet = await evaluate(`document.querySelector('[data-testid="search-group-message"] .owb-search-hit__snippet')?.textContent ?? ''`)
  check(/产品设计/.test(snippet), 'hit-snippet-visible', snippet)

  await evaluate(`document.querySelector('[data-testid="search-group-message"] .owb-search-hit').click()`)
  check(await waitFor(`document.querySelector('.owb-msg--focused') !== null`, 'focused-message'), 'jump-highlights-message')
  const focusedText = await evaluate(`document.querySelector('.owb-msg--focused')?.innerText ?? ''`)
  check(/产品设计/.test(focusedText), 'focused-message-matches', focusedText.slice(0, 120))

  // Ctrl+K 应该重新打开面板
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`)
  check(await waitFor(`document.querySelector('[data-testid="search-panel"]') !== null`, 'ctrl-k'), 'ctrl-k-opens-search')
} catch (err) {
  failed++
  console.error(`FAIL 运行异常: ${err?.message ?? err}`)
  console.error(appErr.slice(-800))
} finally {
  ws?.close()
  app.kill()
  await sleep(1500)
  await rm(workdir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 })
  await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 })
}

console.log(failed === 0 ? '\nP7-4 UI 全部通过' : `\nP7-4 UI 失败 ${failed} 项`)
process.exitCode = failed === 0 ? 0 : 1

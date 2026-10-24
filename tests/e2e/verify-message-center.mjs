/**
 * 消息中心闭环验收:任务完成写通知 → 铃铛红点 → 抽屉 → 标为已读 → 查看详情 → 删除。
 * 用法: node tests/e2e/verify-message-center.mjs
 * 前置: pnpm --filter @openwb/daemon build && pnpm --filter @openwb/desktop build
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const electron = resolve(root, 'apps/desktop/node_modules/electron/dist/electron.exe')
const port = 9337
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
    console.log(`FAIL ${label} ${detail}`)
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
    await sleep(500)
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
    const timer = setTimeout(() => rej(new Error('CDP 连接超时')), 10000)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      const send = (method, params = {}, timeoutMs = 20000) =>
        new Promise((resolveCall, rejectCall) => {
          const myId = ++id
          const t = setTimeout(() => {
            waiting.delete(myId)
            rejectCall(new Error(`CDP ${method} 超时`))
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

async function waitFor(evaluate, expression, timeoutMs = 25000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await evaluate(expression)) return true
    await sleep(250)
  }
  return false
}

const workdir = await mkdtemp(join(tmpdir(), 'owb-msg-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-msg-data-'))

const app = spawn(electron, [resolve(root, 'apps/desktop'), `--remote-debugging-port=${port}`], {
  cwd: workdir,
  env: {
    ...process.env,
    OPENWB_DAEMON_ENTRY: resolve(root, 'apps/daemon/dist/index.js'),
    OPENWB_WORKSPACE: workdir,
    OPENWB_DATA_DIR: dataDir,
    OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
    OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts'),
    OPENWB_MOCK: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
let appStderr = ''
app.stdout.on('data', () => {})
app.stderr.on('data', (b) => {
  appStderr += String(b)
})

let session
try {
  const page = await waitForPage()
  session = await connect(page.webSocketDebuggerUrl)
  const { evaluate } = session
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="welcome"]'))`)

  const send = async (text) => {
    await evaluate(`(() => {
      const input = document.querySelector('textarea[data-testid="composer-input"]')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(text)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await sleep(120)
    await evaluate(`document.querySelector('button[aria-label="发送"]').click()`)
    await sleep(400)
  }
  const waitIdle = async (timeoutMs = 60000) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const busy = await evaluate(
        `Boolean(document.querySelector('.owb-composer__send--busy, .owb-content-header__running'))`
      )
      if (!busy) return true
      await sleep(300)
    }
    return false
  }

  // ---------- 1. 任务完成 → 铃铛出现未读红点 ----------
  await send('验证消息中心通知')
  check(await waitIdle(), 'run-finished')
  const badgeShown = await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="notifications-badge"]'))`)
  check(badgeShown, 'unread-badge-shown')
  const badgeLabel = await evaluate(
    `document.querySelector('.owb-notifications-btn')?.getAttribute('aria-label') ?? ''`
  )
  check(/条未读/.test(badgeLabel), 'unread-badge-aria', badgeLabel)

  // ---------- 2. 打开抽屉并展示真实通知 ----------
  await evaluate(`document.querySelector('.owb-notifications-btn').click()`)
  const drawerShown = await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="message-center"]'))`)
  check(drawerShown, 'message-center-open')
  const filled = await waitFor(
    evaluate,
    `document.querySelectorAll('[data-testid="notification-item"]').length > 0`
  )
  check(filled, 'notification-items-loaded')
  const drawerText = await evaluate(`document.querySelector('[data-testid="message-center"]')?.innerText ?? ''`)
  check(drawerText.includes('消息中心'), 'message-center-title', drawerText.slice(0, 120))
  check(drawerText.includes('任务已完成'), 'task-notification-written', drawerText.slice(0, 200))
  const pendingTab = await evaluate(
    `Array.from(document.querySelectorAll('[data-testid="message-center"] [role="tab"]')).some((b) => b.textContent.includes('待处理'))`
  )
  check(pendingTab, 'pending-tab-present')

  // ---------- 3. 标为已读 → 红点消失 ----------
  await evaluate(`(() => {
    const item = document.querySelector('[data-testid="notification-item"]')
    const button = Array.from(item.querySelectorAll('button')).find((b) => b.textContent.includes('标为已读'))
    button.click()
  })()`)
  const badgeGone = await waitFor(
    evaluate,
    `!document.querySelector('[data-testid="notifications-badge"]')`
  )
  check(badgeGone, 'mark-read-clears-badge')

  // ---------- 4. 查看详情跳回原会话 ----------
  await evaluate(`(() => {
    const item = document.querySelector('[data-testid="notification-item"]')
    const button = Array.from(item.querySelectorAll('button')).find((b) => b.textContent.includes('查看详情'))
    button.click()
  })()`)
  const drawerClosed = await waitFor(
    evaluate,
    `!document.querySelector('[data-testid="message-center"]')`
  )
  check(drawerClosed, 'view-detail-closes-drawer')
  const backInConversation = await waitFor(
    evaluate,
    `document.body.innerText.includes('验证消息中心通知')`
  )
  check(backInConversation, 'view-detail-opens-conversation')

  // ---------- 5. 删除通知 ----------
  await evaluate(`document.querySelector('.owb-notifications-btn').click()`)
  await waitFor(evaluate, `document.querySelectorAll('[data-testid="notification-item"]').length > 0`)
  await evaluate(`(() => {
    const item = document.querySelector('[data-testid="notification-item"]')
    const button = Array.from(item.querySelectorAll('button')).find((b) => b.textContent.includes('删除'))
    button.click()
  })()`)
  const deleted = await waitFor(
    evaluate,
    `document.querySelectorAll('[data-testid="notification-item"]').length === 0`
  )
  check(deleted, 'delete-notification')
  const emptyText = await evaluate(`document.querySelector('[data-testid="message-center"]')?.innerText ?? ''`)
  check(emptyText.includes('暂无消息'), 'empty-state-after-delete', emptyText.slice(0, 120))

  // ---------- 6. 关闭抽屉 ----------
  await evaluate(`document.querySelector('[aria-label="关闭消息中心"]').click()`)
  check(
    await waitFor(evaluate, `!document.querySelector('[data-testid="message-center"]')`),
    'message-center-close'
  )

  if (appStderr.includes('[notification]')) {
    console.log(`NOTE daemon stderr: ${appStderr.split('\n').filter((l) => l.includes('[notification]')).join(' | ')}`)
  }
} catch (err) {
  failed++
  console.error(`ERROR ${(err).message}`)
  if (appStderr) console.error(appStderr.slice(-3000))
} finally {
  try {
    session?.ws.close()
  } catch {}
  app.kill()
  await sleep(800)
  await rm(workdir, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
}

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)

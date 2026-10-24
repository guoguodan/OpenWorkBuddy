/**
 * 任务列表分组验收:置顶 / 任务 / 工作空间 / 助理任务、折叠、查看更多、重命名。
 * 用法: node tests/e2e/verify-task-sections.mjs
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
const port = 9338
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
      res({ ws, evaluate, send })
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
    await sleep(200)
  }
  return false
}

const workdir = await mkdtemp(join(tmpdir(), 'owb-sections-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-sections-data-'))

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

  // 造 7 个普通任务,用来验证默认 5 条 + 查看更多。
  await evaluate(`(async () => {
    for (let i = 1; i <= 7; i++) {
      await window.openwb.conversation.create({ title: '分组任务 ' + i, mode: 'craft' })
    }
    const colleague = await window.openwb.colleagues.create({ name: '研究助理', title: '行业研究' })
    await window.openwb.conversation.create({
      title: '与助理协作',
      mode: 'craft',
      colleagueId: colleague.colleague.id
    })
  })()`)

  await evaluate(`location.reload()`)
  const reloaded = await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="welcome"]'))`, 40000)
  check(reloaded, 'reload-ready')
  await waitFor(evaluate, `document.querySelectorAll('[data-testid="conversation-item"]').length >= 5`)

  // ---------- 1. 分组标题 ----------
  const tasksSectionText = await evaluate(
    `document.querySelector('[data-testid="section-tasks"]')?.innerText ?? ''`
  )
  check(/任务 \(\d+\)/.test(tasksSectionText), 'tasks-section-label', tasksSectionText)
  const colleagueSectionShown = await evaluate(
    `Boolean(document.querySelector('[data-testid="section-colleagues"]'))`
  )
  check(colleagueSectionShown, 'colleague-section-shown')

  // ---------- 2. 默认 5 条 + 查看更多 ----------
  const visibleBefore = await evaluate(
    `document.querySelector('[data-testid="section-tasks"]').parentElement.querySelectorAll('[data-testid="conversation-item"]').length`
  )
  check(visibleBefore === 5, 'task-default-visible-five', String(visibleBefore))
  const taskTotal = await evaluate(
    `Number(/(\\d+)/.exec(document.querySelector('[data-testid="section-tasks"]').innerText)?.[1] ?? 0)`
  )
  const moreLabel = await evaluate(
    `document.querySelector('[data-testid="section-tasks"]').parentElement.querySelector('[data-testid="section-show-more"]')?.textContent ?? ''`
  )
  check(taskTotal > 5 && moreLabel.includes(`查看更多 (${taskTotal - 5})`), 'show-more-count', moreLabel)

  await evaluate(
    `document.querySelector('[data-testid="section-tasks"]').parentElement.querySelector('[data-testid="section-show-more"]').click()`
  )
  await sleep(300)
  const visibleAfter = await evaluate(
    `document.querySelector('[data-testid="section-tasks"]').parentElement.querySelectorAll('[data-testid="conversation-item"]').length`
  )
  check(visibleAfter === taskTotal, 'show-more-expands', String(visibleAfter))
  const lessShown = await evaluate(
    `Boolean(document.querySelector('[data-testid="section-tasks"]').parentElement.querySelector('[data-testid="section-show-less"]'))`
  )
  check(lessShown, 'show-less-visible')

  await evaluate(
    `document.querySelector('[data-testid="section-tasks"]').parentElement.querySelector('[data-testid="section-show-less"]').click()`
  )
  await sleep(300)
  check(
    (await evaluate(
      `document.querySelector('[data-testid="section-tasks"]').parentElement.querySelectorAll('[data-testid="conversation-item"]').length`
    )) === 5,
    'show-less-collapses'
  )

  // ---------- 3. 分组折叠 ----------
  await evaluate(`document.querySelector('[data-testid="section-tasks"]').click()`)
  await sleep(250)
  const tasksCollapsed = await evaluate(
    `document.querySelector('[data-testid="section-tasks"]').parentElement.querySelectorAll('[data-testid="conversation-item"]').length === 0`
  )
  check(tasksCollapsed, 'tasks-section-collapses')
  await evaluate(`document.querySelector('[data-testid="section-tasks"]').click()`)
  await sleep(250)
  check(
    (await evaluate(
      `document.querySelector('[data-testid="section-tasks"]').parentElement.querySelectorAll('[data-testid="conversation-item"]').length`
    )) > 0,
    'tasks-section-expands'
  )

  // ---------- 4. 右键置顶 ----------
  const firstTaskId = await evaluate(
    `document.querySelector('[data-testid="section-tasks"]').parentElement.querySelector('[data-testid="conversation-item"]').dataset.conversationId`
  )
  await evaluate(`(() => {
    const el = document.querySelector('[data-conversation-id="${firstTaskId}"]')
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.top + 10 }))
  })()`)
  check(await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="conversation-menu"]'))`), 'context-menu-open')
  const menuText = await evaluate(`document.querySelector('[data-testid="conversation-menu"]').innerText`)
  check(menuText.includes('置顶') && menuText.includes('重命名') && menuText.includes('删除任务'), 'context-menu-items', menuText)

  // 真实产品不在任务行内放删除按钮,删除只能从右键菜单进入。
  const inlineDelete = await evaluate(
    `document.querySelectorAll('[data-testid="conversation-item"] .owb-conv-item__del').length`
  )
  check(inlineDelete === 0, 'no-inline-delete-button', String(inlineDelete))

  await evaluate(
    `Array.from(document.querySelectorAll('[data-testid="conversation-menu"] button')).find((b) => b.textContent.includes('置顶')).click()`
  )
  const pinnedShown = await waitFor(
    evaluate,
    `Boolean(document.querySelector('[data-testid="section-pinned"]'))`
  )
  check(pinnedShown, 'pinned-section-appears')
  const pinnedHasItem = await evaluate(
    `document.querySelector('[data-testid="section-pinned"]').parentElement.querySelectorAll('[data-testid="conversation-item"]').length === 1`
  )
  check(pinnedHasItem, 'pinned-item-moved')

  // ---------- 5. 重命名 ----------
  await evaluate(`(() => {
    const el = document.querySelector('[data-testid="section-pinned"]').parentElement.querySelector('[data-testid="conversation-item"]')
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.top + 10 }))
  })()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="conversation-menu"]'))`)
  await evaluate(
    `Array.from(document.querySelectorAll('[data-testid="conversation-menu"] button')).find((b) => b.textContent.includes('重命名')).click()`
  )
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="conversation-rename-input"]'))`)
  await evaluate(`(() => {
    const input = document.querySelector('[data-testid="conversation-rename-input"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '置顶任务改名')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await evaluate(`(() => {
    const input = document.querySelector('[data-testid="conversation-rename-input"]')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })()`)
  const renamed = await waitFor(
    evaluate,
    `document.body.innerText.includes('置顶任务改名')`,
    8000
  )
  check(renamed, 'rename-applied')

  // ---------- 6. 助理任务分组 ----------
  const colleagueItem = await evaluate(
    `document.querySelector('[data-testid="section-colleagues"]').parentElement.innerText.includes('研究助理')`
  )
  check(colleagueItem, 'colleague-group-title')
  const colleagueConversations = await evaluate(
    `document.querySelector('[data-testid="section-colleagues"]').parentElement.querySelectorAll('[data-testid="conversation-item"]').length`
  )
  check(colleagueConversations === 1, 'colleague-group-has-task', String(colleagueConversations))

  // ---------- 7. 刷新后置顶仍保留 ----------
  await evaluate(`location.reload()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="welcome"]'))`, 40000)
  const pinPersisted = await waitFor(
    evaluate,
    `Boolean(document.querySelector('[data-testid="section-pinned"]'))`
  )
  check(pinPersisted, 'pin-persisted-after-reload')
  const titlePersisted = await evaluate(`document.body.innerText.includes('置顶任务改名')`)
  check(titlePersisted, 'rename-persisted-after-reload')

  // ---------- 8. 取消置顶 ----------
  await evaluate(`(() => {
    const el = document.querySelector('[data-testid="section-pinned"]').parentElement.querySelector('[data-testid="conversation-item"]')
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.top + 10 }))
  })()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="conversation-menu"]'))`)
  await evaluate(
    `Array.from(document.querySelectorAll('[data-testid="conversation-menu"] button')).find((b) => b.textContent.includes('取消置顶')).click()`
  )
  const unpinned = await waitFor(
    evaluate,
    `!document.querySelector('[data-testid="section-pinned"]')`,
    8000
  )
  check(unpinned, 'unpin-removes-section')
} catch (err) {
  failed++
  console.error(`FAIL 运行异常: ${err?.message ?? err}`)
  if (appStderr) console.error(appStderr.slice(-2000))
} finally {
  session?.ws.close()
  app.kill()
  await sleep(1200)
  await rm(workdir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 })
  await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 })
}

process.exit(failed === 0 ? 0 : 1)

/**
 * 任务筛选验收:真实菜单、状态多选、时间筛选、空态、重置、筛选点与持久化。
 * 用法: node tests/e2e/verify-task-filter.mjs
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
const port = 9346
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

const workdir = await mkdtemp(join(tmpdir(), 'owb-filter-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-filter-data-'))

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
  const { evaluate, send } = session
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="welcome"]'))`)

  // 筛选条件按产品设计会跨重启保留;验收必须先清掉上一次运行留下的状态,
  // 否则 beforeCount/空态断言会被旧条件污染。
  await evaluate(`localStorage.removeItem('owb.task.filter.v1')`)
  await evaluate(`location.reload()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="welcome"]'))`, 30000)

  // 造三类任务:已运行完成、有交付物、从未运行。
  await evaluate(`(async () => {
    for (const title of ['完成的任务', '带产物的任务', '另一个任务']) {
      await window.openwb.conversation.create({ title, mode: 'craft' })
    }
  })()`)
  await evaluate(`window.openwb.conversation.list()`)

  // 通过真实发送制造 task 行(已完成 + 交付物);mock 模型会写入文件。
  await evaluate(`(async () => {
    const list = await window.openwb.conversation.list()
    const target = list.conversations.find((c) => c.title === '带产物的任务')
    await window.openwb.conversation.send({
      conversationId: target.id,
      text: '请在工作区写一份 filter-proof.md 报告并交付,内容写 FILTER-PROOF',
      mode: 'craft'
    })
  })()`)

  const runDone = await waitFor(
    evaluate,
    `(async () => {
      const list = await window.openwb.conversation.list()
      const c = list.conversations.find((x) => x.title === '带产物的任务')
      return Boolean(c && (c.done ?? 0) > 0)
    })()`,
    60000
  )
  check(runDone, 'real-task-run-completed', appStderr.slice(-300))

  const stats = await evaluate(`(async () => {
    const list = await window.openwb.conversation.list()
    const c = list.conversations.find((x) => x.title === '带产物的任务')
    return { total: c?.taskTotal, done: c?.done, failed: c?.failed, artifacts: c?.artifacts }
  })()`)
  check(stats.total >= 1, 'summary-task-total-from-db', JSON.stringify(stats))
  check(stats.done >= 1, 'summary-done-from-db', JSON.stringify(stats))
  check(stats.artifacts >= 1, 'summary-artifacts-from-db', JSON.stringify(stats))

  // 打开真实筛选菜单;与真实产品一致,选择选项后菜单保持打开,不能盲目再次点击触发器。
  const ensureFilterMenu = async () => {
    const open = await evaluate(`Boolean(document.querySelector('[data-testid="task-filter-menu"]'))`)
    if (!open) await evaluate(`document.querySelector('[data-testid="open-filter"]').click()`)
    return waitFor(evaluate, `Boolean(document.querySelector('[data-testid="task-filter-menu"]'))`)
  }
  const menuReady = await ensureFilterMenu()
  check(menuReady, 'filter-menu-opens')

  const labels = await evaluate(
    `Array.from(document.querySelectorAll('.owb-task-filter__title')).map((e) => e.textContent.trim())`
  )
  check(JSON.stringify(labels) === JSON.stringify(['筛选状态', '筛选时间']), 'filter-sections', JSON.stringify(labels))
  const statusLabels = await evaluate(
    `Array.from(document.querySelectorAll('[data-testid^="filter-status-"]')).map((e) => e.textContent.trim())`
  )
  check(
    JSON.stringify(statusLabels) ===
      JSON.stringify(['全部状态', '进行中', '已完成', '失败', '待处理', '规划中']),
    'status-options-match-workbuddy',
    JSON.stringify(statusLabels)
  )
  const dateLabels = await evaluate(
    `Array.from(document.querySelectorAll('[data-testid^="filter-date-"]')).map((e) => e.textContent.trim())`
  )
  check(
    JSON.stringify(dateLabels) === JSON.stringify(['全部时间', '今天', '最近 7 天', '最近 30 天']),
    'date-options-match-workbuddy',
    JSON.stringify(dateLabels)
  )

  const beforeCount = await evaluate(
    `document.querySelectorAll('[data-testid="conversation-item"]').length`
  )
  check(beforeCount >= 3, 'all-conversations-visible-before-filter', String(beforeCount))

  // 单选"已完成"应只留已完成任务。
  await evaluate(`document.querySelector('[data-testid="filter-status-completed"]').click()`)
  await sleep(400)
  const completedCount = await evaluate(
    `document.querySelectorAll('[data-testid="conversation-item"]').length`
  )
  const completedTitles = await evaluate(
    `Array.from(document.querySelectorAll('[data-testid="conversation-item"]')).map((e) => e.textContent)`
  )
  check(completedCount === 1, 'status-completed-filters-list', JSON.stringify(completedTitles))
  check(completedTitles.join(' ').includes('带产物的任务'), 'completed-keeps-finished-task', JSON.stringify(completedTitles))
  check(Boolean(await evaluate(`Boolean(document.querySelector('[data-testid="filter-dot"]'))`)), 'filter-dot-shown')

  // 多选再加"规划中":带产物任务 + 未运行任务都应出现。
  await evaluate(`document.querySelector('[data-testid="filter-status-planning"]').click()`)
  await sleep(400)
  const multiCount = await evaluate(
    `document.querySelectorAll('[data-testid="conversation-item"]').length`
  )
  check(multiCount >= 3, 'status-multi-select-adds-results', String(multiCount))

  // 时间筛选"今天"应保留刚创建的任务。
  await evaluate(`document.querySelector('[data-testid="filter-date-today"]').click()`)
  await sleep(400)
  const todayCount = await evaluate(
    `document.querySelectorAll('[data-testid="conversation-item"]').length`
  )
  check(todayCount >= 1, 'date-today-keeps-today', String(todayCount))

  // 选"失败"并清掉规划中,应触发空态(没有失败任务)。
  await evaluate(`document.querySelector('[data-testid="filter-status-completed"]').click()`)
  await evaluate(`document.querySelector('[data-testid="filter-status-planning"]').click()`)
  await evaluate(`document.querySelector('[data-testid="filter-status-failed"]').click()`)
  await sleep(400)
  const emptyShown = await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="filter-empty"]'))`)
  check(emptyShown, 'empty-state-when-no-match')
  const emptyText = await evaluate(
    `document.querySelector('[data-testid="filter-empty"]')?.textContent ?? ''`
  )
  check(emptyText.includes('没有匹配的任务'), 'empty-state-copy', emptyText)

  // 重置按钮清空所有条件并恢复完整列表。
  await ensureFilterMenu()
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="filter-reset"]'))`)
  await evaluate(`document.querySelector('[data-testid="filter-reset"]').click()`)
  await sleep(500)
  const restored = await evaluate(
    `document.querySelectorAll('[data-testid="conversation-item"]').length`
  )
  check(restored === beforeCount, 'reset-restores-all', `${restored}/${beforeCount}`)
  check(!(await evaluate(`Boolean(document.querySelector('[data-testid="filter-dot"]'))`)), 'reset-clears-dot')

  // 持久化:设置条件后重载页面,筛选条件与点仍在。
  await ensureFilterMenu()
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="filter-status-completed"]'))`)
  await evaluate(`document.querySelector('[data-testid="filter-status-completed"]').click()`)
  await sleep(300)
  await evaluate(`location.reload()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="welcome"]'))`, 30000)
  const persisted = await waitFor(
    evaluate,
    `Boolean(document.querySelector('[data-testid="filter-dot"]'))`,
    15000
  )
  check(persisted, 'filter-persists-across-reload')

  // 截图留档。
  const shot = await send('Page.captureScreenshot', { format: 'png' }, 20000)
  if (shot.result?.data) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(tmpdir(), 'owb-task-filter.png'), Buffer.from(shot.result.data, 'base64'))
    console.log(`SHOT ${join(tmpdir(), 'owb-task-filter.png')}`)
  }
} catch (err) {
  failed++
  console.log(`FAIL harness ${err?.message ?? String(err)}`)
  if (appStderr.trim()) console.log(`daemon stderr: ${appStderr.trim().split('\n').slice(-8).join(' | ')}`)
} finally {
  try {
    session?.ws.close()
  } catch {}
  app.kill()
  await sleep(500)
  await rm(workdir, { recursive: true, force: true }).catch(() => undefined)
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
}

if (failed > 0) {
  console.log(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n任务筛选验收全部通过')

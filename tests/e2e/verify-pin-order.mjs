/**
 * 置顶任务拖拽排序验收:真实拖拽、落库顺序、刷新后保持、非法部分更新被拒绝。
 * 用法: node tests/e2e/verify-pin-order.mjs
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
const port = 9349
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

const workdir = await mkdtemp(join(tmpdir(), 'owb-pinorder-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-pinorder-data-'))

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

  // 三个任务按 A/B/C 顺序置顶,新置顶应追加到末尾。
  const ids = await evaluate(`(async () => {
    const created = []
    for (const title of ['排序A', '排序B', '排序C']) {
      const r = await window.openwb.conversation.create({ title, mode: 'craft' })
      created.push(r.conversationId)
    }
    for (const id of created) await window.openwb.conversation.pin({ conversationId: id, pinned: true })
    return created
  })()`)
  check(Array.isArray(ids) && ids.length === 3, 'three-tasks-pinned', JSON.stringify(ids))

  await evaluate(`location.reload()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="welcome"]'))`, 40000)
  const pinnedTitles = async () =>
    evaluate(
      `Array.from(document.querySelectorAll('[data-testid="section-pinned"]')?.[0]?.parentElement.querySelectorAll('[data-testid="conversation-item"]') ?? []).map((e) => e.querySelector('.owb-conv-item__title')?.textContent.trim().replace(/^\\s+/, ''))`
    )
  const initial = await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="section-pinned"]'))`)
  check(initial, 'pinned-section-visible')
  check(
    JSON.stringify(await pinnedTitles()) === JSON.stringify(['排序A', '排序B', '排序C']),
    'new-pins-append-to-end',
    JSON.stringify(await pinnedTitles())
  )

  // 真实 HTML5 拖拽:把 C 拖到 A 的位置。
  const dragShown = await evaluate(`(() => {
    const items = Array.from(
      document.querySelector('[data-testid="section-pinned"]').parentElement.querySelectorAll('[data-testid="conversation-item"]')
    )
    const byTitle = (title) => items.find((e) => e.textContent.includes(title))
    const source = byTitle('排序C')
    const target = byTitle('排序A')
    if (!source || !target) return false
    const data = new DataTransfer()
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }))
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }))
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: data }))
    return true
  })()`)
  check(dragShown === true, 'drag-events-dispatched')

  const reordered = await waitFor(
    evaluate,
    `JSON.stringify(Array.from(document.querySelector('[data-testid="section-pinned"]').parentElement.querySelectorAll('[data-testid="conversation-item"]')).map((e) => e.textContent)).includes('排序C') && Array.from(document.querySelector('[data-testid="section-pinned"]').parentElement.querySelectorAll('[data-testid="conversation-item"]'))[0].textContent.includes('排序C')`
  )
  check(reordered, 'drag-reorders-pinned-list', JSON.stringify(await pinnedTitles()))

  const persistedOrder = await evaluate(`(async () => {
    const list = await window.openwb.conversation.list()
    return list.conversations
      .filter((c) => c.pinnedAt)
      .sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0))
      .map((c) => c.title)
  })()`)
  check(
    JSON.stringify(persistedOrder) === JSON.stringify(['排序C', '排序A', '排序B']),
    'pin-order-persisted-in-db',
    JSON.stringify(persistedOrder)
  )

  const partialRejected = await evaluate(`(async () => {
    try {
      await window.openwb.conversation.reorderPinned(['${ids[0]}'])
      return 'accepted'
    } catch (err) {
      return String(err?.message ?? err)
    }
  })()`)
  check(partialRejected.includes('全部置顶任务'), 'partial-reorder-rejected', String(partialRejected))

  await evaluate(`location.reload()`)
  const reloadedOrder = await waitFor(
    evaluate,
    `JSON.stringify(Array.from(document.querySelector('[data-testid="section-pinned"]')?.parentElement?.querySelectorAll('[data-testid="conversation-item"]') ?? []).map((e) => e.querySelector('.owb-conv-item__title')?.textContent.trim().replace(/^\\s+/, ''))) === JSON.stringify(['排序C', '排序A', '排序B'])`,
    40000
  )
  check(reloadedOrder, 'drag-order-survives-reload', JSON.stringify(await pinnedTitles()))

  const shot = await send('Page.captureScreenshot', { format: 'png' }, 20000)
  if (shot.result?.data) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(tmpdir(), 'owb-pin-order.png'), Buffer.from(shot.result.data, 'base64'))
    console.log(`SHOT ${join(tmpdir(), 'owb-pin-order.png')}`)
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
console.log('\n置顶拖拽排序验收全部通过')

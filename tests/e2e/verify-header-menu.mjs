/**
 * 对话页头部验收:面包屑、任务操作菜单与侧栏状态同步。
 *
 * 覆盖:
 *   - 对话页头部展示 工作区/场景/标题 面包屑;
 *   - 下拉箭头是真实菜单,不是死图标;
 *   - 头部重命名写入数据库,面包屑与侧栏同时更新;
 *   - 头部置顶与侧栏置顶状态一致;
 *   - 头部删除任务后回到空态,且该任务不再出现在列表。
 *
 * 用法: node tests/e2e/verify-header-menu.mjs
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
const port = 9345
const endpoint = `http://127.0.0.1:${port}/json/list`
const oldTitle = '季度销售分析'
const newTitle = '季度销售复盘(已重命名)'

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

const workdir = await mkdtemp(join(tmpdir(), 'owb-header-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-header-data-'))
await writeFile(join(workdir, 'package.json'), '{"name":"header-ws"}\n', 'utf8')

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

  check(await waitFor(evaluate, `Boolean(document.querySelector('textarea[data-testid="composer-input"]'))`), 'composer-rendered')

  // 必须走界面的“新建任务”,让渲染层当前会话与 daemon 的 active 会话一致;
  // 直接调 conversation.create 只改 daemon,后续 send 可能落到另一条会话。
  await evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('.owb-sidebar__nav button')).find((x) => x.textContent.includes('新建任务'))
    if (!b) throw new Error('找不到新建任务')
    b.click(); return true
  })()`)
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('.owb-conv-item--active[data-conversation-id]'))`, 15000),
    'new-conversation-active'
  )

  // 首轮前通过侧栏菜单手动命名,验证自动标题不会覆盖用户标题。
  await evaluate(`(() => {
    const item = document.querySelector('.owb-conv-item--active')
    item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 240 }))
    return true
  })()`)
  check(await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="conversation-menu"]'))`), 'sidebar-menu-opens')
  await evaluate(`Array.from(document.querySelectorAll('[data-testid="conversation-menu"] button')).find((b) => b.textContent.includes('重命名')).click()`)
  check(await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="conversation-rename-input"]'))`), 'sidebar-rename-input')
  await evaluate(`(() => {
    const input = document.querySelector('[data-testid="conversation-rename-input"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(oldTitle)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  check(
    await waitFor(evaluate, `Array.from(document.querySelectorAll('.owb-conv-item__title')).some((e) => e.textContent.includes(${JSON.stringify(oldTitle)}))`, 15000),
    'manual-title-before-first-turn'
  )

  await evaluate(`(() => {
    const input = document.querySelector('textarea[data-testid="composer-input"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(input, '只回复 ok,不要修改文件')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('button[aria-label="发送"]').click()
    return true
  })()`)

  const headerReady = await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="header-menu-trigger"]'))`, 45000)
  check(headerReady, 'header-rendered')
  const crumbs = await evaluate(`document.querySelector('.owb-breadcrumb')?.innerText ?? ''`)
  check(crumbs.includes(oldTitle), 'manual-title-survives-first-turn', JSON.stringify(crumbs))
  check(crumbs.includes('默认'), 'breadcrumb-shows-scene', JSON.stringify(crumbs))

  const idle = await waitFor(
    evaluate,
    `!document.querySelector('.owb-composer__send--busy')`,
    60000
  )
  check(idle, 'turn-finished')

  await evaluate(`document.querySelector('[data-testid="header-menu-trigger"]').click()`)
  check(await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="header-menu"]'))`), 'header-menu-opens')
  const labels = await evaluate(
    `Array.from(document.querySelectorAll('[data-testid="header-menu"] button')).map((b) => b.textContent.trim())`
  )
  check(['重命名', '置顶', '删除任务'].every((x) => labels.some((l) => l.includes(x))), 'header-menu-actions', JSON.stringify(labels))

  // 重命名:必须走真实 IPC 落库,并且面包屑立即刷新。
  await evaluate(`Array.from(document.querySelectorAll('[data-testid="header-menu"] button')).find((b) => b.textContent.includes('重命名')).click()`)
  check(await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="header-rename-input"]'))`), 'inline-rename-input')
  await evaluate(`(() => {
    const input = document.querySelector('[data-testid="header-rename-input"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(newTitle)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  check(
    await waitFor(evaluate, `document.querySelector('[data-testid="header-title"]')?.textContent === ${JSON.stringify(newTitle)}`, 15000),
    'breadcrumb-title-updated'
  )
  const listTitle = await evaluate(
    `Array.from(document.querySelectorAll('.owb-conv-item__title')).map((e) => e.textContent.trim()).join(' | ')`
  )
  check(listTitle.includes(newTitle), 'sidebar-title-synced', JSON.stringify(listTitle))

  // 置顶:头部菜单文案应翻转,侧栏条目标记为已置顶。
  await evaluate(`document.querySelector('[data-testid="header-menu-trigger"]').click()`)
  await evaluate(`Array.from(document.querySelectorAll('[data-testid="header-menu"] button')).find((b) => b.textContent.includes('置顶')).click()`)
  check(
    await waitFor(
      evaluate,
      `Array.from(document.querySelectorAll('[data-testid="conversation-item"]')).some((x) => x.dataset.pinned === '1')`,
      15000
    ),
    'pin-applied'
  )
  await evaluate(`document.querySelector('[data-testid="header-menu-trigger"]').click()`)
  const pinnedMenu = await evaluate(`document.querySelector('[data-testid="header-menu"]')?.innerText ?? ''`)
  check(pinnedMenu.includes('取消置顶'), 'header-menu-reflects-pin', JSON.stringify(pinnedMenu))
  await evaluate(`document.querySelector('[data-testid="header-menu-trigger"]').click()`)

  // 删除:确认后界面必须离开该会话,而不是留下一个指向已删 ID 的头部。
  await evaluate(`document.querySelector('[data-testid="header-menu-trigger"]').click()`)
  await evaluate(`Array.from(document.querySelectorAll('[data-testid="header-menu"] button')).find((b) => b.textContent.includes('删除任务')).click()`)
  check(
    await waitFor(evaluate, `!document.querySelector('[data-testid="header-menu-trigger"]')`, 20000),
    'header-cleared-after-delete'
  )
  const remaining = await evaluate(
    `Array.from(document.querySelectorAll('.owb-conv-item__title')).map((e) => e.textContent.trim()).join(' | ')`
  )
  check(!remaining.includes(newTitle), 'deleted-task-removed-from-sidebar', JSON.stringify(remaining))
} catch (err) {
  failed++
  console.error(`FAIL 运行异常: ${err?.message ?? err}`)
} finally {
  try {
    client?.ws.close()
  } catch {}
  app.kill()
  await Promise.race([new Promise((r) => app.on('exit', r)), sleep(3000)])
  if (failed > 0 && appStderr.trim()) {
    console.log(`--- app stderr ---\n${appStderr.trim().split('\n').slice(-15).join('\n')}`)
  }
  await rm(workdir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }).catch(() => undefined)
  await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }).catch(() => undefined)
}

process.exit(failed === 0 ? 0 : 1)

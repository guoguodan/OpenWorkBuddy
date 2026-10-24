/**
 * 工作空间子分组验收:文件夹图标、缩进、单个/全部折叠、持久化、筛选计数。
 * 用法: node tests/e2e/verify-workspace-groups.mjs
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
const port = 9347
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

const workdir = await mkdtemp(join(tmpdir(), 'owb-ws-groups-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-ws-groups-data-'))

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
  await evaluate(`localStorage.removeItem('owb.sidebar.sections.v1')`)

  // 两个工作空间,一个 7 条任务(验证默认 5 条 + 查看更多),一个 2 条。
  await evaluate(`(async () => {
    const brand = await window.openwb.channel.create({ name: '品牌空间' })
    const product = await window.openwb.channel.create({ name: '产品空间' })
    for (let i = 1; i <= 7; i++) {
      await window.openwb.conversation.create({ title: '品牌任务 ' + i, mode: 'craft', channelId: brand.channel.id })
    }
    for (let i = 1; i <= 2; i++) {
      await window.openwb.conversation.create({ title: '产品任务 ' + i, mode: 'craft', channelId: product.channel.id })
    }
    await window.openwb.conversation.create({ title: '独立任务', mode: 'craft' })
  })()`)
  await evaluate(`location.reload()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="welcome"]'))`, 40000)
  check(
    await waitFor(evaluate, `document.querySelectorAll('[data-workspace-group]').length === 2`),
    'two-workspace-groups'
  )
  const totalBeforeFilter = await evaluate(
    `document.querySelectorAll('[data-testid="conversation-item"]').length`
  )

  const sectionText = await evaluate(
    `document.querySelector('[data-testid="section-workspaces"]')?.innerText ?? ''`
  )
  check(sectionText.includes('工作空间 (2)'), 'workspace-section-count', sectionText)

  // ---------- 1. 文件夹图标 ----------
  const folderIcons = await evaluate(
    `document.querySelectorAll('[data-workspace-group] .owb-sidebar__folder-icon svg').length`
  )
  check(folderIcons === 2, 'workspace-folder-icons', String(folderIcons))
  const folderIconInPopover = await evaluate(`(() => {
    document.querySelector('.owb-topbar__btn[title="收起侧边栏"]').click()
    return true
  })()`)
  check(folderIconInPopover, 'collapse-sidebar')
  await sleep(350)
  await evaluate(`document.querySelector('[data-testid="task-list-trigger"]').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="task-list-popover"]'))`)
  const popoverFolderIcons = await evaluate(
    `document.querySelectorAll('[data-testid="task-list-popover"] .owb-task-popover__folder-icon').length`
  )
  check(popoverFolderIcons === 2, 'popover-folder-icons', String(popoverFolderIcons))
  await evaluate(`document.querySelector('.owb-topbar__btn[title="展开侧边栏"]').click()`)
  await sleep(350)

  // ---------- 2. 缩进与子任务层级 ----------
  const indent = await evaluate(`(() => {
    const group = document.querySelector('[data-workspace-group]')
    const header = group.querySelector('.owb-sidebar__section').getBoundingClientRect()
    const topHeader = document.querySelector('[data-testid="section-tasks"]').getBoundingClientRect()
    const tasksSection = document.querySelector('[data-testid="section-tasks"]').parentElement
    const topIcon = tasksSection.querySelector('[data-testid="conversation-item"] .owb-conv-item__icon')
    const icon = group.querySelector('.owb-sidebar__folder-icon').getBoundingClientRect()
    return {
      headerDelta: header.left - topHeader.left,
      iconDelta: icon.left - topHeader.left,
      topTaskLeft: topIcon ? topIcon.getBoundingClientRect().left - topHeader.left : null,
      taskLeft: group.querySelector('[data-testid="conversation-item"]').getBoundingClientRect().left - topHeader.left
    }
  })()`)
  check(indent.iconDelta >= 8, 'subgroup-indented', JSON.stringify(indent))
  check(indent.taskLeft > indent.iconDelta, 'subgroup-task-further-indented', JSON.stringify(indent))

  // ---------- 3. 默认 5 条 + 分组内查看更多 ----------
  const brandId = await evaluate(`(() => {
    const groups = Array.from(document.querySelectorAll('[data-workspace-group]'))
    return groups.find((g) => g.textContent.includes('品牌空间'))?.getAttribute('data-workspace-group') ?? ''
  })()`)
  check(Boolean(brandId), 'brand-group-found', brandId)
  const brandGroup = `document.querySelector('[data-workspace-group="${brandId}"]')`
  const brandVisible = await evaluate(
    `${brandGroup}.querySelectorAll('[data-testid="conversation-item"]').length`
  )
  check(brandVisible === 5, 'workspace-default-visible-five', String(brandVisible))
  const moreText = await evaluate(
    `${brandGroup}.querySelector('[data-testid="section-show-more"]')?.textContent ?? ''`
  )
  check(moreText.includes('查看更多 (2)'), 'workspace-show-more-count', moreText)
  await evaluate(`${brandGroup}.querySelector('[data-testid="section-show-more"]').click()`)
  await sleep(300)
  check(
    (await evaluate(`${brandGroup}.querySelectorAll('[data-testid="conversation-item"]').length`)) === 7,
    'workspace-show-more-expands'
  )

  // ---------- 4. 单个子分组折叠 ----------
  await evaluate(`${brandGroup}.querySelector('[data-testid="conversation-subsection"]').click()`)
  await sleep(250)
  check(
    (await evaluate(`${brandGroup}.querySelectorAll('[data-testid="conversation-item"]').length`)) === 0,
    'subgroup-collapses'
  )
  const arrowExpanded = await evaluate(
    `${brandGroup}.querySelector('[data-testid="conversation-subsection"]').getAttribute('aria-expanded')`
  )
  check(arrowExpanded === 'false', 'subgroup-aria-expanded-false', arrowExpanded)
  await evaluate(`${brandGroup}.querySelector('[data-testid="conversation-subsection"]').click()`)
  await sleep(250)
  check(
    (await evaluate(`${brandGroup}.querySelectorAll('[data-testid="conversation-item"]').length`)) === 7,
    'subgroup-expands'
  )

  // ---------- 5. 全部折叠 / 展开 ----------
  await evaluate(`document.querySelector('[data-testid="toggle-all-workspaces"]').click()`)
  await sleep(300)
  const allCollapsed = await evaluate(
    `Array.from(document.querySelectorAll('[data-workspace-group]')).every((g) => g.querySelectorAll('[data-testid="conversation-item"]').length === 0)`
  )
  check(allCollapsed, 'collapse-all-workspaces')
  const toggleLabel = await evaluate(
    `document.querySelector('[data-testid="toggle-all-workspaces"]').getAttribute('title')`
  )
  check(toggleLabel === '展开所有工作空间', 'toggle-all-label-adapts', toggleLabel)
  await evaluate(`document.querySelector('[data-testid="toggle-all-workspaces"]').click()`)
  await sleep(300)
  check(
    await evaluate(
      `Array.from(document.querySelectorAll('[data-workspace-group]')).every((g) => g.querySelectorAll('[data-testid="conversation-item"]').length > 0)`
    ),
    'expand-all-workspaces'
  )

  // ---------- 6. 折叠状态刷新后保留 ----------
  await evaluate(`${brandGroup}.querySelector('[data-testid="conversation-subsection"]').click()`)
  await sleep(250)
  const savedCollapsed = await evaluate(
    `JSON.parse(localStorage.getItem('owb.sidebar.sections.v1') || '{}').collapsedGroups?.['ws:${brandId}']`
  )
  check(savedCollapsed === true, 'subgroup-state-saved', String(savedCollapsed))
  await evaluate(`location.reload()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="welcome"]'))`, 40000)
  const persisted = await waitFor(
    evaluate,
    `document.querySelector('[data-workspace-group="${brandId}"]')?.querySelectorAll('[data-testid="conversation-item"]').length === 0`
  )
  check(persisted, 'subgroup-collapse-persists')
  await evaluate(`${brandGroup}.querySelector('[data-testid="conversation-subsection"]').click()`)
  await sleep(250)

  // ---------- 7. 筛选后分组计数一致 ----------
  await evaluate(`document.querySelector('[data-testid="open-filter"]').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="task-filter-menu"]'))`)
  await evaluate(`document.querySelector('[data-testid="filter-status-planning"]').click()`)
  await sleep(400)
  const filteredCount = await evaluate(
    `document.querySelectorAll('[data-testid="conversation-item"]').length`
  )
  const filteredSection = await evaluate(
    `document.querySelector('[data-testid="section-workspaces"]')?.innerText ?? ''`
  )
  const filteredTitles = await evaluate(
    `Array.from(document.querySelectorAll('[data-testid="conversation-item"]')).map((e) => e.dataset.conversationId)`
  )
  const expectedPlanning = await evaluate(`(async () => {
    const list = await window.openwb.conversation.list()
    return list.conversations.filter((c) => (c.taskTotal ?? 0) === 0 && (c.messageCount ?? 0) === 0).map((c) => c.id)
  })()`)
  const uniqueTitles = new Set(filteredTitles)
  check(
    uniqueTitles.size === filteredTitles.length,
    'filter-no-duplicate-items',
    JSON.stringify(filteredTitles)
  )
  check(
    filteredTitles.length > 0 && filteredTitles.every((id) => expectedPlanning.includes(id)),
    'filter-keeps-planning-workspace-tasks',
    `${filteredTitles.length}/${expectedPlanning.length}`
  )
  check(filteredSection.includes('工作空间 (2)'), 'filtered-workspace-count', filteredSection)
  await evaluate(`document.querySelector('[data-testid="filter-status-all"]').click()`)
  await sleep(300)

  const shot = await send('Page.captureScreenshot', { format: 'png' }, 20000)
  if (shot.result?.data) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(tmpdir(), 'owb-workspace-groups.png'), Buffer.from(shot.result.data, 'base64'))
    console.log(`SHOT ${join(tmpdir(), 'owb-workspace-groups.png')}`)
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
console.log('\n工作空间子分组验收全部通过')

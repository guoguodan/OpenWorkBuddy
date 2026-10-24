/**
 * 项目页验收:对齐 WorkBuddy 项目列表的真实结构与交互。
 *
 * 覆盖:
 *   标题/副标题、我的项目与搜索、空状态、新建项目对话框(名称/模板/指令/技能)、
 *   模板切换覆盖指令、网格卡片字段、更多操作菜单、重命名、置顶、删除确认、
 *   点击卡片进入项目任务、项目任务计数、搜索、刷新后保留。
 *
 * 用法: node tests/e2e/verify-projects-page.mjs
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
const port = 9351
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

const workdir = await mkdtemp(join(tmpdir(), 'owb-projects-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-projects-data-'))

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

  const openProjects = async () => {
    await evaluate(`document.querySelector('[data-testid="open-more"]').click()`)
    await waitFor(evaluate, `Boolean(document.querySelector('.owb-more__menu'))`)
    await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll('.owb-more__menu button')).find((x) => x.textContent.includes('项目'))
      if (!b) {
        throw new Error('缺少项目入口 | ' + Array.from(document.querySelectorAll('.owb-more__menu button')).map((x) => x.textContent.trim()).join(' / '))
      }
      b.click()
    })()`)
    await waitFor(evaluate, `Boolean(document.querySelector('[role="dialog"][aria-label="项目"]'))`)
  }
  const fill = async (selector, value, kind = 'input') => {
    await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) throw new Error('缺少字段 ' + ${JSON.stringify(selector)})
      const proto = ${kind === 'textarea' ? 'window.HTMLTextAreaElement' : 'window.HTMLInputElement'}.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await sleep(60)
  }
  const clickMenu = async (text) => {
    await evaluate(`document.querySelector('[data-testid="project-more"]').click()`)
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="project-menu"]'))`)
    await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll('[data-testid="project-menu"] button')).find((x) => x.textContent.trim() === ${JSON.stringify(text)})
      if (!b) throw new Error('缺少菜单项 ' + ${JSON.stringify(text)})
      b.click()
    })()`)
    await sleep(200)
  }

  // ---------- 1. 空状态与真实文案 ----------
  await openProjects()
  const headerText = await evaluate(
    `document.querySelector('[role="dialog"][aria-label="项目"]')?.innerText ?? ''`
  )
  check(headerText.includes('项目') && headerText.includes('多人协同，打造超级团队'), 'projects-header-copy', headerText.slice(0, 120))
  check(headerText.includes('我的项目'), 'projects-section-title')
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="project-empty"]'))`)
  const emptyText = await evaluate(
    `document.querySelector('[data-testid="project-empty"]')?.innerText ?? ''`
  )
  check(emptyText.includes('创建你的第一个项目'), 'projects-empty-title', emptyText)
  check(emptyText.includes('共享团队上下文，让成员与 AI 协同共创'), 'projects-empty-subtitle')
  const searchPlaceholder = await evaluate(
    `document.querySelector('[data-testid="project-search"]')?.getAttribute('placeholder')`
  )
  check(searchPlaceholder === '搜索项目', 'projects-search-placeholder', String(searchPlaceholder))

  // ---------- 2. 新建项目对话框:真实字段与模板 ----------
  await evaluate(`document.querySelector('[data-testid="project-create"]').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="project-form"]'))`)
  const formText = await evaluate(`document.querySelector('[data-testid="project-form"]')?.innerText ?? ''`)
  check(formText.includes('项目名称') && formText.includes('项目模板') && formText.includes('指令'), 'project-form-fields', formText.slice(0, 160))
  check(formText.includes('技能'), 'project-form-skills')
  const templates = await evaluate(
    `Array.from(document.querySelectorAll('[data-testid^="project-template-"]')).map((e) => e.textContent.trim())`
  )
  check(
    ['自定义', '产品需求全流程', '市场调研与竞品分析', '内容运营工作台', '团队知识库', '项目交付', 'Bug 跟踪/测试验收'].every((name) => templates.some((t) => t.includes(name))),
    'project-templates-match-workbuddy',
    JSON.stringify(templates)
  )
  check(
    await evaluate(`document.querySelector('[data-testid="project-form"]')?.innerText.includes('切换模版会覆盖当前编辑内容')`),
    'project-template-version-note'
  )

  // 模板切换会覆盖指令
  await fill('[data-testid="project-instructions"]', '自定义初始指令', 'textarea')
  await evaluate(`document.querySelector('[data-testid="project-template-productRequirements"]').click()`)
  await sleep(150)
  const afterTemplate = await evaluate(
    `document.querySelector('[data-testid="project-instructions"]')?.value ?? ''`
  )
  check(afterTemplate.includes('产品需求全流程协同助手') && !afterTemplate.includes('自定义初始指令'), 'template-overwrites-instructions', afterTemplate.slice(0, 80))
  await evaluate(`document.querySelector('[data-testid="project-template-custom"]').click()`)
  await sleep(80)
  check(
    await evaluate(`document.querySelector('[data-testid="project-template-custom"]')?.getAttribute('aria-pressed') === 'true'`),
    'template-custom-selected'
  )
  check(
    (await evaluate(`document.querySelector('[data-testid="project-instructions"]')?.value ?? ''`)) === '',
    'template-custom-clears-instructions'
  )

  await fill('[data-testid="project-name"]', '企业级 AI 工作台')
  await fill('[data-testid="project-instructions"]', '先对照竞品，再给出取舍；结论必须带依据。', 'textarea')
  await evaluate(`document.querySelector('[data-testid="project-save"]').click()`)
  const created = await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="project-card"]'))`)
  check(created, 'project-created')
  const projectId = await evaluate(`document.querySelector('[data-testid="project-card"]')?.dataset.projectId`)
  check(!!projectId, 'project-has-id', String(projectId))

  // ---------- 3. 卡片结构 ----------
  const cardText = await evaluate(`document.querySelector('[data-testid="project-card"]')?.innerText ?? ''`)
  check(cardText.includes('企业级 AI 工作台'), 'project-card-title', cardText)
  check(cardText.includes('添加于'), 'project-card-added-at', cardText)
  check(cardText.includes('0 个任务'), 'project-card-task-count', cardText)
  const grid = await evaluate(
    `getComputedStyle(document.querySelector('[data-testid="project-grid"]')).display`
  )
  check(grid === 'grid', 'project-grid-layout', grid)

  // ---------- 4. 创建第二个项目并置顶 ----------
  await evaluate(`document.querySelector('[data-testid="project-create"]').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="project-form"]'))`)
  await fill('[data-testid="project-name"]', '团队知识库项目')
  await evaluate(`document.querySelector('[data-testid="project-save"]').click()`)
  const twoCards = await waitFor(
    evaluate,
    `document.querySelectorAll('[data-testid="project-card"]').length === 2`
  )
  check(twoCards, 'two-projects-listed')

  const cardByText = (name) =>
    `Array.from(document.querySelectorAll('[data-testid="project-card"]')).find((c) => c.innerText.includes(${JSON.stringify(name)}))`
  await evaluate(`${cardByText('企业级 AI 工作台')}.querySelector('[data-testid="project-more"]').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="project-menu"]'))`)
  await evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('[data-testid="project-menu"] button')).find((x) => x.textContent.trim() === '置顶')
    b.click()
  })()`)
  const pinned = await waitFor(
    evaluate,
    `${cardByText('企业级 AI 工作台')}.innerText.includes('已置顶')`
  )
  check(pinned, 'project-pinned-badge')

  // ---------- 5. 更多操作菜单项 ----------
  await evaluate(`${cardByText('企业级 AI 工作台')}.querySelector('[data-testid="project-more"]').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="project-menu"]'))`)
  const menuItems = await evaluate(
    `Array.from(document.querySelectorAll('[data-testid="project-menu"] button')).map((b) => b.textContent.trim())`
  )
  check(
    JSON.stringify(menuItems) === JSON.stringify(['重命名', '取消置顶', '删除']),
    'project-menu-items',
    JSON.stringify(menuItems)
  )
  await evaluate(`document.querySelector('[data-testid="project-menu"] button').click()`)
  const renameOpen = await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="project-rename-input"]'))`)
  check(renameOpen, 'project-rename-dialog')
  const originalName = await evaluate(
    `document.querySelector('[data-testid="project-rename-input"]')?.closest('[role="dialog"]')?.innerText ?? ''`
  )
  check(originalName.includes('原名称：'), 'project-rename-shows-original', originalName)
  await fill('[data-testid="project-rename-input"]', '企业级 AI 工作台 Pro')
  await evaluate(`document.querySelector('[data-testid="project-rename-save"]').click()`)
  const renamed = await waitFor(
    evaluate,
    `Boolean(${cardByText('企业级 AI 工作台 Pro')}) && !document.querySelector('[data-testid="project-rename-input"]')`
  )
  check(renamed, 'project-renamed')

  // ---------- 6. 删除确认 ----------
  await evaluate(`${cardByText('企业级 AI 工作台 Pro')}.querySelector('[data-testid="project-more"]').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="project-menu"]'))`)
  await evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('[data-testid="project-menu"] button')).find((x) => x.textContent.trim() === '删除')
    b.click()
  })()`)
  const deleteOpen = await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="project-delete-confirm"]'))`)
  check(deleteOpen, 'project-delete-dialog')
  const deleteText = await evaluate(
    `document.querySelector('[data-testid="project-delete-confirm"]')?.closest('[role="dialog"]')?.innerText ?? ''`
  )
  check(
    deleteText.includes('删除后项目将被永久删除，包括项目内所有任务及产物，且不可恢复'),
    'project-delete-warning',
    deleteText
  )
  await evaluate(`document.querySelector('[data-testid="project-delete-confirm"]').click()`)
  const deleted = await waitFor(
    evaluate,
    `document.querySelectorAll('[data-testid="project-card"]').length === 1`
  )
  check(deleted, 'project-deleted')

  // ---------- 7. 搜索 ----------
  await fill('[data-testid="project-search"]', '知识库')
  check(
    await waitFor(
      evaluate,
      `document.querySelectorAll('[data-testid="project-card"]').length === 1 && document.querySelector('[data-testid="project-card"]').innerText.includes('团队知识库项目')`
    ),
    'project-search-filters'
  )
  await fill('[data-testid="project-search"]', '不存在的项目')
  await sleep(250)
  check(
    await evaluate(`document.querySelector('[data-testid="project-empty"]')?.innerText.includes('没有匹配的项目')`),
    'project-search-empty'
  )
  await fill('[data-testid="project-search"]', '')
  await sleep(200)

  // ---------- 8. 点击卡片进入项目任务 ----------
  await evaluate(`${cardByText('团队知识库项目')}.querySelector('.owb-project-tile__main').click()`)
  const projectTask = await waitFor(
    evaluate,
    `!document.querySelector('[role="dialog"][aria-label="项目"]')`
  )
  check(projectTask, 'project-card-opens-project-task')
  const bound = await evaluate(`(async () => {
    const list = await window.openwb.conversation.list()
    const conv = list.conversations.find((c) => c.title.includes('团队知识库项目'))
    const projects = await window.openwb.projects.list()
    const project = projects.projects.find((p) => p.name === '团队知识库项目')
    return {
      projectId: conv?.projectId ?? null,
      expected: project?.id ?? null,
      taskCount: project?.stats.taskCount ?? 0,
      title: conv?.title ?? null
    }
  })()`)
  check(bound.projectId === bound.expected, 'project-task-bound-to-project', JSON.stringify(bound))
  check(bound.taskCount === 1, 'project-task-count-updated', JSON.stringify(bound))

  // ---------- 9. 刷新后保留 ----------
  await evaluate(`location.reload()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="welcome"]'))`, 40000)
  await openProjects()
  const persisted = await waitFor(
    evaluate,
    `Boolean(${cardByText('团队知识库项目')})`
  )
  check(persisted, 'project-persists-after-reload')
  const persistedCount = await evaluate(
    `document.querySelector('[data-testid="project-card"]')?.innerText.match(/(\\d+) 个任务/)?.[1] ?? ''`
  )
  check(persistedCount === '1', 'project-task-count-persists', persistedCount)

  const shot = await send('Page.captureScreenshot', { format: 'png' }, 20000)
  if (shot.result?.data) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(tmpdir(), 'owb-projects-page.png'), Buffer.from(shot.result.data, 'base64'))
    console.log(`SHOT ${join(tmpdir(), 'owb-projects-page.png')}`)
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
console.log('\n项目页验收全部通过')

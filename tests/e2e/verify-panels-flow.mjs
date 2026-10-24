/**
 * 新面板闭环验收:助理创建/指派、定时任务增删启停、资料库交付物聚合、
 * 场景与 @ 上下文注入是否真的进入运行链。
 * 用法: node tests/e2e/verify-panels-flow.mjs
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
const port = 9336
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

const workdir = await mkdtemp(join(tmpdir(), 'owb-panels-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-panels-data-'))
await writeFile(join(workdir, 'note.md'), '# 需求说明\n\nPANELS-CONTEXT-MARKER\n', 'utf8')

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

  const setInput = async (text) => {
    await evaluate(`(() => {
      const input = document.querySelector('textarea[data-testid="composer-input"]')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(text)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await sleep(120)
  }
  const isBusy = () =>
    evaluate(`Boolean(document.querySelector('.owb-composer__send--busy, .owb-content-header__running'))`)
  const waitIdle = async (timeoutMs = 60000) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (!(await isBusy())) return true
      await sleep(300)
    }
    return false
  }
  const send = async (text) => {
    await setInput(text)
    await evaluate(`document.querySelector('button[aria-label="发送"]').click()`)
    await sleep(400)
  }

  // ---------- 1. 场景提示生效 ----------
  await evaluate(`document.querySelector('.owb-scene-tab[data-scene="coding"]').click()`)
  await sleep(200)
  const codingSelected = await evaluate(
    `document.querySelector('.owb-scene-tab[data-scene="coding"]')?.getAttribute('aria-selected')`
  )
  check(codingSelected === 'true', 'scene-switch-selected', String(codingSelected))
  await send('只回复场景校验,不要写文件')
  const sceneIdle = await waitIdle()
  const sceneBody = await evaluate(`document.body.innerText`)
  check(sceneIdle, 'scene-run-finished')
  check(sceneBody.includes('只回复场景校验'), 'scene-run-echo', sceneBody.slice(-200))

  // ---------- 2. @ 上下文真的注入 ----------
  await evaluate(`document.querySelector('[data-testid="new-task"]').click()`)
  await sleep(500)
  await send('@note.md 只说明收到了几个文件,不要写文件')
  const ctxIdle = await waitIdle()
  const ctxBody = await evaluate(`document.body.innerText`)
  check(ctxIdle, 'context-run-finished')
  check(/已附加 1 个文件/.test(ctxBody), 'context-attached-notice', (ctxBody.match(/已附加[^\n]*/) ?? [''])[0])

  // ---------- 3. 助理创建 → 指派 → 人设入会话 ----------
  await evaluate(`document.querySelector('[data-testid="open-colleagues"]').click()`)
  await waitFor(
    evaluate,
    `Boolean(document.querySelector('[role="dialog"][aria-label="助理协作空间"]') && document.querySelector('[data-testid="colleague-create"]'))`
  )
  await evaluate(`(() => {
    document.querySelector('[data-testid="colleague-create"]').click()
  })()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="colleague-form"] input'))`)
  const fillLabel = (label, value) =>
    evaluate(`(() => {
      const field = Array.from(document.querySelectorAll('[data-testid="colleague-form"] label')).find((l) => l.textContent.trim().startsWith(${JSON.stringify(label)}))
      const el = field.querySelector('input,textarea')
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
  await fillLabel('名称', '验收助理')
  await fillLabel('职能', '验收')
  await fillLabel('工作准则', '回答必须以 VERIFY-RULE 开头')
  await evaluate(`document.querySelector('[data-testid="colleague-next"]').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="colleague-wizard-config"]'))`)
  await evaluate(`document.querySelector('[data-testid="colleague-save"]').click()`)
  const created = await waitFor(
    evaluate,
    `Array.from(document.querySelectorAll('[data-testid="colleague-card"]')).some((c) => c.textContent.includes('验收助理'))`
  )
  check(created, 'colleague-created')
  await evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('[data-testid="colleague-card"]')).find((c) => c.textContent.includes('验收助理'))
    card.querySelector('[data-testid="colleague-assign"]').click()
  })()`)
  await sleep(800)
  const assignedText = await evaluate(`document.body.innerText`)
  check(/正在与助理「验收助理」协作/.test(assignedText), 'colleague-assigned-banner')
  await send('确认人设已加载')
  await waitIdle()
  const assignedReply = await evaluate(`document.body.innerText`)
  check(assignedReply.includes('确认人设已加载'), 'colleague-run-finished')

  // ---------- 4. 定时任务 CRUD ----------
  await evaluate(`document.querySelector('[data-testid="open-automation"]').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[role="dialog"][aria-label="定时任务"]'))`)
  await evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('[role="dialog"][aria-label="定时任务"] button')).find((x) => x.textContent.includes('新建定时任务'))
    b.click()
  })()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[role="dialog"][aria-label="定时任务"] input'))`)
  const autoFill = (label, value) =>
    evaluate(`(() => {
      const field = Array.from(document.querySelectorAll('[role="dialog"][aria-label="定时任务"] label')).find((l) => l.textContent.trim().startsWith(${JSON.stringify(label)}))
      const el = field.querySelector('input,textarea')
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
  await autoFill('任务名称', '验收每日任务')
  await autoFill('执行指令', '输出今日进展')
  await evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('[role="dialog"][aria-label="定时任务"] button')).find((x) => x.textContent.trim() === '创建')
    b.click()
  })()`)
  const autoCreated = await waitFor(
    evaluate,
    `Array.from(document.querySelectorAll('[role="dialog"][aria-label="定时任务"] .owb-card')).some((c) => c.textContent.includes('验收每日任务'))`
  )
  const autoCardText = await evaluate(
    `Array.from(document.querySelectorAll('[role="dialog"][aria-label="定时任务"] .owb-card')).find((c) => c.textContent.includes('验收每日任务'))?.innerText ?? ''`
  )
  check(autoCreated, 'automation-created', autoCardText)
  check(autoCardText.includes('每天') && autoCardText.includes('已启用'), 'automation-schedule-shown', autoCardText)

  await evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('[role="dialog"][aria-label="定时任务"] .owb-card')).find((c) => c.textContent.includes('验收每日任务'))
    const b = Array.from(card.querySelectorAll('button')).find((x) => x.textContent.includes('暂停'))
    b.click()
  })()`)
  const paused = await waitFor(
    evaluate,
    `Array.from(document.querySelectorAll('[role="dialog"][aria-label="定时任务"] .owb-card')).some((c) => c.textContent.includes('已暂停'))`
  )
  check(paused, 'automation-paused')

  await evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('[role="dialog"][aria-label="定时任务"] .owb-card')).find((c) => c.textContent.includes('验收每日任务'))
    const b = Array.from(card.querySelectorAll('button')).find((x) => x.textContent.includes('删除'))
    window.confirm = () => true
    b.click()
  })()`)
  const deleted = await waitFor(
    evaluate,
    `!document.querySelector('[role="dialog"][aria-label="定时任务"]')?.innerText.includes('验收每日任务')`
  )
  check(deleted, 'automation-deleted')
  await evaluate(`document.querySelector('[aria-label="关闭定时任务"]').click()`)
  await sleep(300)

  // ---------- 5. 资料库聚合交付物 ----------
  await evaluate(`document.querySelector('[data-testid="new-task"]').click()`)
  await sleep(500)
  await send('生成一份资料库验收报告并交付')
  await waitIdle()
  const deliveryBody = await evaluate(`document.body.innerText`)
  check(/mock-report\.md/.test(deliveryBody), 'delivery-created', deliveryBody.slice(-200))

  await evaluate(`document.querySelector('[data-testid="open-library"]').click()`)
  const libReady = await waitFor(
    evaluate,
    `Boolean(document.querySelector('[role="dialog"][aria-label="资料库"] .owb-card'))`
  )
  const libText = await evaluate(
    `document.querySelector('[role="dialog"][aria-label="资料库"]')?.innerText ?? ''`
  )
  check(libReady, 'library-has-artifact', libText.slice(0, 200))
  check(libText.includes('Mock 报告'), 'library-title-shown', libText.slice(0, 200))
  check(/mock-report\.md/.test(libText), 'library-path-shown', libText.slice(0, 200))

  // 搜索过滤
  await evaluate(`(() => {
    const input = document.querySelector('[role="dialog"][aria-label="资料库"] input[aria-label="搜索资料"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '不存在的关键词')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  const filteredEmpty = await waitFor(
    evaluate,
    `(document.querySelector('[role="dialog"][aria-label="资料库"]')?.innerText ?? '').includes('没有匹配的资料')`
  )
  check(filteredEmpty, 'library-search-filters')
  await evaluate(`document.querySelector('[aria-label="关闭资料库"]').click()`)
} catch (err) {
  failed++
  console.error(`FAIL 运行异常: ${err?.message ?? err}`)
  if (appStderr) console.error(appStderr.split('\n').slice(-25).join('\n'))
} finally {
  session?.ws.close()
  app.kill()
  await sleep(1200)
  await rm(workdir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 })
  await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 })
}

process.exit(failed === 0 ? 0 : 1)

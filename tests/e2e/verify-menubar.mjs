/**
 * 菜单栏验收:文件/编辑/视图/帮助四个菜单、文件菜单动作与 Ctrl+N 新建任务。
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
const port = 9367
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

const workdir = await mkdtemp(join(tmpdir(), 'owb-menubar-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-menubar-data-'))

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

let session
try {
  const page = await waitForPage()
  session = await connect(page.webSocketDebuggerUrl)
  const { evaluate, send } = session
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="welcome"]'))`)

  const triggers = await evaluate(
    `[...document.querySelectorAll('.owb-menubar__trigger')].map((el) => el.innerText.trim())`
  )
  check(
    JSON.stringify(triggers) === JSON.stringify(['文件', '编辑', '视图', '帮助']),
    'menubar-matches-product',
    JSON.stringify(triggers)
  )

  const openMenu = async (label) => {
    const ok = await evaluate(`(() => {
      const btn = [...document.querySelectorAll('.owb-menubar__trigger')].find((el) => el.innerText.trim() === ${JSON.stringify(label)})
      if (!btn) return false
      btn.click()
      return true
    })()`)
    if (!ok) return false
    return waitFor(evaluate, `Boolean(document.querySelector('.owb-menu'))`)
  }

  check(await openMenu('文件'), 'file-menu-opens')
  const fileItems = await evaluate(
    `[...document.querySelectorAll('.owb-menu__item')].map((el) => el.innerText.trim())`
  )
  check(
    ['新建任务', '打开工作区目录', '账号与设置'].every((x) => fileItems.some((l) => l.includes(x))),
    'file-menu-actions',
    JSON.stringify(fileItems)
  )

  // 设置项必须真的打开面板,不能只是菜单里的死文字。
  await evaluate(`(() => {
    const item = [...document.querySelectorAll('.owb-menu__item')].find((el) => el.innerText.includes('账号与设置'))
    item?.click()
  })()`)
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[aria-label="设置"]'))`),
    'file-menu-opens-settings'
  )
  await evaluate(`document.querySelector('[aria-label="关闭设置"]')?.click()`)
  await sleep(300)

  // 新建任务:先看侧栏数量,菜单点击后必须真正多出一条会话。
  const before = await evaluate(`document.querySelectorAll('[data-testid="conversation-item"]').length`)
  await openMenu('文件')
  await evaluate(`(() => {
    const item = [...document.querySelectorAll('.owb-menu__item')].find((el) => el.innerText.includes('新建任务'))
    item?.click()
  })()`)
  check(
    await waitFor(
      evaluate,
      `document.querySelectorAll('[data-testid="conversation-item"]').length > ${before}`,
      15000
    ),
    'file-menu-new-task',
    `${before}`
  )

  // 快捷键:焦点在输入框时 Ctrl+N 仍要新建,不能被文本框吞掉。
  await waitFor(evaluate, `Boolean(document.querySelector('textarea[data-testid="composer-input"]'))`)
  const beforeShortcut = await evaluate(`document.querySelectorAll('[data-testid="conversation-item"]').length`)
  await evaluate(`(() => {
    const input = document.querySelector('textarea[data-testid="composer-input"]')
    input.focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }))
    return true
  })()`)
  check(
    await waitFor(
      evaluate,
      `document.querySelectorAll('[data-testid="conversation-item"]').length > ${beforeShortcut}`,
      15000
    ),
    'ctrl-n-new-task',
    `${beforeShortcut}`
  )

  const shot = await send('Page.captureScreenshot', { format: 'png' }, 20000)
  if (shot.result?.data) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(tmpdir(), 'owb-menubar.png'), Buffer.from(shot.result.data, 'base64'))
    console.log(`SHOT ${join(tmpdir(), 'owb-menubar.png')}`)
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
  await Promise.race([new Promise((r) => app.on('exit', r)), sleep(3000)])
  await rm(workdir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }).catch(() => undefined)
  await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }).catch(() => undefined)
}

process.exit(failed === 0 ? 0 : 1)

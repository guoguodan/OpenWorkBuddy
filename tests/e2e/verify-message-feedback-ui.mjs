/**
 * 消息级工具栏的界面验收。
 *
 * 覆盖:
 *   - 用户/助手消息均显示复制按钮,点击后短暂显示"已复制";
 *   - 助手消息可点赞,再次点击取消;
 *   - 点踩会弹出与真实产品一致的多选原因,提交后按钮保持选中;
 *   - 刷新页面后点赞/点踩状态从数据库恢复。
 *
 * 用法: node tests/e2e/verify-message-feedback-ui.mjs
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
const port = 9343
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
    const timer = setTimeout(() => rej(new Error('CDP WebSocket 连接超时')), 10000)
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
      res({ ws, send, evaluate })
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      rej(new Error('CDP WebSocket 连接失败'))
    })
  })
}

async function waitFor(evaluate, expression, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      if (await evaluate(expression)) return true
    } catch {
      // 刷新期间执行上下文会短暂失效,重试即可
    }
    await sleep(150)
  }
  return false
}

const workdir = await mkdtemp(join(tmpdir(), 'owb-feedback-ui-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-feedback-ui-data-'))
await writeFile(join(workdir, 'package.json'), '{"name":"feedback-ui-ws"}\n', 'utf8')

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
  const { evaluate, send } = client

  check(
    await waitFor(evaluate, `Boolean(document.querySelector('textarea[data-testid="composer-input"]'))`),
    '界面就绪'
  )

  const submitted = await evaluate(`(() => {
    const input = document.querySelector('textarea[data-testid="composer-input"]')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(input, '请解释这段代码的结构')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('button[aria-label="发送"]')?.click()
    return true
  })()`)
  check(submitted, '发送测试消息')

  const assistantReady = await waitFor(
    evaluate,
    `Boolean(document.querySelector('.owb-msg--assistant [data-testid="message-like"]'))`,
    25000
  )
  check(assistantReady, '助手消息出现操作栏')

  const userCopy = await waitFor(
    evaluate,
    `Boolean(document.querySelector('.owb-msg--user [data-testid="message-copy"]'))`
  )
  check(userCopy, '用户消息可复制')

  const copied = await evaluate(`(() => {
    const btn = document.querySelector('.owb-msg--assistant [data-testid="message-copy"]')
    if (!btn) return false
    btn.click()
    return true
  })()`)
  check(copied, '点击助手消息复制按钮')
  const copiedState = await waitFor(
    evaluate,
    `Boolean(document.querySelector('.owb-msg--assistant [data-testid="message-copy"] .owb-msg-action__text'))`,
    5000
  )
  check(copiedState, '复制后显示"已复制"')

  await evaluate(`document.querySelector('.owb-msg--assistant [data-testid="message-like"]')?.click()`)
  const liked = await waitFor(
    evaluate,
    `document.querySelector('.owb-msg--assistant [data-testid="message-like"]')?.getAttribute('aria-pressed') === 'true'`
  )
  check(liked, '点赞按钮进入选中态')
  await evaluate(`document.querySelector('.owb-msg--assistant [data-testid="message-like"]')?.click()`)
  const unliked = await waitFor(
    evaluate,
    `document.querySelector('.owb-msg--assistant [data-testid="message-like"]')?.getAttribute('aria-pressed') !== 'true'`
  )
  check(unliked, '再次点击取消点赞')

  await evaluate(`document.querySelector('.owb-msg--assistant [data-testid="message-dislike"]')?.click()`)
  const dialog = await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="dislike-dialog"]'))`)
  check(dialog, '点踩打开原因弹层')
  const reasonText = await evaluate(
    `Array.from(document.querySelectorAll('.owb-feedback__item')).map((e) => e.textContent).join('|')`
  )
  check(
    reasonText.includes('误解问题') && reasonText.includes('代码格式错误') && reasonText.includes('其他'),
    '复刻真实产品的原因选项',
    reasonText
  )

  await evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('.owb-feedback__item'))
    items.find((e) => e.textContent === '代码错误')?.click()
  })()`)
  check(
    await waitFor(
      evaluate,
      `Array.from(document.querySelectorAll('.owb-feedback__item')).some((e) => e.textContent === '代码错误' && e.getAttribute('aria-selected') === 'true')`
    ),
    '原因可多选并进入选中态'
  )
  check(
    await waitFor(
      evaluate,
      `document.querySelector('[data-testid="dislike-submit"]')?.disabled === false`
    ),
    '选中原因后提交按钮可用'
  )
  await evaluate(`document.querySelector('[data-testid="dislike-submit"]')?.click()`)
  const disliked = await waitFor(
    evaluate,
    `document.querySelector('.owb-msg--assistant [data-testid="message-dislike"]')?.getAttribute('aria-pressed') === 'true'`
  )
  check(disliked, '提交原因后点踩保持选中')
  check(
    await waitFor(evaluate, `!document.querySelector('[data-testid="dislike-dialog"]')`),
    '提交后弹层关闭'
  )

  // 刷新必须从 conversation.history 恢复反馈,不能只靠前端内存。
  await send('Page.reload', {}, 15000).catch(() => undefined)
  await sleep(600)
  const reloaded = await waitFor(
    evaluate,
    `Boolean(document.querySelector('.owb-msg--assistant [data-testid="message-dislike"]'))`,
    25000
  )
  check(reloaded, '刷新后界面重新加载')
  check(
    await waitFor(
      evaluate,
      `document.querySelector('.owb-msg--assistant [data-testid="message-dislike"]')?.getAttribute('aria-pressed') === 'true'`
    ),
    '刷新后点踩状态从数据库恢复'
  )
} finally {
  try {
    client?.ws.close()
  } catch {}
  app.kill()
  await Promise.race([new Promise((r) => app.on('exit', r)), sleep(3000)])
  if (failed > 0 && appStderr.trim()) {
    console.log(`--- app stderr ---\n${appStderr.trim().split('\n').slice(-12).join('\n')}`)
  }
  await rm(workdir, { recursive: true, force: true }).catch(() => undefined)
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
}

process.exit(failed === 0 ? 0 : 1)

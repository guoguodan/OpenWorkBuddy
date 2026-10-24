/**
 * 语音输入验收:点击麦克风 -> 录制态 -> 停止 -> 转写 -> 文本回填 -> 取消录制。
 * 用法: node tests/e2e/verify-voice.mjs
 * 前置: pnpm --filter @openwb/daemon build && pnpm --filter @openwb/desktop build
 * 麦克风用 Chromium 假设备,转写走 OPENWB_MOCK,不访问真实网关。
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
const port = 9371
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

async function waitFor(evaluate, expression, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await evaluate(expression)) return true
    await sleep(150)
  }
  return false
}

const workdir = await mkdtemp(join(tmpdir(), 'owb-voice-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-voice-data-'))

const app = spawn(
  electron,
  [
    resolve(root, 'apps/desktop'),
    `--remote-debugging-port=${port}`,
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream'
  ],
  {
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
  }
)
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

  const box = `document.querySelector('[data-testid="composer-input"]')`
  check(await evaluate(`Boolean(${box})`), 'composer-ready')

  const trigger = `document.querySelector('[data-testid="voice-trigger"]')`
  check(await evaluate(`Boolean(${trigger})`), 'voice-trigger-present')
  check(
    (await evaluate(`${trigger}?.getAttribute('data-state')`)) === 'idle',
    'voice-starts-idle'
  )
  check(
    (await evaluate(`${trigger}?.getAttribute('title')`))?.includes('ALT'),
    'voice-tooltip-hint'
  )

  // 点击开始录制:必须真的进入录制态,而不是只改按钮颜色。
  await evaluate(`${trigger}?.click()`)
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="voice-recording"]'))`, 15000),
    'voice-starts-recording'
  )
  check(
    await waitFor(evaluate, `${box}?.value === '' || ${box}?.value === undefined`, 3000),
    'recording-does-not-touch-input'
  )
  check(
    await evaluate(
      `[...document.querySelectorAll('[data-testid="voice-recording"] button')].map((b) => b.innerText.trim()).join('|')`
    ) === '停止录制|取消录制',
    'recording-actions-match-product'
  )

  await sleep(1200)
  const timerText = await evaluate(`document.querySelector('[data-testid="voice-timer"]')?.innerText`)
  check(timerText === '00:01' || timerText === '00:02', 'voice-timer-ticks', String(timerText))

  // 停止 -> 识别 -> 文本回填到光标处。
  await evaluate(`document.querySelector('[data-testid="voice-stop"]')?.click()`)
  check(
    await waitFor(evaluate, `(${box}?.value ?? '').includes('这是一段语音识别结果')`, 25000),
    'voice-text-inserted'
  )
  // 识别中按钮仍在,必须等回落到 idle 才能开始下一次录制。
  check(
    await waitFor(evaluate, `${trigger}?.getAttribute('data-state') === 'idle'`, 15000),
    'voice-returns-idle'
  )

  // 已有内容时不得覆盖:文本应追加,且保留原文。
  await evaluate(`(() => {
    const el = ${box}
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, '保留我')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.focus()
    el.setSelectionRange(3, 3)
    return true
  })()`)
  await sleep(300)
  await evaluate(`document.querySelector('[data-testid="voice-trigger"]')?.click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="voice-recording"]'))`, 15000)
  await sleep(700)
  await evaluate(`document.querySelector('[data-testid="voice-stop"]')?.click()`)
  check(
    await waitFor(evaluate, `(${box}?.value ?? '').startsWith('保留我') && (${box}?.value ?? '').includes('这是一段语音识别结果')`, 25000),
    'voice-insert-keeps-existing-text'
  )

  // 取消录制:不得触发识别,也不得改动输入框。
  const beforeCancel = await evaluate(`${box}?.value`)
  await evaluate(`document.querySelector('[data-testid="voice-trigger"]')?.click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="voice-recording"]'))`, 15000)
  await sleep(500)
  await evaluate(`document.querySelector('[data-testid="voice-cancel"]')?.click()`)
  check(
    await waitFor(evaluate, `${trigger}?.getAttribute('data-state') === 'idle'`, 15000),
    'voice-cancel-returns-idle'
  )
  check(
    (await evaluate(`${box}?.value`)) === beforeCancel,
    'voice-cancel-does-not-insert'
  )

  // 长按 ALT:松开即结束录制并识别。
  const beforeHold = await evaluate(`${box}?.value`)
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', bubbles: true }))`)
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="voice-recording"]'))`, 15000),
    'alt-hold-starts-recording'
  )
  await sleep(600)
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', bubbles: true }))`)
  check(
    await waitFor(evaluate, `(${box}?.value ?? '').length > ${String(beforeHold?.length ?? 0)}`, 25000),
    'alt-release-transcribes'
  )

  const shot = await send('Page.captureScreenshot', { format: 'png' }, 20000)
  if (shot.result?.data) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(tmpdir(), 'owb-voice.png'), Buffer.from(shot.result.data, 'base64'))
    console.log(`SHOT ${join(tmpdir(), 'owb-voice.png')}`)
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
/**
 * 应用内产物预览的界面验收。
 *
 * 覆盖:
 *   - 点击产物行后在应用内打开预览,而不是交给系统程序;
 *   - Markdown 按安全组件渲染,正文可见;
 *   - 关闭按钮与 Esc 都能退出预览;
 *   - 预览层不暴露脚本执行环境。
 *
 * 用法: node tests/e2e/verify-artifact-preview.mjs
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

const workdir = await mkdtemp(join(tmpdir(), 'owb-artifact-preview-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-artifact-preview-data-'))
const userDataDir = await mkdtemp(join(tmpdir(), 'owb-artifact-preview-profile-'))
await writeFile(join(workdir, 'package.json'), '{"name":"artifact-preview-ws"}\n', 'utf8')

const app = spawn(electron, [resolve(root, 'apps/desktop'), `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`], {
  cwd: workdir,
  env: {
    ...process.env,
    OPENWB_DAEMON_ENTRY: resolve(root, 'apps/daemon/dist/index.js'),
    OPENWB_WORKSPACE: workdir,
    OPENWB_DATA_DIR: dataDir,
    OPENWB_MOCK: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
let appStderr = ''
app.stderr?.on('data', (chunk) => {
  appStderr += String(chunk)
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
    setter.call(input, '请生成一份简短的验收报告')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('button[aria-label="发送"]')?.click()
    return true
  })()`)
  check(submitted, '发送测试消息')

  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="artifact-panel-trigger"]'))`, 25000),
    '会话头部出现交付物入口'
  )
  check(
    await waitFor(evaluate, `document.querySelector('[data-testid="artifact-panel-trigger"]')?.textContent?.includes('1')`),
    '入口展示交付物数量'
  )

  await evaluate(`document.querySelector('[data-testid="artifact-panel-trigger"]')?.click()`)
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="artifact-panel"]'))`),
    '交付物面板打开'
  )

  await evaluate(`document.querySelector('[data-testid="artifact-open"]')?.click()`)
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="artifact-preview"]'))`),
    '点击产物在应用内打开预览'
  )
  check(
    await waitFor(evaluate, `document.querySelector('[data-testid="artifact-preview"]')?.getAttribute('aria-label') === '产物预览'`),
    '预览层标注为产物预览'
  )
  const previewText = await evaluate(
    `document.querySelector('[data-testid="artifact-preview-content"]')?.textContent ?? ''`
  )
  check(previewText.includes('Mock 报告'), 'Markdown 正文在预览中渲染', previewText.slice(0, 120))
  check(
    await evaluate(`document.querySelector('[data-testid="artifact-preview-content"]')?.tagName === 'DIV'`),
    'Markdown 使用安全组件而非 iframe 注入'
  )
  check(
    await evaluate(`Boolean(document.querySelector('[data-testid="artifact-preview-external"]'))`),
    '提供用系统程序打开入口'
  )

  await evaluate(`document.querySelector('[data-testid="artifact-preview-close"]')?.click()`)
  check(
    await waitFor(evaluate, `!document.querySelector('[data-testid="artifact-preview"]')`),
    '关闭按钮退出预览'
  )

  await evaluate(`document.querySelector('[data-testid="artifact-open"]')?.click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="artifact-preview"]'))`)
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  check(
    await waitFor(evaluate, `!document.querySelector('[data-testid="artifact-preview"]')`),
    'Esc 退出预览'
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
  await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
}

process.exit(failed === 0 ? 0 : 1)

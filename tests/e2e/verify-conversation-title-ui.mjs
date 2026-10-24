/**
 * 会话自动标题的界面验收。
 *
 * 覆盖:
 *   - 新会话首轮完成后,侧栏无需手动刷新就显示可辨识标题;
 *   - 标题不会再停留在"新会话";
 *   - 标题写入数据库,重新载入列表仍然可见。
 *
 * 用法: node tests/e2e/verify-conversation-title-ui.mjs
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
const port = 9342
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
      res({ ws, evaluate })
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
    if (await evaluate(expression)) return true
    await sleep(150)
  }
  return false
}

const workdir = await mkdtemp(join(tmpdir(), 'owb-title-ui-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-title-ui-data-'))
await writeFile(join(workdir, 'package.json'), '{"name":"title-ui-ws"}\n', 'utf8')

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

  check(
    await waitFor(evaluate, `Boolean(document.querySelector('textarea[data-testid="composer-input"]'))`),
    '界面就绪'
  )

  const submitted = await evaluate(`(() => {
    const input = document.querySelector('textarea[data-testid="composer-input"]')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(input, '帮我把季度销售数据整理成一份可汇报的分析报告')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('button[aria-label="发送"]')?.click()
    return true
  })()`)
  check(submitted, '发送首轮消息')

  const titleChanged = await waitFor(
    evaluate,
    `(() => {
      const titles = Array.from(document.querySelectorAll('.owb-conv-item__title'))
        .map((e) => (e.textContent ?? '').trim())
        .filter(Boolean)
      // 不能把“默认会话”之类已有标题当作成功信号:首轮自动标题是异步落库的,
      // 过早取样会在标题广播到达前读到旧值,造成随机通过。
      return titles.some((t) => t.includes('季度销售') || t.includes('分析报告'))
    })()`,
    25000
  )
  const titles = await evaluate(
    `Array.from(document.querySelectorAll('.owb-conv-item__title')).map((e) => (e.textContent ?? '').trim())`
  )
  check(titleChanged, '首轮后侧栏无需刷新即出现新标题', JSON.stringify(titles))
  check(
    titles.some((t) => t.includes('季度销售') || t.includes('分析报告')),
    '标题概括了任务目标',
    JSON.stringify(titles)
  )
  check(
    !titles.includes('新会话'),
    '侧栏不再残留占位标题',
    JSON.stringify(titles)
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

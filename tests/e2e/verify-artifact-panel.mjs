/**
 * 会话级交付物面板的界面验收。
 *
 * 覆盖:
 *   - 完成任务后头部出现交付物入口与数量;
 *   - 面板可打开、按类型筛选、按关键词搜索;
 *   - 重命名后标题更新且磁盘路径不变;
 *   - 移除只清空列表记录,工作区文件仍然存在;
 *   - 刷新页面后重命名结果从数据库恢复。
 *
 * 用法: node tests/e2e/verify-artifact-panel.mjs
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

const workdir = await mkdtemp(join(tmpdir(), 'owb-artifact-panel-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-artifact-panel-data-'))
const userDataDir = await mkdtemp(join(tmpdir(), 'owb-artifact-panel-profile-'))
await writeFile(join(workdir, 'package.json'), '{"name":"artifact-panel-ws"}\n', 'utf8')

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

  const rowText = await evaluate(
    `document.querySelector('[data-testid="artifact-row"]')?.textContent ?? ''`
  )
  check(rowText.includes('Mock 报告') && rowText.includes('mock-report.md'), '面板展示交付物标题与路径', rowText)

  await evaluate(`document.querySelector('[data-testid="artifact-filter-file"]')?.click()`)
  check(
    await waitFor(evaluate, `document.querySelectorAll('[data-testid="artifact-row"]').length === 1`),
    '按文档类型筛选'
  )
  await evaluate(`document.querySelector('[data-testid="artifact-filter-image"]')?.click()`)
  check(
    await waitFor(evaluate, `document.querySelectorAll('[data-testid="artifact-row"]').length === 0`),
    '筛选无匹配类型时列表为空'
  )
  await evaluate(`document.querySelector('[data-testid="artifact-filter-all"]')?.click()`)

  await evaluate(`(() => {
    const input = document.querySelector('[data-testid="artifact-panel-search"]')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '不存在的关键词')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  check(
    await waitFor(evaluate, `document.querySelectorAll('[data-testid="artifact-row"]').length === 0`),
    '搜索无匹配时列表为空'
  )
  await evaluate(`(() => {
    const input = document.querySelector('[data-testid="artifact-panel-search"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'Mock')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  check(
    await waitFor(evaluate, `document.querySelectorAll('[data-testid="artifact-row"]').length === 1`),
    '搜索命中交付物'
  )

  await evaluate(`document.querySelector('[data-testid="artifact-rename"]')?.click()`)
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="artifact-rename-input"]'))`),
    '进入重命名状态'
  )
  await evaluate(`(() => {
    const input = document.querySelector('[data-testid="artifact-rename-input"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '季度验收报告')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })()`)
  check(
    await waitFor(evaluate, `document.querySelector('[data-testid="artifact-row"]')?.textContent?.includes('季度验收报告')`),
    '重命名后标题立即更新'
  )
  check(
    await evaluate(`document.querySelector('[data-testid="artifact-row"]')?.textContent?.includes('mock-report.md')`),
    '重命名不改动磁盘路径'
  )

  // 刷新后标题必须来自数据库,证明重命名不是只改了前端状态。
  await send('Page.reload', {}, 15000).catch(() => undefined)
  await sleep(700)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="artifact-panel-trigger"]'))`, 25000)
  await evaluate(`document.querySelector('[data-testid="artifact-panel-trigger"]')?.click()`)
  check(
    await waitFor(evaluate, `document.querySelector('[data-testid="artifact-row"]')?.textContent?.includes('季度验收报告')`),
    '刷新后重命名结果从数据库恢复'
  )

  await evaluate(`document.querySelector('[data-testid="artifact-view-all"]')?.click()`)
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('.owb-sheet')) && document.body.textContent.includes('资料库')`),
    '查看所有产物打开资料库'
  )
  await evaluate(`document.querySelector('[aria-label="关闭资料库"]')?.click()`)
  await waitFor(evaluate, `!document.querySelector('.owb-sheet')`)
  await evaluate(`document.querySelector('[data-testid="artifact-panel-trigger"]')?.click()`)
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="artifact-panel"]'))`),
    '关闭资料库后重新打开产物面板'
  )

  await evaluate(`window.confirm = () => true`)
  await evaluate(`document.querySelector('[data-testid="artifact-remove"]')?.click()`)
  check(
    await waitFor(evaluate, `document.querySelectorAll('[data-testid="artifact-row"]').length === 0`),
    '移除后列表清空'
  )
  check(existsSync(join(workdir, 'out', 'mock-report.md')), '移除记录不删除磁盘文件')
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

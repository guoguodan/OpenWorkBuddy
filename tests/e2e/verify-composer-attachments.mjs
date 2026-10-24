/**
 * 输入框附件能力的界面验收。
 *
 * 覆盖:
 *   - 文件拖入窗口时出现整窗覆盖层,离开后消失;
 *   - 拖拽落盘后出现原始文件名 chip,同内容重复拖入不会重复;
 *   - chip 可移除;
 *   - 发送后用户消息显示附件 chip,正文不拼接内部存储路径;
 *   - 附件真实落在工作区 .openwb/attachments/;
 *   - 刷新页面后从历史恢复附件元数据。
 *
 * 用法: node tests/e2e/verify-composer-attachments.mjs
 * 前置: pnpm --filter @openwb/daemon build && pnpm --filter @openwb/desktop build
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const electron = resolve(root, 'apps/desktop/node_modules/electron/dist/electron.exe')
const port = 9350
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

const workdir = await mkdtemp(join(tmpdir(), 'owb-attach-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-attach-data-'))
await writeFile(join(workdir, 'package.json'), '{"name":"attachment-ws"}\n', 'utf8')

const app = spawn(electron, [resolve(root, 'apps/desktop'), `--remote-debugging-port=${port}`], {
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
  check(
    await evaluate(`Boolean(document.querySelector('[data-testid="attachment-picker-trigger"]'))`),
    '输入框提供添加文件入口'
  )

  const drag = (type) => `(() => {
    window.__owbDt = window.__owbDt || (() => {
      const dt = new DataTransfer()
      dt.items.add(new File(['# 验收附件\\n正文内容'], '需求 说明.md', { type: 'text/markdown' }))
      return dt
    })()
    window.dispatchEvent(new DragEvent('${type}', { bubbles: true, cancelable: true, dataTransfer: window.__owbDt }))
    return true
  })()`

  await evaluate(drag('dragenter'))
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="attachment-drop-overlay"]'))`),
    '文件进入窗口时显示拖拽覆盖层'
  )
  check(
    await evaluate(`document.querySelector('[data-testid="attachment-drop-overlay"]')?.textContent?.includes('松开即可添加文件')`),
    '覆盖层文案与真实产品一致'
  )

  await evaluate(drag('dragleave'))
  check(
    await waitFor(evaluate, `!document.querySelector('[data-testid="attachment-drop-overlay"]')`),
    '文件离开窗口后覆盖层消失'
  )

  await evaluate(drag('dragenter'))
  await evaluate(drag('drop'))
  check(
    await waitFor(evaluate, `!document.querySelector('[data-testid="attachment-drop-overlay"]')`),
    '释放后覆盖层关闭'
  )
  check(
    await waitFor(evaluate, `document.querySelectorAll('[data-testid="attachment-chip"]').length === 1`),
    '拖拽后出现一个附件 chip'
  )
  check(
    await evaluate(`document.querySelector('[data-testid="attachment-chip"]')?.textContent?.includes('需求 说明.md')`),
    'chip 显示原始文件名'
  )
  check(
    await evaluate(`!document.querySelector('[data-testid="attachment-chip"]')?.textContent?.includes('.openwb')`),
    'chip 不暴露内部存储路径'
  )

  // 同内容重复拖入应命中去重,而不是产生第二个 chip。
  await evaluate(drag('dragenter'))
  await evaluate(drag('drop'))
  await sleep(500)
  check(
    await evaluate(`document.querySelectorAll('[data-testid="attachment-chip"]').length === 1`),
    '重复拖入同一文件不会重复添加'
  )

  // 再添加一张图片,验证移除只影响被点选的那一个。
  await evaluate(`(() => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], '截图.png', { type: 'image/png' }))
    window.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }))
    window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    return true
  })()`)
  check(
    await waitFor(evaluate, `document.querySelectorAll('[data-testid="attachment-chip"]').length === 2`),
    '可同时添加多个附件'
  )
  check(
    await evaluate(`document.querySelector('[data-testid="attachment-chip"][data-kind="image"]')?.textContent?.includes('截图.png')`),
    '图片附件使用独立类型标识'
  )
  await evaluate(`document.querySelectorAll('[data-testid="attachment-chip"]')[1]?.querySelector('button')?.click()`)
  check(
    await waitFor(evaluate, `document.querySelectorAll('[data-testid="attachment-chip"]').length === 1`),
    '移除按钮删除指定附件'
  )

  const filesBeforeSend = await readdir(join(workdir, '.openwb', 'attachments')).catch(() => [])
  check(filesBeforeSend.length === 2, '附件真实复制到工作区附件目录', filesBeforeSend.join(','))

  await evaluate(`(() => {
    const input = document.querySelector('textarea[data-testid="composer-input"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(input, '请总结我添加的附件')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('button[aria-label="发送"]')?.click()
    return true
  })()`)

  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="message-attachments"]'))`, 25000),
    '发送后用户消息保留附件 chip'
  )
  check(
    await evaluate(`document.querySelector('[data-testid="message-attachments"]')?.textContent?.includes('需求 说明.md')`),
    '消息附件显示原始文件名'
  )
  const bubble = await evaluate(`document.querySelector('.owb-msg--user .owb-msg__bubble')?.textContent ?? ''`)
  check(!bubble.includes('.openwb/attachments'), '消息正文不拼接内部路径', bubble)
  check(bubble.includes('请总结我添加的附件'), '消息正文保持用户原文', bubble)
  check(
    await waitFor(evaluate, `document.querySelectorAll('[data-testid="attachment-chip"]').length === 0`),
    '发送后输入框附件清空'
  )

  await send('Page.reload', {}, 15000).catch(() => undefined)
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="message-attachments"]'))`, 25000),
    '刷新后从历史恢复附件'
  )
  check(
    await evaluate(`document.querySelector('[data-testid="message-attachments"]')?.textContent?.includes('需求 说明.md')`),
    '历史恢复的附件仍显示原始文件名'
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

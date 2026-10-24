/**
 * 重放/回退按钮的界面验收。
 *
 * 覆盖:
 *   - 用户消息显示“重放 / 回退到此版本”；
 *   - 点击先出现确认弹层,取消不会改动会话；
 *   - 回退后界面立即移除后续消息,不重新生成；
 *   - 重放后重新生成,旧后续消息消失且按钮仍可用；
 *   - 刷新页面后以数据库为准,不会把已截断内容恢复出来。
 *
 * 用法: node tests/e2e/verify-replay-revert-ui.mjs
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
const port = 9344
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
      // 页面刷新时执行上下文会短暂失效
    }
    await sleep(150)
  }
  return false
}

const workdir = await mkdtemp(join(tmpdir(), 'owb-replay-ui-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-replay-ui-data-'))
await writeFile(join(workdir, 'package.json'), '{"name":"replay-ui-ws"}\n', 'utf8')

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
app.stderr.on('data', (b) => { appStderr += String(b) })

const sendMessage = async (evaluate, text) => {
  return evaluate(`(() => {
    const input = document.querySelector('textarea[data-testid="composer-input"]')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(text)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('button[aria-label="发送"]')?.click()
    return true
  })()`)
}
const countUserMessages = `document.querySelectorAll('.owb-msg--user').length`
const countAssistants = `document.querySelectorAll('.owb-msg--assistant').length`

let client
try {
  const page = await waitForPage()
  client = await connect(page.webSocketDebuggerUrl)
  const { evaluate, send } = client
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('textarea[data-testid="composer-input"]'))`),
    '界面就绪'
  )

  check(await sendMessage(evaluate, '第一轮:请解释这段代码的结构'), '发送第一轮')
  check(await waitFor(evaluate, `${countAssistants} === 1`, 25000), '第一轮生成完成')
  check(await sendMessage(evaluate, '第二轮:继续解释这个文件'), '发送第二轮')
  check(await waitFor(evaluate, `${countAssistants} === 2`, 25000), '第二轮生成完成')
  check(await sendMessage(evaluate, '第三轮:再总结一下'), '发送第三轮')
  check(await waitFor(evaluate, `${countAssistants} === 3`, 25000), '第三轮生成完成')

  const actionCount = await evaluate(
    `document.querySelectorAll('.owb-msg--user [data-testid="message-replay"]').length`
  )
  check(actionCount === 3, '每条用户消息都有重放按钮', String(actionCount))
  const revertCount = await evaluate(
    `document.querySelectorAll('.owb-msg--user [data-testid="message-revert"]').length`
  )
  check(revertCount === 3, '每条用户消息都有回退按钮', String(revertCount))

  // 回退到第二轮:先出现确认,取消后内容不变。
  await evaluate(`document.querySelectorAll('.owb-msg--user [data-testid="message-revert"]')[1]?.click()`)
  check(await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="revert-confirm"]'))`), '回退弹出确认层')
  const warning = await evaluate(`document.querySelector('[data-testid="revert-confirm"]')?.textContent ?? ''`)
  check(warning.includes('不可恢复'), '确认层说明会删除后续内容', warning)
  await evaluate(`document.querySelector('[data-testid="revert-confirm"] .owb-confirm__cancel')?.click()`)
  check(await waitFor(evaluate, `!document.querySelector('[data-testid="revert-confirm"]')`), '取消关闭确认层')
  {
    const users = await evaluate(countUserMessages)
    check(users === 3, '取消后消息数量不变', String(users))
  }

  await evaluate(`document.querySelectorAll('.owb-msg--user [data-testid="message-revert"]')[1]?.click()`)
  check(await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="revert-confirm"]'))`), '再次打开回退确认')
  await evaluate(`document.querySelector('[data-testid="confirm-version-action"]')?.click()`)
  const reverted = await waitFor(evaluate, `${countUserMessages} === 2 && ${countAssistants} === 2`, 15000)
  check(reverted, '回退保留第二轮并删除其后内容', await evaluate(`document.body.innerText.slice(-200)`))
  await sleep(500)
  check((await evaluate(countAssistants)) === 2, '回退不重新生成助手回复')
  {
    // 文件检查点结果必须出现在界面上,不能只存数据库。
    const body = await evaluate('document.body.innerText')
    check(/文件未回退|文件无需改动|已恢复/.test(body), '回退结果说明文件是否恢复', body.slice(-200))
  }

  // 重放第一轮:确认后重新生成,保留一条用户消息与一条新回复。
  await evaluate(`document.querySelectorAll('.owb-msg--user [data-testid="message-replay"]')[0]?.click()`)
  check(await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="replay-confirm"]'))`), '重放弹出确认层')
  const replayWarning = await evaluate(`document.querySelector('[data-testid="replay-confirm"]')?.textContent ?? ''`)
  check(replayWarning.includes('重新生成内容'), '重放使用真实产品提示文案', replayWarning)
  await evaluate(`document.querySelector('[data-testid="confirm-version-action"]')?.click()`)
  const replayed = await waitFor(evaluate, `${countUserMessages} === 1 && ${countAssistants} === 1`, 25000)
  check(replayed, '重放覆盖第一轮后的内容并重新生成', await evaluate(`document.body.innerText.slice(-200)`))
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('.owb-msg--user [data-testid="message-replay"]'))`),
    '重放后的新用户消息仍可再次操作'
  )

  // 刷新:确认界面结果来自数据库,不是前端临时状态。
  await send('Page.reload', {}, 15000).catch(() => undefined)
  await sleep(600)
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('.owb-msg--user'))`, 25000),
    '刷新后会话重新加载'
  )
  check((await evaluate(countUserMessages)) === 1, '刷新后仍只有重放后的一轮')
  check((await evaluate(countAssistants)) === 1, '刷新后助手回复数量正确')
} finally {
  try { client?.ws.close() } catch {}
  app.kill()
  await Promise.race([new Promise((r) => app.on('exit', r)), sleep(3000)])
  if (failed > 0 && appStderr.trim()) {
    console.log(`--- app stderr ---\n${appStderr.trim().split('\n').slice(-12).join('\n')}`)
  }
  await rm(workdir, { recursive: true, force: true }).catch(() => undefined)
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
}

process.exit(failed === 0 ? 0 : 1)

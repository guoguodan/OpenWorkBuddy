/**
 * 工作流面板的界面验收。
 *
 * 覆盖:
 *   - 侧边栏入口能打开工作流面板;
 *   - 工作流列表来自真实 manifest,阶段与输入表单一并显示;
 *   - 必填输入为空时不能启动,填写后可以运行;
 *   - 运行记录展示状态、阶段进度与模型调用数;
 *   - 产物按钮复用应用内预览打开报告正文。
 *
 * 用法: node tests/e2e/verify-workflow-ui.mjs
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
const port = 9348
const endpoint = `http://127.0.0.1:${port}/json/list`

if (!existsSync(electron)) {
  console.error(`缺少 Electron 可执行文件: ${electron}`)
  process.exit(1)
}
if (!existsSync(resolve(root, 'apps/daemon/dist/index.js'))) {
  console.error('缺少 daemon 产物,先执行: pnpm --filter @openwb/daemon build')
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

const workdir = await mkdtemp(join(tmpdir(), 'owb-workflow-ui-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-workflow-ui-data-'))
const userDataDir = await mkdtemp(join(tmpdir(), 'owb-workflow-ui-profile-'))
await writeFile(join(workdir, 'package.json'), '{"name":"workflow-ui-ws"}\n', 'utf8')

const app = spawn(electron, [resolve(root, 'apps/desktop'), `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`], {
  cwd: workdir,
  env: {
    ...process.env,
    OPENWB_DAEMON_ENTRY: resolve(root, 'apps/daemon/dist/index.js'),
    OPENWB_WORKSPACE: workdir,
    OPENWB_DATA_DIR: dataDir,
    OPENWB_MOCK: '1',
    OPENWB_AUTOMATION_AUTOSTART: '0'
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
  const { evaluate } = client

  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="open-workflows"]'))`),
    '侧边栏出现工作流入口'
  )
  await evaluate(`document.querySelector('[data-testid="open-workflows"]')?.click()`)
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="workflow-list"]'))`),
    '工作流面板打开并加载列表'
  )
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="workflow-item-deep-research"]'))`),
    '内置深度研究工作流可见'
  )

  await evaluate(`document.querySelector('[data-testid="workflow-item-deep-research"]')?.click()`)
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="workflow-phases"]')?.textContent?.includes('拆解'))`),
    '显示 manifest 的阶段'
  )
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="workflow-input-question"]'))`),
    '根据 manifest 生成输入表单'
  )
  check(
    await evaluate(`Boolean(document.querySelector('[data-testid="workflow-start"]')?.disabled)`),
    '必填输入为空时禁用启动'
  )

  await evaluate(`(() => {
    const input = document.querySelector('[data-testid="workflow-input-question"]')
    if (!input) return false
    const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(input, 'OpenWorkBuddy 的工作流面板如何验收?')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  check(
    await waitFor(evaluate, `!document.querySelector('[data-testid="workflow-start"]')?.disabled`),
    '填写必填输入后可以启动'
  )

  await evaluate(`document.querySelector('[data-testid="workflow-start"]')?.click()`)
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="workflow-runs"]'))`, 20000),
    '运行记录出现'
  )
  check(
    await waitFor(
      evaluate,
      `[...document.querySelectorAll('[data-testid^="workflow-run-"]')].some((el) => el.textContent?.includes('已完成'))`,
      60000
    ),
    '工作流运行完成'
  )

  const runCard = await evaluate(`(() => {
    const card = [...document.querySelectorAll('[data-testid^="workflow-run-"]')].find((el) => el.textContent?.includes('已完成'))
    return card ? { id: card.getAttribute('data-testid'), text: card.textContent } : null
  })()`)
  check(Boolean(runCard), '找到已完成的运行卡')
  check(String(runCard?.text ?? '').includes('模型调用'), '运行卡展示模型调用数')
  check(String(runCard?.text ?? '').includes('拆解'), '运行卡展示阶段进度')

  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="workflow-output-report"]'))`),
    '完成运行展示报告产物'
  )
  await evaluate(`document.querySelector('[data-testid="workflow-output-report"]')?.click()`)
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="artifact-preview"]'))`),
    '点击产物打开应用内预览'
  )
  const previewText = await evaluate(
    `document.querySelector('[data-testid="artifact-preview-content"]')?.textContent ?? ''`
  )
  check(previewText.trim().length > 0, '产物预览包含正文', previewText.slice(0, 120))

  await evaluate(`document.querySelector('[data-testid="artifact-preview-close"]')?.click()`)
  await waitFor(evaluate, `!document.querySelector('[data-testid="artifact-preview"]')`)
} catch (err) {
  console.error('工作流界面验收异常:', err)
  failed++
} finally {
  try {
    client?.ws.close()
  } catch {}
  app.kill()
  await Promise.race([new Promise((r) => app.on('exit', r)), sleep(3000)])
  if (failed > 0 && appStderr.trim()) {
    console.log(`--- app stderr ---\n${appStderr.trim().split('\n').slice(-20).join('\n')}`)
  }
  await rm(workdir, { recursive: true, force: true }).catch(() => undefined)
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
  await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
}

console.log(failed === 0 ? '\n工作流界面全部通过' : `\n工作流界面失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)

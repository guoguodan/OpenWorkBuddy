/**
 * 界面截图工具:启动真实 Electron + daemon,按脚本操作后截图。
 *
 * 用法:
 *   node tests/e2e/shot-ui.mjs <输出目录> [场景名...]
 * 场景: home | more | chat
 *
 * 前置: pnpm --filter @openwb/daemon build && pnpm --filter @openwb/desktop build
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const electron = resolve(root, 'apps/desktop/node_modules/electron/dist/electron.exe')
const outDir = resolve(process.argv[2] ?? join(root, 'artifacts/shots'))
const scenes = process.argv.slice(3)
const wanted = scenes.length ? scenes : ['home', 'more', 'chat']
const port = 9371
const endpoint = 'http://127.0.0.1:' + port + '/json/list'

if (!existsSync(electron)) {
  console.error('缺少 Electron: ' + electron)
  process.exit(1)
}
await mkdir(outDir, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  throw new Error('Electron 页面未就绪')
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
            rejectCall(new Error('CDP ' + method + ' 超时'))
          }, timeoutMs)
          waiting.set(myId, (m) => {
            clearTimeout(t)
            resolveCall(m)
          })
          ws.send(JSON.stringify({ id: myId, method, params }))
        })
      const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true
        })
        if (r.result?.exceptionDetails) {
          throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate failed')
        }
        return r.result?.result?.value
      }
      res({ ws, send, evaluate })
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      rej(new Error('CDP 连接失败'))
    })
  })
}

const workdir = await mkdtemp(join(tmpdir(), 'owb-shot-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-shot-data-'))
await writeFile(join(workdir, 'package.json'), '{"name":"shot-ws"}\n', 'utf8')

const app = spawn(electron, [resolve(root, 'apps/desktop'), '--remote-debugging-port=' + port], {
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
app.stdout.on('data', () => {})
app.stderr.on('data', () => {})

async function shoot(client, name) {
  const r = await client.send('Page.captureScreenshot', { format: 'png' }, 30000)
  const data = r.result?.data
  if (!data) throw new Error('截图失败')
  await writeFile(join(outDir, name + '.png'), Buffer.from(data, 'base64'))
  console.log('shot ' + name + '.png')
}

async function waitForText(evaluate, text, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      if (await evaluate('document.body.innerText.includes(' + JSON.stringify(text) + ')')) return true
    } catch {}
    await sleep(150)
  }
  return false
}

try {
  const page = await waitForPage()
  const client = await connect(page.webSocketDebuggerUrl)
  await client.send('Page.enable')
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false
  })
  await waitForText(client.evaluate, 'WorkBuddy', 30000)
  await sleep(1200)

  for (const scene of wanted) {
    if (scene === 'home') {
      await shoot(client, 'owb-home')
      continue
    }
    if (scene === 'more') {
      await client.evaluate(
        '(() => { const b = document.querySelector(\'[data-testid="open-more"]\'); b?.click(); return Boolean(b) })()'
      )
      await sleep(900)
      await shoot(client, 'owb-more')
      await client.evaluate('document.body.click()')
      await sleep(400)
      continue
    }
    if (scene === 'chat') {
      await client.evaluate(
        '(() => {\n' +
          '  const input = document.querySelector(\'textarea[data-testid="composer-input"]\')\n' +
          '  if (!input) return false\n' +
          '  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set\n' +
          '  setter.call(input, "请生成一份简短的验收报告")\n' +
          '  input.dispatchEvent(new Event("input", { bubbles: true }))\n' +
          '  document.querySelector(\'button[aria-label="发送"]\')?.click()\n' +
          '  return true\n' +
          '})()'
      )
      await waitForText(client.evaluate, '已生成', 25000)
      await sleep(1500)
      await shoot(client, 'owb-chat')
      continue
    }
  }
  client.ws.close()
} catch (err) {
  console.error('FAIL ' + err.message)
  process.exitCode = 1
} finally {
  app.kill()
  await sleep(800)
  await rm(workdir, { recursive: true, force: true }).catch(() => undefined)
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
}

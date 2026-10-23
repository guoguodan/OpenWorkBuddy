/**
 * P2 界面验收:启动 Electron,通过 CDP 跑 quick/ask/craft 三模式,最后关窗清理。
 * 用法: node tests/e2e/verify-modes-ui.mjs
 * 前置: pnpm --filter @openwb/daemon build && pnpm --filter @openwb/desktop build
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const electron = resolve(root, 'apps/desktop/node_modules/electron/dist/electron.exe')
const port = 9333
const endpoint = `http://127.0.0.1:${port}/json/list`

if (!existsSync(electron)) {
  console.error(`缺少 Electron 可执行文件: ${electron}`)
  console.error('先执行: node apps/desktop/node_modules/electron/install.js')
  process.exit(1)
}

let failed = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (ok, label, detail = '') => {
  if (ok) console.log(`PASS ${label}`)
  else { failed++; console.log(`FAIL ${label} ${detail}`) }
}

async function waitForPage(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await (await fetch(endpoint)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('Electron 页面未在 30s 内就绪')
}

const workdir = await mkdtemp(join(tmpdir(), 'owb-ui-'))
const app = spawn(electron, [resolve(root, 'apps/desktop'), `--remote-debugging-port=${port}`], {
  cwd: workdir,
  env: {
    ...process.env,
    OPENWB_DAEMON_ENTRY: resolve(root, 'apps/daemon/dist/index.js'),
    OPENWB_WORKSPACE: workdir,
    OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
    OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts')
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
let appStderr = ''
app.stdout.on('data', () => {})
app.stderr.on('data', (b) => { appStderr += String(b) })

let ws
try {
  const page = await waitForPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const waiting = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id) }
  })
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('CDP WebSocket 连接超时 10s')), 10000)
    ws.addEventListener('open', () => { clearTimeout(timer); res() })
    ws.addEventListener('error', () => { clearTimeout(timer); rej(new Error('CDP WebSocket 连接失败')) })
  })

  const send = (method, params = {}, timeoutMs = 15000) => new Promise((res, rej) => {
    const myId = ++id
    const timer = setTimeout(() => {
      waiting.delete(myId)
      rej(new Error(`CDP ${method} 超时 ${timeoutMs}ms(页面可能已崩溃或关闭)`))
    }, timeoutMs)
    waiting.set(myId, (m) => { clearTimeout(timer); res(m) })
    try {
      ws.send(JSON.stringify({ id: myId, method, params }))
    } catch (err) {
      clearTimeout(timer)
      waiting.delete(myId)
      rej(err)
    }
  })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text)
    return r.result?.result?.value
  }

  const clickMode = (label) => evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent === ${JSON.stringify(label)})
    if (!b) throw new Error('找不到模式按钮: ' + ${JSON.stringify(label)})
    b.click(); return true
  })()`)

  const submit = async (text) => {
    await evaluate(`(() => {
      const input = document.querySelector('input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(text)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return input.value
    })()`)
    await sleep(150)
    await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent === '发送')
      b.click(); return true
    })()`)
  }

  const waitBusy = async (timeoutMs = 15000) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const busy = await evaluate(`Array.from(document.querySelectorAll('button')).some((b) => b.textContent.includes('执行中'))`)
      if (busy) return true
      await sleep(200)
    }
    return false
  }

  const waitIdle = async (timeoutMs = 120000) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const busy = await evaluate(`Array.from(document.querySelectorAll('button')).some((b) => b.textContent.includes('执行中'))`)
      if (!busy) return true
      await sleep(500)
    }
    return false
  }

  let buttons = []
  for (let i = 0; i < 60; i++) {
    buttons = await evaluate(`Array.from(document.querySelectorAll('button')).map((b) => b.textContent)`)
    if (buttons.length >= 6) break
    await sleep(250)
  }
  check(
    JSON.stringify(buttons) === JSON.stringify(['默认', '规划', '问答', '专家', '快速', '发送']),
    'mode-buttons-order',
    JSON.stringify(buttons)
  )

  // P3: 让模型加载内置技能,界面应出现"已加载技能"且工具被收窄
  await clickMode('默认')
  await submit('请加载 code-review 技能,然后只回复"已加载"。不要修改任何文件。')
  await waitBusy()
  const skillIdle = await waitIdle()
  const skillBody = await evaluate('document.body.innerText')
  check(skillIdle, 'skill-finished')
  check(skillBody.includes('已加载技能: code-review'), 'skill-badge-visible', skillBody.match(/已加载技能: .*/)?.[0] ?? '(missing)')
  check(!/本轮可用工具:.*write_file/.test(skillBody), 'skill-narrowed-tools-line')

  const cases = [
    { label: '快速', mode: 'quick', text: '读取 package.json 并告诉我 devDependencies 的数量', tools: '本轮可用工具: (无)' },
    { label: '问答', mode: 'ask', text: '把字符串 p2-ask 写入 out/ask.txt,然后只回复完成', tools: 'read_file' },
    { label: '默认', mode: 'craft', text: '把字符串 p2-craft 写入 out/craft.txt,然后只回复完成', tools: 'write_file' }
  ]

  for (const c of cases) {
    await clickMode(c.label)
    await submit(c.text)
    await waitBusy()
    const idle = await waitIdle()
    const body = await evaluate('document.body.innerText')
    const active = await evaluate(`Array.from(document.querySelectorAll('button')).filter((b) => b.style.border.startsWith('2px')).map((b) => b.textContent)`)
    check(idle, `${c.mode}-finished`, '等待超时')
    check(JSON.stringify(active) === JSON.stringify([c.label]), `${c.mode}-active-button`, JSON.stringify(active))
    check(body.includes(c.tools), `${c.mode}-tools-line`, body.match(/本轮可用工具: .*/)?.[0] ?? '(missing)')
  }

  // ask 不能写入,craft 必须写入
  const askExists = existsSync(join(workdir, 'out/ask.txt'))
  let craftContent = ''
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(workdir, 'out/craft.txt'))) {
      craftContent = (await readFile(join(workdir, 'out/craft.txt'), 'utf8')).trim()
      if (craftContent) break
    }
    await sleep(500)
  }
  const finalBody = await evaluate('document.body.innerText')
  if (craftContent !== 'p2-craft') {
    console.error('--- craft body ---')
    console.error(finalBody.slice(-1500))
    console.error('--- daemon stderr ---')
    console.error(appStderr.split('\n').slice(-25).join('\n'))
  }
  check(!askExists, 'ask-did-not-write', String(askExists))
  check(craftContent === 'p2-craft', 'craft-wrote-file', JSON.stringify(craftContent))
} catch (err) {
  failed++
  console.error(`FAIL 运行异常: ${err?.message ?? err}`)
} finally {
  ws?.close()
  app.kill()
  await sleep(1200)
  await rm(workdir, { recursive: true, force: true })
}

process.exit(failed === 0 ? 0 : 1)
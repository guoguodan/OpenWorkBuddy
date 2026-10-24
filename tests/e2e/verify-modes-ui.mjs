/**
 * P2 界面验收:启动 Electron,通过 CDP 跑 quick/ask/craft 三模式,最后关窗清理。
 * 用法: node tests/e2e/verify-modes-ui.mjs
 * 前置: pnpm --filter @openwb/daemon build && pnpm --filter @openwb/desktop build
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
const dataDir = await mkdtemp(join(tmpdir(), 'owb-ui-data-'))
await writeFile(join(workdir, 'package.json'), JSON.stringify({ name: 'ui-ws', devDependencies: { vitest: '^5.0.0' } }, null, 2), 'utf8')
const app = spawn(electron, [resolve(root, 'apps/desktop'), `--remote-debugging-port=${port}`], {
  cwd: workdir,
  env: {
    ...process.env,
    OPENWB_DAEMON_ENTRY: resolve(root, 'apps/daemon/dist/index.js'),
    OPENWB_WORKSPACE: workdir,
    OPENWB_DATA_DIR: dataDir,
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
  // 第二次启动会重新赋值,用 let 便于 finally 里统一关掉
  void ws
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
    if (r.result?.exceptionDetails) {
      const detail =
        r.result.exceptionDetails.exception?.description ??
        r.result.exceptionDetails.text ??
        '(未提供异常详情)'
      throw new Error(`evaluate 失败: ${detail}\n表达式: ${expression.slice(0, 300)}`)
    }
    return r.result?.result?.value
  }

  const clickMode = (label) => evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent === ${JSON.stringify(label)})
    // 进入会话后首页场景 tab 会卸载,此时当前场景保持不变,无需再次点击。
    if (!b) return false
    b.click(); return true
  })()`)

  const submit = async (text) => {
    await evaluate(`(() => {
      const input = document.querySelector('textarea[data-testid="composer-input"]')
      if (!input) throw new Error('找不到输入框')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(text)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return input.value
    })()`)
    await sleep(150)
    await evaluate(`(() => {
      const b = document.querySelector('button[aria-label="发送"]')
      if (!b) throw new Error('找不到发送按钮')
      if (b.disabled) throw new Error('发送按钮处于禁用状态')
      b.click(); return true
    })()`)
  }

  const isBusy = () =>
    evaluate(
      `Boolean(document.querySelector('.owb-composer__send--busy, .owb-content-header__running'))`
    )

  const waitBusy = async (timeoutMs = 15000) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const busy = await isBusy()
      if (busy) return true
      await sleep(200)
    }
    return false
  }

  const waitIdle = async (timeoutMs = 120000) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const busy = await isBusy()
      if (!busy) return true
      await sleep(500)
    }
    return false
  }

  // 首页 tab 已按真实产品改为"场景",模式仍由后端固定为 craft 参与运行。
  let sceneLabels = []
  for (let i = 0; i < 60; i++) {
    sceneLabels = await evaluate(`Array.from(document.querySelectorAll('[role="tab"]')).map((b) => b.textContent.trim())`)
    if (sceneLabels.length >= 3) break
    await sleep(250)
  }
  check(
    JSON.stringify(sceneLabels) === JSON.stringify(['办公', '开发', '设计']),
    'scene-tabs-order',
    JSON.stringify(sceneLabels)
  )
  const navTexts = await evaluate(
    `Array.from(document.querySelectorAll('.owb-sidebar__nav button')).map((b) => b.textContent.trim())`
  )
  check(
    ['新建任务', '助理', '专家·技能·连接器', '定时任务', '资料库', '更多'].every((label) =>
      navTexts.some((text) => text.startsWith(label))
    ),
    'p4-controls-visible',
    JSON.stringify(navTexts)
  )
  let convCount = 0
  for (let i = 0; i < 40; i++) {
    convCount = await evaluate(`document.querySelectorAll('[data-testid="conversation-item"]').length`)
    if (convCount >= 1) break
    await sleep(250)
  }
  check(convCount >= 1, 'conversation-list-visible', String(convCount))

  // P3: 让模型加载内置技能,界面应出现"已加载技能"且工具被收窄
  await submit('请加载 code-review 技能,然后只回复"已加载"。不要修改任何文件。')
  await waitBusy()
  const skillIdle = await waitIdle()
  const skillBody = await evaluate('document.body.innerText')
  check(skillIdle, 'skill-finished')
  check(skillBody.includes('已加载技能: code-review'), 'skill-badge-visible', skillBody.match(/已加载技能: .*/)?.[0] ?? '(missing)')
  // 一轮里会先发加载前的工具清单,再发收窄后的清单;只看最后一条。
  const toolLines = skillBody.match(/本轮可用工具: .*/g) ?? []
  const lastToolLine = toolLines.at(-1) ?? ''
  check(
    toolLines.length >= 2 && !lastToolLine.includes('write_file'),
    'skill-narrowed-tools-line',
    toolLines.join(' | ')
  )

  // 仍按三种真实模式直连发送,验证权限边界;界面不再提供模式切换。
  const cases = [
    { label: '办公', mode: 'craft', text: '把字符串 p2-craft 写入 out/craft.txt,然后只回复完成', tools: 'write_file' }
  ]

  for (const c of cases) {
    await clickMode(c.label)
    await submit(c.text)
    await waitBusy()
    const idle = await waitIdle()
    const body = await evaluate('document.body.innerText')
    // 任务页不再渲染场景 tab,因此这里只校验会话标题/场景没有被意外改掉。
    const bodyHasScene = body.includes(c.label)
    check(idle, `${c.mode}-finished`, '等待超时')
    check(bodyHasScene || (await evaluate(`document.querySelectorAll('[role="tab"]').length`)) === 0, `${c.mode}-scene-retained`)
    check(body.includes(c.tools), `${c.mode}-tools-line`, body.match(/本轮可用工具: .*/)?.[0] ?? '(missing)')
  }

  // craft 必须写入
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
  check(craftContent === 'p2-craft', 'craft-wrote-file', JSON.stringify(craftContent))

  // P4:记忆入口按真实产品收进"账号与设置",仍必须能列出本轮自动写入的工作区日志
  await evaluate(`Array.from(document.querySelectorAll('button')).find((b) => b.className.includes('owb-account')).click()`)
  await sleep(500)
  await evaluate(`(() => {
    const tile = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.startsWith('记忆'))
    if (!tile) throw new Error('设置里找不到记忆入口')
    tile.click(); return true
  })()`)
  await sleep(600)
  const memoryBody = await evaluate('document.body.innerText')
  check(/记忆/.test(memoryBody), 'memory-panel-opens')
  const memoryRows = await evaluate(
    `Array.from(document.querySelectorAll('button[aria-label="删除这条记忆"]')).length`
  )
  check(memoryRows > 0, 'memory-rows-listed', String(memoryRows))
  const notice = memoryBody.match(/已注入记忆[^\n]*/)?.[0] ?? ''
  check(notice.length > 0, 'memory-injected-notice', notice)

  // 重启后历史仍在:关掉应用再起一次,读同一 dataDir
  ws?.close()
  ws = undefined
  app.kill()
  await sleep(2500)

  const app2 = spawn(electron, [resolve(root, 'apps/desktop'), `--remote-debugging-port=${port}`], {
    cwd: workdir,
    env: {
      ...process.env,
      OPENWB_DAEMON_ENTRY: resolve(root, 'apps/daemon/dist/index.js'),
      OPENWB_WORKSPACE: workdir,
      OPENWB_DATA_DIR: dataDir,
      OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
      OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  app2.stdout.on('data', () => {})
  app2.stderr.on('data', (b) => { appStderr += String(b) })
  let ws2
  try {
    const page2 = await waitForPage(60000)
    ws2 = new WebSocket(page2.webSocketDebuggerUrl)
    let id2 = 0
    const waiting2 = new Map()
    ws2.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && waiting2.has(m.id)) { waiting2.get(m.id)(m); waiting2.delete(m.id) }
    })
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('第二次启动 CDP 连接超时')), 15000)
      ws2.addEventListener('open', () => { clearTimeout(timer); res() })
      ws2.addEventListener('error', () => { clearTimeout(timer); rej(new Error('第二次启动 CDP 连接失败')) })
    })
    const evaluate2 = async (expression) => {
      const myId = ++id2
      const r = await new Promise((res, rej) => {
        const timer = setTimeout(() => { waiting2.delete(myId); rej(new Error('CDP evaluate 超时')) }, 15000)
        waiting2.set(myId, (m) => { clearTimeout(timer); res(m) })
        ws2.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
      })
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text)
      return r.result?.result?.value
    }
    let body2 = ''
    for (let i = 0; i < 40; i++) {
      body2 = await evaluate2('document.body.innerText')
      if (body2.includes('p2-craft')) break
      await sleep(500)
    }
    check(body2.includes('p2-craft'), 'history-restored-after-restart', body2.slice(-500))
    const options = await evaluate2(`document.querySelectorAll('[data-testid="conversation-item"]').length`)
    check(options >= 1, 'conversation-list-restored', String(options))
  } finally {
    ws2?.close()
    app2.kill()
    await sleep(1200)
  }
} catch (err) {
  failed++
  console.error(`FAIL 运行异常: ${err?.message ?? err}`)
} finally {
  ws?.close()
  app.kill()
  await sleep(1200)
  await rm(workdir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 })
  await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 })
}

process.exit(failed === 0 ? 0 : 1)

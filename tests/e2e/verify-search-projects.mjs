/**
 * 全局搜索覆盖项目:项目可被名称/简介命中,点击结果打开项目面板并定位目标卡片。
 *
 * 覆盖:
 *   - 搜索面板出现"项目"分组;
 *   - 项目命中带 projectId,不伪造会话跳转;
 *   - 点击项目命中打开项目面板;
 *   - 目标项目卡片滚动到可视区并短暂高亮。
 *
 * 用法: node tests/e2e/verify-search-projects.mjs
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
const port = 9361
const endpoint = `http://127.0.0.1:${port}/json/list`
const projectName = '星河交付协作'

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

async function waitForPage(timeoutMs = 40000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await (await fetch(endpoint)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch {}
    await sleep(400)
  }
  throw new Error('Electron 页面未在 40s 内就绪')
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
    const timer = setTimeout(() => rej(new Error('CDP 连接超时 10s')), 10000)
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
    await sleep(120)
  }
  return false
}

const workdir = await mkdtemp(join(tmpdir(), 'owb-search-projects-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-search-projects-data-'))
await writeFile(join(workdir, 'package.json'), '{"name":"search-projects-ws"}\n', 'utf8')

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
  const { evaluate, send } = client

  check(await waitFor(evaluate, `Boolean(document.querySelector('textarea[data-testid="composer-input"]'))`), 'composer-rendered')

  const project = await evaluate(`(async () => {
    const r = await window.openwb.projects.create({
      name: ${JSON.stringify(projectName)},
      description: '面向企业客户的交付协作空间',
      instructions: '所有输出保持结构化'
    })
    return { id: r.project?.id ?? null, name: r.project?.name ?? null }
  })()`)
  check(Boolean(project?.id), 'fixture-project-created', JSON.stringify(project))

  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`)
  check(await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="search-panel"]'))`), 'ctrl-k-opens-search')
  const placeholder = await evaluate(`document.querySelector('[data-testid="search-input"]')?.getAttribute('placeholder') ?? ''`)
  check(placeholder.includes('项目'), 'search-placeholder-mentions-projects', placeholder)

  await evaluate(`(() => {
    const input = document.querySelector('[data-testid="search-input"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '星河')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="search-group-project"] .owb-search-hit'))`, 12000),
    'project-group-visible'
  )
  const hit = await evaluate(`(() => {
    const el = document.querySelector('[data-testid="search-group-project"] .owb-search-hit')
    return { title: el?.querySelector('.owb-search-hit__title')?.textContent ?? '', snippet: el?.querySelector('.owb-search-hit__snippet')?.textContent ?? '' }
  })()`)
  check(hit.title.includes(projectName), 'project-hit-title', JSON.stringify(hit))
  check(hit.snippet.includes('星河') || hit.snippet.includes('交付'), 'project-hit-snippet', JSON.stringify(hit))

  const groupLabel = await evaluate(`document.querySelector('[data-testid="search-group-project"] .owb-search-group__title')?.textContent ?? ''`)
  check(groupLabel.includes('项目'), 'project-group-label', groupLabel)

  await evaluate(`document.querySelector('[data-testid="search-group-project"] .owb-search-hit').click()`)
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[role="dialog"][aria-label="项目"]'))`, 12000),
    'project-hit-opens-projects-panel'
  )
  check(
    await waitFor(
      evaluate,
      `document.querySelector('[data-project-id="${project.id}"]')?.getAttribute('data-focused') === 'true'`,
      12000
    ),
    'project-card-focused'
  )
  const applied = await evaluate(`(() => {
    const el = document.querySelector('[data-project-id="${project.id}"]')
    return { className: el?.className ?? '', visible: !!el && el.getBoundingClientRect().top >= 0 }
  })()`)
  check(applied.className.includes('owb-project-tile--focus'), 'project-card-highlight-class', JSON.stringify(applied))
  check(applied.visible, 'project-card-in-viewport', JSON.stringify(applied))

  const apiHit = await evaluate(`(async () => {
    const r = await window.openwb.search.query('星河')
    const g = (r.groups ?? []).find((x) => x.group === 'project')
    return g?.items?.[0] ?? null
  })()`)
  check(apiHit?.projectId === project.id, 'search-api-returns-project-id', JSON.stringify(apiHit))

  const shot = await send('Page.captureScreenshot', { format: 'png' }, 20000)
  if (shot.result?.data) {
    const { writeFile } = await import('node:fs/promises')
    const path = join(tmpdir(), 'owb-search-projects.png')
    await writeFile(path, Buffer.from(shot.result.data, 'base64'))
    console.log(`SHOT ${path}`)
  }
} catch (err) {
  failed++
  console.error(`FAIL 运行异常: ${err?.message ?? err}`)
} finally {
  try {
    client?.ws.close()
  } catch {}
  app.kill()
  await Promise.race([new Promise((r) => app.on('exit', r)), sleep(3000)])
  if (failed > 0 && appStderr.trim()) {
    console.log(`--- app stderr ---\n${appStderr.trim().split('\n').slice(-15).join('\n')}`)
  }
  await rm(workdir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }).catch(() => undefined)
  await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }).catch(() => undefined)
}

process.exit(failed === 0 ? 0 : 1)

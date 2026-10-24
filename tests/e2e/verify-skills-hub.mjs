/**
 * 专家·技能·连接器工作台验收。
 *
 * 桌面端:
 *   页签/搜索空态、技能启停持久化、Composer 过滤、置顶顺序、
 *   导入用户技能、卸载确认、连接器已安装/可用分组与探测、专家清单。
 *
 * 用法: node tests/e2e/verify-skills-hub.mjs
 * 前置: pnpm --filter @openwb/daemon build && pnpm --filter @openwb/desktop build
 */
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const electron = resolve(root, 'apps/desktop/node_modules/electron/dist/electron.exe')
const daemonEntry = resolve(root, 'apps/daemon/dist/index.js')
const echoFixture = resolve(root, 'tests/fixtures/mcp-echo-server.mjs')
const port = 9362
const endpoint = `http://127.0.0.1:${port}/json/list`

if (!existsSync(electron) || !existsSync(daemonEntry)) {
  console.error('缺少 Electron 或 daemon 产物,先执行 build')
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
    const timer = setTimeout(() => rej(new Error('CDP 连接超时')), 10000)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      const send = (method, params = {}, timeoutMs = 30000) =>
        new Promise((resolveCall, rejectCall) => {
          const myId = ++id
          const t = setTimeout(() => {
            waiting.delete(myId)
            rejectCall(new Error(`CDP ${method} 超时`))
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
    await sleep(200)
  }
  return false
}

async function makePlugin(sourceRoot, name, manifestPatch = {}) {
  const dir = join(sourceRoot, name)
  await mkdir(join(dir, 'dist'), { recursive: true })
  await cp(echoFixture, join(dir, 'dist/server.mjs'))
  const manifest = {
    schemaVersion: 1,
    name,
    displayName: '验收连接器',
    version: '1.0.0',
    kind: 'connector',
    publisher: 'owb-tests',
    minHostVersion: '0.0.1',
    description: '用于验收连接器工作台',
    mcpServers: {
      echo: {
        type: 'stdio',
        command: 'node',
        args: ['${PLUGIN_ROOT}/dist/server.mjs'],
        env: {},
        defer_loading: false
      }
    },
    permissions: [],
    credentials: [],
    highCreditTools: {},
    ...manifestPatch
  }
  if (manifest.kind === 'expert') manifest.mcpServers = {}
  await writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return dir
}

async function makeSkill(dir, name, description) {
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    ['---', `name: ${name}`, `description: ${description}`, '---', '', `# ${name}`, 'BODY-MARKER'].join('\n'),
    'utf8'
  )
  return dir
}

const base = await mkdtemp(join(tmpdir(), 'owb-hub-'))
const workspace = join(base, 'ws')
const dataDir = join(base, 'data')
const projectSkills = join(base, 'project-skills')
const userSkills = join(base, 'user-skills')
const pluginSource = join(base, 'plugin-src')
const importSource = join(base, 'import-src')
await mkdir(workspace, { recursive: true })
await mkdir(dataDir, { recursive: true })
await mkdir(pluginSource, { recursive: true })
await writeFile(join(workspace, 'README.md'), '# hub\n', 'utf8')

await makeSkill(join(projectSkills, 'zeta-skill'), 'zeta-skill', '项目级只读技能')
await makeSkill(join(projectSkills, 'alpha-skill'), 'alpha-skill', '项目级只读技能')
await makeSkill(join(importSource, 'beta-skill'), 'beta-skill', '从本地目录导入的用户技能')

const connectorDir = await makePlugin(pluginSource, 'hub-connector', {
  displayName: '资料检索',
  description: '检索企业资料的连接器'
})
const expertDir = await makePlugin(pluginSource, 'hub-expert', {
  kind: 'expert',
  displayName: '行业研究专家',
  description: '擅长行业分析与趋势判断'
})

const app = spawn(electron, [resolve(root, 'apps/desktop'), `--remote-debugging-port=${port}`], {
  cwd: workspace,
  env: {
    ...process.env,
    OPENWB_DAEMON_ENTRY: daemonEntry,
    OPENWB_WORKSPACE: workspace,
    OPENWB_DATA_DIR: dataDir,
    OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
    OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts'),
    OPENWB_SKILLS_DIR: projectSkills,
    OPENWB_USER_SKILLS_DIR: userSkills,
    OPENWB_MOCK: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
let appStderr = ''
app.stdout.on('data', () => {})
app.stderr.on('data', (b) => {
  appStderr += String(b)
})

let session
try {
  const page = await waitForPage()
  session = await connect(page.webSocketDebuggerUrl)
  const { evaluate, send: cdp } = session
  const shot = async (name) => {
    if (process.env.OPENWB_SHOTS !== '1') return
    const r = await cdp('Page.captureScreenshot', { format: 'png' }, 30000)
    if (!r.result?.data) return
    const dir = resolve(root, 'artifacts/screenshots')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${name}.png`)
    await writeFile(path, Buffer.from(r.result.data, 'base64'))
    console.log(`SHOT ${path}`)
  }
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="welcome"]'))`)

  await evaluate(`document.querySelector('[data-testid="open-skills"]').click()`)
  const opened = await waitFor(evaluate, `Boolean(document.querySelector('[aria-label="专家·技能·连接器"]'))`)
  check(opened, 'hub-opens-from-sidebar')
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="skill-card-zeta-skill"]'))`)
  await shot('skills-hub-installed')

  const header = await evaluate(`document.querySelector('[aria-label="专家·技能·连接器"]')?.innerText ?? ''`)
  check(header.includes('专家') && header.includes('技能') && header.includes('连接器'), 'hub-tabs-rendered', header.slice(0, 80))
  check(await evaluate(`document.querySelector('[aria-label="搜索技能"]')?.placeholder === '搜索技能'`), 'search-placeholder-skills')

  await evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('[aria-label="技能分类"] button')).find((x) => x.textContent.includes('技能市场'))
    b.click()
  })()`)
  const market = await waitFor(evaluate, `document.body.innerText.includes('市场内容暂不可用')`)
  check(market, 'market-empty-state')
  await evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('[aria-label="技能分类"] button')).find((x) => x.textContent.includes('已安装'))
    b.click()
  })()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="skill-card-alpha-skill"]'))`)

  await evaluate(`(() => {
    const el = document.querySelector('[aria-label="搜索技能"]')
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, 'no-such-skill')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  check(await waitFor(evaluate, `document.body.innerText.includes('没有找到匹配的技能')`), 'skill-search-empty')
  await evaluate(`document.querySelector('[aria-label="清空搜索"]')?.click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="skill-card-alpha-skill"]'))`)

  const toggleOff = await evaluate(`(() => {
    const b = document.querySelector('[aria-label="关闭 alpha-skill 自动触发"]')
    if (!b) return false
    b.click()
    return true
  })()`)
  check(toggleOff, 'skill-toggle-click')
  await waitFor(evaluate, `document.querySelector('[data-testid="skill-card-alpha-skill"]')?.innerText.includes('自动触发已关闭')`)
  check(
    await evaluate(`document.querySelector('[data-testid="skill-card-alpha-skill"]')?.innerText.includes('自动触发已关闭')`),
    'skill-toggle-updates-card'
  )

  await evaluate(`(() => {
    const el = document.querySelector('[data-testid="composer-input"]')
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(el, '/')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="picker-skill"]'))`)
  const pickerNames = await evaluate(
    `Array.from(document.querySelectorAll('[data-testid="picker-skill"]')).map((x) => x.innerText).join('|')`
  )
  check(pickerNames.includes('zeta-skill') && !pickerNames.includes('alpha-skill'), 'disabled-skill-hidden-in-composer', pickerNames)
  await evaluate(`(() => {
    const el = document.querySelector('[data-testid="composer-input"]')
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(el, '')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)

  await evaluate(`(() => {
    const card = document.querySelector('[data-testid="skill-card-zeta-skill"]')
    Array.from(card.querySelectorAll('button')).find((b) => b.textContent.trim() === '置顶').click()
  })()`)
  await waitFor(evaluate, `document.querySelector('[data-testid="skill-card-zeta-skill"]')?.innerText.includes('取消置顶')`)
  await evaluate(`(() => {
    const card = document.querySelector('[data-testid="skill-card-alpha-skill"]')
    Array.from(card.querySelectorAll('button')).find((b) => b.textContent.trim() === '置顶').click()
  })()`)
  await waitFor(evaluate, `document.querySelector('[data-testid="skill-card-alpha-skill"]')?.innerText.includes('取消置顶')`)
  const order = await evaluate(
    `Array.from(document.querySelectorAll('[data-testid^="skill-card-"]')).map((x) => x.dataset.testid).join(',')`
  )
  check(order.startsWith('skill-card-alpha-skill,skill-card-zeta-skill'), 'pinned-order-newest-first', order)

  await evaluate(`document.querySelector('[aria-label="关闭"]')?.click()`)
  await sleep(250)
  await cdp('Page.reload', { ignoreCache: false })
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="welcome"]'))`, 30000)
  await evaluate(`document.querySelector('[data-testid="open-skills"]').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="skill-card-alpha-skill"]'))`)
  const reloadRaw = await evaluate(`JSON.stringify({
    alpha: document.querySelector('[data-testid="skill-card-alpha-skill"]')?.innerText ?? '',
    order: Array.from(document.querySelectorAll('[data-testid^="skill-card-"]')).map((x) => x.dataset.testid).join(',')
  })`)
  const reloadState = JSON.parse(reloadRaw)
  check(reloadState.alpha.includes('自动触发已关闭'), 'disabled-skill-persists-after-reload', reloadRaw)
  check(reloadState.order.startsWith('skill-card-alpha-skill,skill-card-zeta-skill'), 'pinned-order-persists-after-reload', reloadState.order)

  const imported = await evaluate(
    `window.openwb.skills.importDirectory(${JSON.stringify(join(importSource, 'beta-skill'))})`
  )
  check(imported?.imported === 'beta-skill', 'skill-import-via-api', JSON.stringify(imported))
  await evaluate(`document.querySelector('[aria-label="关闭"]')?.click()`)
  await evaluate(`document.querySelector('[data-testid="open-skills"]').click()`)
  const importedVisible = await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="skill-card-beta-skill"]'))`)
  check(importedVisible, 'imported-skill-visible')
  check(
    await evaluate(`document.querySelector('[data-testid="skill-card-beta-skill"]')?.innerText.includes('用户技能')`),
    'imported-skill-scope-user'
  )
  await shot('skills-hub-imported')

  await evaluate(`(() => {
    const card = document.querySelector('[data-testid="skill-card-beta-skill"]')
    Array.from(card.querySelectorAll('button')).find((b) => b.textContent.trim() === '卸载').click()
  })()`)
  const confirm = await waitFor(evaluate, `Boolean(document.querySelector('[role="alertdialog"]'))`)
  check(confirm, 'uninstall-confirm-visible')
  await evaluate(`(() => {
    const d = document.querySelector('[role="alertdialog"]')
    Array.from(d.querySelectorAll('button')).find((b) => b.textContent.trim() === '卸载').click()
  })()`)
  const removed = await waitFor(evaluate, `!document.querySelector('[data-testid="skill-card-beta-skill"]')`)
  check(removed, 'user-skill-uninstalled')
  check(!existsSync(join(userSkills, 'beta-skill')), 'uninstall-removes-files')

  const installedPlugin = await evaluate(
    `window.openwb.plugins.install({ sourceDir: ${JSON.stringify(connectorDir)}, confirmShell: true })`
  )
  check(installedPlugin?.plugin?.name === 'hub-connector', 'connector-installed', JSON.stringify(installedPlugin).slice(0, 200))
  const installedExpert = await evaluate(
    `window.openwb.plugins.install({ sourceDir: ${JSON.stringify(expertDir)}, confirmShell: true })`
  )
  check(installedExpert?.plugin?.kind === 'expert', 'expert-installed', JSON.stringify(installedExpert).slice(0, 200))

  await evaluate(`document.querySelector('[aria-label="关闭"]')?.click()`)
  await evaluate(`document.querySelector('[data-testid="open-skills"]').click()`)
  await evaluate(`document.querySelector('[data-testid="hub-tab-connectors"]').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="connector-card-hub-connector"]'))`)
  const connectorText = await evaluate(`document.querySelector('[data-testid="connector-card-hub-connector"]')?.innerText ?? ''`)
  check(connectorText.includes('已连接') || connectorText.includes('连接中'), 'connector-ready-state', connectorText)
  check(connectorText.includes('资料检索'), 'connector-display-name')
  const connectorHeader = await evaluate(`document.querySelector('[aria-label="专家·技能·连接器"]')?.innerText ?? ''`)
  check(connectorHeader.includes('已安装') && connectorHeader.includes('可用'), 'connector-groups')
  await shot('skills-hub-connectors')

  const probed = await evaluate(`window.openwb.plugins.probe('hub-connector')`)
  check(probed?.ok === true && Number(probed.tools) >= 4, 'connector-probe-ok', JSON.stringify(probed))

  await evaluate(`(() => {
    const card = document.querySelector('[data-testid="connector-card-hub-connector"]')
    Array.from(card.querySelectorAll('button')).find((b) => b.textContent.trim() === '断开').click()
  })()`)
  const disconnected = await waitFor(
    evaluate,
    `Boolean(document.querySelector('[data-testid="connector-group-available"] [data-testid="connector-card-hub-connector"]'))`,
    20000
  )
  check(disconnected, 'connector-disconnect')
  check(
    !(await evaluate(`Boolean(document.querySelector('[data-testid="connector-group-installed"] [data-testid="connector-card-hub-connector"]'))`)),
    'connector-removed-from-installed'
  )

  await evaluate(`document.querySelector('[data-testid="hub-tab-experts"]').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="expert-card-hub-expert"]'))`)
  const expertText = await evaluate(`document.querySelector('[data-testid="expert-card-hub-expert"]')?.innerText ?? ''`)
  check(expertText.includes('行业研究专家') && expertText.includes('专家'), 'expert-card-rendered', expertText)
  check(!(await evaluate(`Boolean(document.querySelector('[data-testid="expert-card-hub-connector"]'))`)), 'connector-not-in-experts')
  await evaluate(`(() => {
    const el = document.querySelector('[aria-label="搜索专家"]')
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, 'nothing')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  check(await waitFor(evaluate, `document.body.innerText.includes('没有找到匹配的专家')`), 'expert-search-empty')
  await shot('skills-hub-experts')

  await evaluate(`document.querySelector('[data-testid="hub-tab-connectors"]').click()`)
  await evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('[aria-label="连接器分类"] button')).find((x) => x.textContent.includes('企业连接器'))
    b.click()
  })()`)
  check(await waitFor(evaluate, `document.body.innerText.includes('当前企业暂无可用的连接器')`), 'enterprise-connector-empty')

  await evaluate(`window.openwb.plugins.uninstall('hub-connector')`)
  await evaluate(`window.openwb.plugins.uninstall('hub-expert')`)
} finally {
  try {
    session?.ws?.close()
  } catch {}
  app.kill()
  await sleep(500)
  await rm(base, { recursive: true, force: true })
}

if (failed > 0) {
  console.log(`\n${failed} 项失败`)
  if (appStderr) console.log(appStderr.slice(-2000))
  process.exit(1)
}
console.log('\n专家·技能·连接器工作台验收全部通过')

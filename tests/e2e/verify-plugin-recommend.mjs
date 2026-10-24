/**
 * 任务匹配推荐验收(WM-PLUGIN-04)。
 *
 * 覆盖:
 *   - 任务命中时出现推荐卡片,且最多 3 张;
 *   - 已连接的连接器不再推荐,点击"连接"后真正启用;
 *   - 当前会话的专家不再推荐,点击"启用专家"后进入该专家;
 *   - 关闭单张推荐后该卡片消失。
 *
 * 用法: node tests/e2e/verify-plugin-recommend.mjs
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
const port = 9391
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
      res({ ws, evaluate })
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      rej(new Error('CDP 连接失败'))
    })
  })
}

async function waitFor(evaluate, expression, timeoutMs = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await evaluate(expression)) return true
    await sleep(200)
  }
  return false
}

async function writePlugin(sourceRoot, name, manifestPatch = {}) {
  const dir = join(sourceRoot, name)
  await mkdir(join(dir, 'dist'), { recursive: true })
  await cp(echoFixture, join(dir, 'dist/server.mjs'))
  const manifest = {
    schemaVersion: 1,
    name,
    displayName: name,
    version: '1.0.0',
    kind: 'expert',
    publisher: 'owb-tests',
    minHostVersion: '0.0.1',
    description: '',
    mcpServers: {},
    permissions: [],
    credentials: [],
    highCreditTools: {},
    ...manifestPatch
  }
  if (manifest.kind === 'expert') manifest.mcpServers = {}
  await writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return dir
}

const baseDir = await mkdtemp(join(tmpdir(), 'owb-recommend-'))
const workdir = join(baseDir, 'ws')
const dataDir = join(baseDir, 'data')
const userData = join(baseDir, 'user-data')
const pluginSource = join(baseDir, 'plugin-src')
for (const dir of [workdir, dataDir, userData]) await mkdir(dir, { recursive: true })
await writeFile(join(workdir, 'README.md'), '# recommend\n', 'utf8')

const experts = [
  ['contract-review', '合同审查专家', '合同审查与违约条款解读'],
  ['compliance-risk', '合规风险专家', '合同合规风险与责任上限'],
  ['contract-draft', '合同起草专家', '合同起草与条款修订'],
  ['clause-diff', '条款比对专家', '合同条款比对与差异说明']
]
const dirs = []
for (const [name, displayName, description] of experts) {
  dirs.push(
    await writePlugin(pluginSource, name, {
      displayName,
      description,
      instructions: `${displayName}的专业准则:先给结论,再列依据。`
    })
  )
}
const jiraDir = await writePlugin(pluginSource, 'jira-connector', {
  displayName: 'Jira 连接器',
  kind: 'connector',
  description: '读取 Jira 项目、缺陷与迭代数据',
  mcpServers: {
    echo: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/dist/server.mjs'], env: {}, defer_loading: false }
  }
})

const app = spawn(
  electron,
  [resolve(root, 'apps/desktop'), `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`],
  {
    cwd: workdir,
    env: {
      ...process.env,
      OPENWB_DAEMON_ENTRY: daemonEntry,
      OPENWB_WORKSPACE: workdir,
      OPENWB_DATA_DIR: dataDir,
      OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
      OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts'),
      OPENWB_MOCK: '1',
      OPENWB_AUTOMATION_AUTOSTART: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  }
)
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
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="composer-input"]'))`)

  for (const dir of [...dirs, jiraDir]) {
    const installed = await evaluate(
      `window.openwb.plugins.install({ sourceDir: ${JSON.stringify(dir)}, confirmShell: true })`
    )
    check(Boolean(installed?.plugin?.name), `install-${installed?.plugin?.name ?? 'unknown'}`)
  }
  // 连接器安装后默认已连接;先关闭,才能验证"推荐未连接项 → 点击后连接"。
  await evaluate(`window.openwb.plugins.setEnabled({ name: 'jira-connector', enabled: false })`)

  const typeText = (value) => `(() => {
    const input = document.querySelector('textarea[data-testid="composer-input"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(value)})
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`

  // ── 1. 匹配任务 → 出现推荐,且最多 3 张 ─────────────────────────────────
  await evaluate(typeText('帮我审查这份合同的违约条款与合规风险'))
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="plugin-recommendations"]'))`),
    'matched-task-shows-recommendations'
  )
  const cardCount = await evaluate(
    `document.querySelectorAll('[data-testid="plugin-recommendations"] [data-testid^="plugin-recommend-"]:not([data-testid^="plugin-recommend-use-"]):not([data-testid^="plugin-recommend-dismiss-"])').length`
  )
  check(cardCount === 3, 'recommendation-card-cap-3', String(cardCount))
  check(
    !(await evaluate(`Boolean(document.querySelector('[data-testid="plugin-recommend-jira-connector"]'))`)),
    'unrelated-connector-not-recommended'
  )

  // 关闭一张推荐:本次运行内不再出现
  const dismissName = await evaluate(
    `document.querySelector('[data-testid^="plugin-recommend-dismiss-"]').getAttribute('data-testid').replace('plugin-recommend-dismiss-', '')`
  )
  await evaluate(`document.querySelector('[data-testid="plugin-recommend-dismiss-${dismissName}"]').click()`)
  await sleep(300)
  check(
    !(await evaluate(`Boolean(document.querySelector('[data-testid="plugin-recommend-${dismissName}"]'))`)),
    'dismiss-hides-card',
    dismissName
  )

  // ── 2. 未连接的连接器可被推荐,点击后真正启用 ────────────────────────────
  await evaluate(typeText('整理 Jira 里本周的缺陷并列出优先级'))
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="plugin-recommend-jira-connector"]'))`),
    'disconnected-connector-recommended'
  )
  await evaluate(`document.querySelector('[data-testid="plugin-recommend-use-jira-connector"]').click()`)
  check(
    await waitFor(
      evaluate,
      `(async () => ((await window.openwb.plugins.list()).plugins.find((p) => p.name === 'jira-connector')?.enabled ?? false))()`
    ),
    'connector-click-enables-plugin'
  )
  check(
    await waitFor(
      evaluate,
      `!document.querySelector('[data-testid="plugin-recommend-jira-connector"]')`
    ),
    'connected-connector-no-longer-recommended'
  )
  const afterConnect = await evaluate(
    `window.openwb.plugins.recommend({ text: '整理 Jira 里本周的缺陷并列出优先级' })`
  )
  check(
    !(afterConnect?.recommendations ?? []).some((item) => item.name === 'jira-connector'),
    'daemon-excludes-connected-connector'
  )

  // ── 3. 点击"启用专家"进入该专家,之后同专家不再推荐 ───────────────────────
  await evaluate(typeText('帮我审查这份合同的违约条款与合规风险'))
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid^="plugin-recommend-use-contract-"]'))`)
  const expertName = await evaluate(`(() => {
    const button = document.querySelector('[data-testid^="plugin-recommend-use-contract-"]')
    return button ? button.getAttribute('data-testid').replace('plugin-recommend-use-', '') : ''
  })()`)
  check(Boolean(expertName), 'expert-recommendation-has-action', expertName)
  await evaluate(`document.querySelector('[data-testid="plugin-recommend-use-${expertName}"]').click()`)
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="active-expert-banner"]'))`),
    'expert-click-activates-expert'
  )
  const activeText = await evaluate(
    `document.querySelector('[data-testid="active-expert-banner"]')?.innerText ?? ''`
  )
  check(activeText.includes('专家'), 'active-banner-shown', activeText)

  const expertRecs = await evaluate(
    `window.openwb.plugins.recommend({ text: '帮我审查这份合同的违约条款与合规风险', activeExpertId: ${JSON.stringify(expertName)} })`
  )
  check(
    !(expertRecs?.recommendations ?? []).some((item) => item.name === expertName),
    'daemon-excludes-active-expert'
  )
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
  await rm(baseDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }).catch(() => undefined)
}

process.exit(failed === 0 ? 0 : 1)

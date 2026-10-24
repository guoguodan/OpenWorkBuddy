/**
 * 专家互斥界面验收(WM-MODE-07)。
 *
 * 覆盖:
 *   - 启用第一个专家后出现"仅允许一个专家"提示;
 *   - 再选另一个专家先弹确认框,取消后仍在原专家;
 *   - 确认后才切换到新专家,旧专家的会话仍留在列表里;
 *   - 团队专家卡片显示成员数与详情成员列表。
 *
 * 用法: node tests/e2e/verify-expert-exclusive-ui.mjs
 * 前置: pnpm --filter @openwb/daemon build && pnpm --filter @openwb/desktop build
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const electron = resolve(root, 'apps/desktop/node_modules/electron/dist/electron.exe')
const daemonEntry = resolve(root, 'apps/daemon/dist/index.js')
const port = 9388
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

async function waitFor(evaluate, expression, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await evaluate(expression)) return true
    await sleep(200)
  }
  return false
}

async function writeExpert(sourceRoot, name, patch = {}) {
  const dir = join(sourceRoot, name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'plugin.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        name,
        displayName: name,
        version: '1.0.0',
        kind: 'expert',
        publisher: 'owb-tests',
        minHostVersion: '0.0.1',
        description: '验收用专家',
        instructions: '先给结论,再列证据。',
        mcpServers: {},
        permissions: [],
        credentials: [],
        highCreditTools: {},
        ...patch
      },
      null,
      2
    ),
    'utf8'
  )
  return dir
}

const baseDir = await mkdtemp(join(tmpdir(), 'owb-expert-exclusive-'))
const workdir = join(baseDir, 'ws')
const dataDir = join(baseDir, 'data')
const userData = join(baseDir, 'user-data')
const pluginSource = join(baseDir, 'plugin-src')
for (const dir of [workdir, dataDir, userData]) await mkdir(dir, { recursive: true })
await writeFile(join(workdir, 'README.md'), '# expert exclusive\n', 'utf8')

const legalDir = await writeExpert(pluginSource, 'legal-expert', {
  displayName: '法务顾问',
  instructions: 'LEGAL-UI-SECRET 关注违约与责任上限。'
})
const financeDir = await writeExpert(pluginSource, 'finance-expert', {
  displayName: '财务分析师',
  instructions: 'FINANCE-UI-SECRET 先算现金流。'
})
const teamDir = await writeExpert(pluginSource, 'deal-team', {
  displayName: '并购专家团队',
  description: '法务与财务协同',
  instructions: 'TEAM-UI-SECRET 同时覆盖法律与财务。',
  team: [
    { ref: 'legal-expert', role: '合规' },
    { ref: 'finance-expert' }
  ]
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
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="welcome"]'))`)

  for (const dir of [legalDir, financeDir, teamDir]) {
    const installed = await evaluate(
      `window.openwb.plugins.install({ sourceDir: ${JSON.stringify(dir)}, confirmShell: true })`
    )
    check(Boolean(installed?.plugin?.name), `install-${installed?.plugin?.name ?? 'unknown'}`, JSON.stringify(installed ?? null).slice(0, 200))
  }

  await evaluate(`document.querySelector('[data-testid="open-skills"]').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="hub-tab-experts"]'))`)
  await evaluate(`document.querySelector('[data-testid="hub-tab-experts"]').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="expert-card-legal-expert"]'))`)

  const teamBadge = await evaluate(
    `document.querySelector('[data-testid="expert-team-badge-deal-team"]')?.innerText ?? ''`
  )
  check(teamBadge.includes('2'), 'team-card-shows-member-count', teamBadge)

  await evaluate(`(() => {
    const card = document.querySelector('[data-testid="expert-card-deal-team"]')
    Array.from(card.querySelectorAll('button')).find((b) => b.textContent.trim() === '详情').click()
  })()`)
  const detail = await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="expert-team-members"]'))`)
  check(detail, 'team-detail-lists-members')
  const detailText = await evaluate(
    `document.querySelector('[data-testid="expert-team-members"]')?.innerText ?? ''`
  )
  check(
    detailText.includes('法务顾问') && detailText.includes('财务分析师') && detailText.includes('合规'),
    'team-detail-member-roles',
    detailText
  )
  await evaluate(`document.querySelector('[aria-label="关闭详情"]')?.click()`)

  await evaluate(`document.querySelector('[data-testid="use-expert-legal-expert"]').click()`)
  check(
    await waitFor(
      evaluate,
      `document.querySelector('[data-testid="active-expert-banner"]')?.innerText.includes('法务顾问') ?? false`
    ),
    'first-expert-active'
  )
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="expert-exclusive-hint"]'))`),
    'exclusive-hint-visible'
  )

  // 已激活时再次选同一个专家:直接回到当前任务,不弹互斥框。
  await evaluate(`document.querySelector('[data-testid="open-skills"]').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="hub-tab-experts"]'))`)
  await evaluate(`document.querySelector('[data-testid="hub-tab-experts"]').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="use-expert-legal-expert"]'))`)
  await evaluate(`document.querySelector('[data-testid="use-expert-legal-expert"]').click()`)
  await sleep(300)
  check(
    !(await evaluate(`Boolean(document.querySelector('[data-testid="expert-conflict-dialog"]'))`)),
    'same-expert-no-conflict-dialog'
  )

  // 换成第二个专家:先出现互斥提示。
  await evaluate(`document.querySelector('[data-testid="open-skills"]').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="hub-tab-experts"]'))`)
  await evaluate(`document.querySelector('[data-testid="hub-tab-experts"]').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="use-expert-finance-expert"]'))`)
  await evaluate(`document.querySelector('[data-testid="use-expert-finance-expert"]').click()`)
  const dialog = await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="expert-conflict-dialog"]'))`)
  check(
    dialog,
    'second-expert-shows-conflict-dialog',
    await evaluate(`JSON.stringify({
      banner: document.querySelector('[data-testid="active-expert-banner"]')?.innerText ?? null,
      hub: Boolean(document.querySelector('[data-testid="use-expert-finance-expert"]')),
      dialog: Boolean(document.querySelector('[data-testid="expert-conflict-dialog"]'))
    })`)
  )
  const dialogText = await evaluate(
    `document.querySelector('[data-testid="expert-conflict-text"]')?.innerText ?? ''`
  )
  check(
    dialogText.includes('法务顾问') && dialogText.includes('财务分析师'),
    'dialog-names-both-experts',
    dialogText
  )

  await evaluate(`document.querySelector('[data-testid="expert-conflict-cancel"]').click()`)
  await sleep(300)
  check(
    !(await evaluate(`Boolean(document.querySelector('[data-testid="expert-conflict-dialog"]'))`)),
    'cancel-closes-dialog'
  )
  check(
    await evaluate(
      `document.querySelector('[data-testid="active-expert-banner"]')?.innerText.includes('法务顾问') ?? false`
    ),
    'cancel-keeps-current-expert'
  )

  await evaluate(`document.querySelector('[data-testid="use-expert-finance-expert"]')?.click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="expert-conflict-confirm"]'))`)
  await evaluate(`document.querySelector('[data-testid="expert-conflict-confirm"]').click()`)
  check(
    await waitFor(
      evaluate,
      `document.querySelector('[data-testid="active-expert-banner"]')?.innerText.includes('财务分析师') ?? false`
    ),
    'confirm-switches-expert'
  )
  check(
    !(await evaluate(`Boolean(document.querySelector('[data-testid="active-expert-banner"]')?.innerText.includes('法务顾问'))`)),
    'old-expert-banner-gone'
  )
  const list = await evaluate(`window.openwb.conversation.list()`)
  const experts = (list?.conversations ?? []).map((c) => c.expertId).filter(Boolean).sort()
  check(
    experts.includes('legal-expert') && experts.includes('finance-expert'),
    'both-expert-conversations-preserved',
    JSON.stringify(experts)
  )

  // 团队同样算一个专家:从财务切换到团队也必须确认。
  await evaluate(`document.querySelector('[data-testid="open-skills"]').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="hub-tab-experts"]'))`)
  await evaluate(`document.querySelector('[data-testid="hub-tab-experts"]').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="use-expert-deal-team"]'))`)
  await evaluate(`document.querySelector('[data-testid="use-expert-deal-team"]').click()`)
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="expert-conflict-dialog"]'))`),
    'team-also-requires-confirmation'
  )
  await evaluate(`document.querySelector('[data-testid="expert-conflict-confirm"]').click()`)
  check(
    await waitFor(
      evaluate,
      `document.querySelector('[data-testid="active-expert-banner"]')?.innerText.includes('并购专家团队') ?? false`
    ),
    'team-becomes-active-expert'
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

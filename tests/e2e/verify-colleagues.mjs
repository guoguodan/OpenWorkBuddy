/**
 * 助理档案与运行时约束验收。
 *
 * 桌面端 UI:
 *   创建完整档案、编辑、置顶、暂停/恢复、暂停后指派按钮禁用、刷新后保持。
 * daemon 运行链:
 *   暂停拒绝新建与发送、频道未绑定拒绝召唤、技能白名单真正收窄、
 *   未绑定连接器时第三方工具不可见、memoryEnabled=false 不注入记忆。
 *
 * 用法: node tests/e2e/verify-colleagues.mjs
 * 前置: pnpm --filter @openwb/daemon build && pnpm --filter @openwb/desktop build
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
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
const port = 9338
const endpoint = `http://127.0.0.1:${port}/json/list`
const require = createRequire(resolve(root, 'apps/daemon/package.json'))
const Database = require('better-sqlite3')

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

// ── CDP ───────────────────────────────────────────────────────────────────
async function waitForPage(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await (await fetch(endpoint)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch {}
    await sleep(500)
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
      const send = (method, params = {}, timeoutMs = 20000) =>
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

async function waitFor(evaluate, expression, timeoutMs = 25000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await evaluate(expression)) return true
    await sleep(250)
  }
  return false
}

// ── daemon 交互会话 ────────────────────────────────────────────────────────
function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.length, 0)
  return Buffer.concat([header, payload])
}

function decodeFrames(buf) {
  const out = []
  let offset = 0
  while (buf.length - offset >= 4) {
    const len = buf.readUInt32BE(offset)
    if (buf.length - offset < 4 + len) break
    const json = buf.subarray(offset + 4, offset + 4 + len).toString('utf8')
    offset += 4 + len
    try {
      out.push(JSON.parse(json))
    } catch {
      out.push({ type: 'PARSE_ERROR' })
    }
  }
  return out
}

function openSession(workspace, dataDir, extraEnv = {}) {
  const child = spawn(process.execPath, [daemonEntry], {
    cwd: root,
    env: {
      ...process.env,
      OPENWB_MOCK: '1',
      OPENWB_WORKSPACE: workspace,
      OPENWB_DATA_DIR: dataDir,
      OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
      OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts'),
      OPENWB_AUTOMATION_AUTOSTART: '0',
      ...extraEnv
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const chunks = []
  let err = ''
  let cursor = 0
  child.stdout.on('data', (b) => chunks.push(b))
  child.stderr.on('data', (b) => {
    err += String(b)
  })
  const closed = new Promise((r) => child.on('close', (code) => r(code)))
  const events = () => decodeFrames(Buffer.concat(chunks))
  const send = (frame) => child.stdin.write(encodeFrame(frame))
  const waitForEvent = async (predicate, timeoutMs = 30000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const all = events()
      for (let i = cursor; i < all.length; i++) {
        if (predicate(all[i])) {
          cursor = i + 1
          return all[i]
        }
      }
      await sleep(40)
    }
    return null
  }
  const call = async (frame, type, timeoutMs = 30000) => {
    const requestId = frame.requestId ?? `r-${Math.random().toString(36).slice(2, 8)}`
    send({ ...frame, requestId })
    return waitForEvent((e) => e.requestId === requestId && (e.type === type || e.type === 'error'), timeoutMs)
  }
  // 运行链的 done/错误是流式终态,不携带命令 requestId,必须按运行终态等待。
  const run = async (frame, timeoutMs = 30000) => {
    send({
      ...frame,
      requestId: frame.requestId ?? `r-${Math.random().toString(36).slice(2, 8)}`
    })
    return waitForEvent((e) => e.type === 'done' || e.type === 'error', timeoutMs)
  }
  const close = async () => {
    child.stdin.end()
    await Promise.race([closed, sleep(3000)])
    child.kill()
  }
  return { child, send, call, run, waitForEvent, events, close, stderr: () => err }
}

async function makePlugin(sourceRoot, name) {
  const dir = join(sourceRoot, name)
  await mkdir(join(dir, 'dist'), { recursive: true })
  await cp(echoFixture, join(dir, 'dist/server.mjs'))
  await writeFile(
    join(dir, 'plugin.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        name,
        displayName: '验收连接器',
        version: '1.0.0',
        kind: 'connector',
        publisher: 'owb-tests',
        minHostVersion: '0.0.1',
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
        highCreditTools: {}
      },
      null,
      2
    ),
    'utf8'
  )
  return dir
}

const base = await mkdtemp(join(tmpdir(), 'owb-colleagues-'))
const uiWorkspace = join(base, 'ui-ws')
const uiData = join(base, 'ui-data')
const chainWorkspace = join(base, 'chain-ws')
const chainData = join(base, 'chain-data')
const chainDb = join(chainData, 'openwb.db')
const skillsDir = join(base, 'skills')
const pluginSource = join(base, 'plugin-src')

await mkdir(uiWorkspace, { recursive: true })
await mkdir(uiData, { recursive: true })
await mkdir(chainWorkspace, { recursive: true })
await mkdir(chainData, { recursive: true })
await mkdir(pluginSource, { recursive: true })
await writeFile(join(chainWorkspace, 'README.md'), '# colleague chain\n', 'utf8')

for (const [name, allowed] of [
  ['research', 'read_file, glob'],
  ['writer', 'write_file, read_file']
]) {
  await mkdir(join(skillsDir, name), { recursive: true })
  await writeFile(
    join(skillsDir, name, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: ${name} 验收技能`,
      `allowed-tools: ${allowed}`,
      '---',
      '',
      `# ${name}`,
      `BODY-${name.toUpperCase()}-MARKER`
    ].join('\n'),
    'utf8'
  )
}

const pluginDir = await makePlugin(pluginSource, 'colleague-connector')

const app = spawn(electron, [resolve(root, 'apps/desktop'), `--remote-debugging-port=${port}`], {
  cwd: uiWorkspace,
  env: {
    ...process.env,
    OPENWB_DAEMON_ENTRY: daemonEntry,
    OPENWB_WORKSPACE: uiWorkspace,
    OPENWB_DATA_DIR: uiData,
    OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
    OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts'),
    OPENWB_SKILLS_DIR: skillsDir,
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
  const { evaluate } = session
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="welcome"]'))`)

  const fillField = async (label, value) => {
    await evaluate(`(() => {
      const field = Array.from(document.querySelectorAll('[data-testid="colleague-form"] label')).find((l) => l.textContent.trim().startsWith(${JSON.stringify(label)}))
      if (!field) throw new Error('缺少字段 ' + ${JSON.stringify(label)})
      const el = field.querySelector('input,textarea')
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await sleep(80)
  }
  const clickCardButton = (name, pattern) =>
    evaluate(`(() => {
      const card = Array.from(document.querySelectorAll('[data-testid="colleague-card"]')).find((c) => c.textContent.includes(${JSON.stringify(name)}))
      if (!card) throw new Error('缺少助理卡片 ' + ${JSON.stringify(name)})
      const b = Array.from(card.querySelectorAll('button')).find((x) => (x.getAttribute('aria-label') ?? x.textContent).includes(${JSON.stringify(pattern)}))
      if (!b) throw new Error('缺少按钮 ' + ${JSON.stringify(pattern)})
      b.click()
    })()`)
  const cardText = (name) =>
    evaluate(`Array.from(document.querySelectorAll('[data-testid="colleague-card"]')).find((c) => c.textContent.includes(${JSON.stringify(name)}))?.innerText ?? ''`)

  // ---------- UI 1. 创建完整档案 ----------
  await evaluate(`document.querySelector('[data-testid="open-colleagues"]').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[role="dialog"][aria-label="助理"]'))`)
  await evaluate(`document.querySelector('[data-testid="colleague-create"]').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="colleague-form"]'))`)
  await fillField('助理名称', '档案助理')
  await fillField('职责标签', '行业研究')
  await fillField('简介', '把复杂资料拆成可执行结论')
  await fillField('工作准则', '回答先给结论')
  await evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('[data-testid="colleague-form"] .owb-visibility')).find((x) => x.textContent.includes('发布到项目'))
    b.click()
  })()`)
  await evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('[data-testid="colleague-form"] .owb-chip-button')).find((x) => x.textContent.trim() === 'research')
    if (!b) throw new Error('技能未列出')
    b.click()
  })()`)
  await evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('[data-testid="colleague-form"] .owb-form__actions button')).find((x) => x.textContent.trim() === '创建')
    b.click()
  })()`)
  const created = await waitFor(
    evaluate,
    `Boolean(Array.from(document.querySelectorAll('[data-testid="colleague-card"]')).find((c) => c.textContent.includes('档案助理')))`
  )
  const createdText = await cardText('档案助理')
  check(created, 'colleague-created-from-form', createdText.slice(0, 200))
  check(createdText.includes('发布到项目'), 'visibility-persisted', createdText)
  check(createdText.includes('research'), 'skill-binding-shown', createdText)
  check(createdText.includes('记忆开启'), 'memory-default-on', createdText)

  // ---------- UI 2. 编辑档案 ----------
  await clickCardButton('档案助理', '编辑')
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="colleague-form"]'))`)
  const editTitle = await evaluate(`document.querySelector('[data-testid="colleague-form"] h3')?.textContent?.trim() ?? ''`)
  check(editTitle === '编辑档案', 'edit-form-opened', editTitle)
  await fillField('职责标签', '深度研究')
  await evaluate(`(() => {
    const label = Array.from(document.querySelectorAll('[data-testid="colleague-form"] label')).find((l) => l.textContent.includes('记忆注入'))
    const box = label.querySelector('input[type=checkbox]')
    if (box.checked) box.click()
  })()`)
  await evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('[data-testid="colleague-form"] .owb-form__actions button')).find((x) => x.textContent.trim() === '保存')
    b.click()
  })()`)
  await waitFor(
    evaluate,
    `Array.from(document.querySelectorAll('[data-testid="colleague-card"]')).some((c) => c.textContent.includes('深度研究'))`
  )
  const editedText = await cardText('档案助理')
  check(editedText.includes('深度研究'), 'profile-saved', editedText)
  check(editedText.includes('记忆关闭'), 'memory-disabled-shown', editedText)

  // ---------- UI 3. 置顶 ----------
  await clickCardButton('档案助理', '置顶')
  const pinned = await waitFor(
    evaluate,
    `Array.from(document.querySelectorAll('[data-testid="colleague-card"]')).find((c) => c.textContent.includes('档案助理'))?.innerText.includes('置顶')`
  )
  check(pinned, 'pin-applied')

  // ---------- UI 4. 暂停 → 指派禁用 → 恢复 ----------
  await clickCardButton('档案助理', '暂停助理')
  const paused = await waitFor(
    evaluate,
    `Array.from(document.querySelectorAll('[data-testid="colleague-card"]')).find((c) => c.textContent.includes('档案助理'))?.innerText.includes('已暂停')`
  )
  check(paused, 'pause-applied')
  const assignState = await evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('[data-testid="colleague-card"]')).find((c) => c.textContent.includes('档案助理'))
    const b = card.querySelector('[data-testid="colleague-assign"]')
    return JSON.stringify({ disabled: b.disabled, text: b.textContent.trim() })
  })()`)
  check(assignState.includes('"disabled":true'), 'assign-disabled-when-paused', assignState)

  await clickCardButton('档案助理', '恢复助理')
  const resumed = await waitFor(
    evaluate,
    `Array.from(document.querySelectorAll('[data-testid="colleague-card"]')).find((c) => c.textContent.includes('档案助理'))?.innerText.includes('可用')`
  )
  check(resumed, 'resume-applied')

  // ---------- UI 5. 刷新后持久化 ----------
  await evaluate(`location.reload()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="welcome"]'))`, 40000)
  await evaluate(`document.querySelector('[data-testid="open-colleagues"]').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="colleague-card"]'))`)
  const reloadedText = await cardText('档案助理')
  check(reloadedText.includes('深度研究'), 'profile-survives-reload', reloadedText)
  check(reloadedText.includes('置顶'), 'pin-survives-reload', reloadedText)
  check(reloadedText.includes('可用'), 'status-survives-reload', reloadedText)
  check(reloadedText.includes('发布到项目'), 'visibility-survives-reload', reloadedText)
  check(reloadedText.includes('记忆关闭'), 'memory-flag-survives-reload', reloadedText)

  // ---------- 运行链 1. 暂停拒绝新建与发送 ----------
  const s = openSession(chainWorkspace, chainData, { OPENWB_SKILLS_DIR: skillsDir })
  await s.waitForEvent((e) => e.type === 'ready')
  const pausedColleague = await s.call(
    { cmd: 'colleagues.create', name: '暂停助理', status: 'paused' },
    'colleagues.created'
  )
  check(pausedColleague?.colleague?.status === 'paused', 'daemon-create-paused', JSON.stringify(pausedColleague))

  const newRejected = await s.call(
    { cmd: 'conversation.new', title: '暂停会话', colleagueId: pausedColleague?.colleague?.id },
    'conversation.created'
  )
  check(newRejected?.type === 'error' && /已暂停/.test(newRejected.message ?? ''), 'paused-rejects-new-conversation', JSON.stringify(newRejected))

  const localConv = await s.call({ cmd: 'conversation.new', title: '本地会话' }, 'conversation.created')
  const conversationId = localConv?.conversationId
  check(!!conversationId, 'local-conversation-created')
  const sendRejected = await s.run(
    { text: '不应运行', colleagueId: pausedColleague?.colleague?.id, conversationId },
  )
  check(sendRejected?.type === 'error' && /已暂停/.test(sendRejected.message ?? ''), 'paused-rejects-send', JSON.stringify(sendRejected))

  // ---------- 运行链 2. 频道绑定 ----------
  const channel = await s.call({ cmd: 'channel.create', name: '产品设计' }, 'channel.created')
  const channelId = channel?.channel?.id
  const channelColleague = await s.call(
    { cmd: 'colleagues.create', name: '频道助理', channelIds: [] },
    'colleagues.created'
  )
  const channelReject = await s.call(
    {
      cmd: 'conversation.new',
      title: '频道会话',
      channelId,
      colleagueId: channelColleague?.colleague?.id
    },
    'conversation.created'
  )
  check(!!channelId && channelReject?.type === 'error' && /未绑定/.test(channelReject.message ?? ''), 'unbound-channel-rejected', JSON.stringify(channelReject))

  const bound = await s.call(
    { cmd: 'colleagues.update', id: channelColleague?.colleague?.id, channelIds: [channelId] },
    'colleagues.updated'
  )
  check(Array.isArray(bound?.colleague?.channelIds) && bound.colleague.channelIds[0] === channelId, 'channel-binding-saved')
  const channelAllowed = await s.call(
    {
      cmd: 'conversation.new',
      title: '已绑定频道',
      channelId,
      colleagueId: channelColleague?.colleague?.id
    },
    'conversation.created'
  )
  check(channelAllowed?.type === 'conversation.created', 'bound-channel-allowed', JSON.stringify(channelAllowed))

  // ---------- 运行链 3. 技能白名单 ----------
  const research = await s.call(
    { cmd: 'colleagues.create', name: '研究助理', skillNames: ['research'] },
    'colleagues.created'
  )
  const researchId = research?.colleague?.id
  const researchConv = await s.call(
    { cmd: 'conversation.new', title: '研究会话', colleagueId: researchId },
    'conversation.created'
  )
  const researchConversationId = researchConv?.conversationId
  const done = await s.run(
    { text: '加载 demo-skill', conversationId: researchConversationId },
  )
  const tools = s.events().filter((e) => e.type === 'tools.available').at(-1)?.names ?? []
  check(done?.type === 'done', 'research-run-finished', JSON.stringify(done))
  check(tools.includes('load_skill'), 'whitelisted-skill-exposes-loader', JSON.stringify(tools))

  const forbidden = await s.run(
    {
      text: '加载 writer',
      skill: 'writer',
      conversationId: researchConversationId
    }
  )
  check(
    forbidden?.type === 'error' && /未知技能/.test(forbidden.message ?? ''),
    'out-of-whitelist-skill-rejected',
    JSON.stringify(forbidden)
  )

  // ---------- 运行链 4. 连接器白名单 ----------
  const installed = await s.call({ cmd: 'plugins.install', sourceDir: pluginDir }, 'plugins.installed', 60000)
  check(installed?.plugin?.state === 'ready', 'connector-installed', JSON.stringify(installed?.plugin ?? null))
  const plainColleague = await s.call(
    { cmd: 'colleagues.create', name: '无连接器助理' },
    'colleagues.created'
  )
  const plainConv = await s.call(
    {
      cmd: 'conversation.new',
      title: '无连接器会话',
      colleagueId: plainColleague?.colleague?.id
    },
    'conversation.created'
  )
  const plainRun = await s.run(
    { text: '只回复 ok', conversationId: plainConv?.conversationId },
  )
  const plainTools = s.events().filter((e) => e.type === 'tools.available').at(-1)?.names ?? []
  check(plainRun?.type === 'done', 'plain-run-finished')
  check(
    !plainTools.some((n) => n.startsWith('colleague-connector__')),
    'assistant-without-connector-hides-plugin-tools',
    JSON.stringify(plainTools)
  )

  const connectorColleague = await s.call(
    { cmd: 'colleagues.create', name: '连接器助理', connectorNames: ['colleague-connector'] },
    'colleagues.created'
  )
  const connectorConv = await s.call(
    { cmd: 'conversation.new', title: '连接器会话', colleagueId: connectorColleague?.colleague?.id },
    'conversation.created'
  )
  const connectorRun = await s.run(
    { text: '只回复 ok', conversationId: connectorConv?.conversationId },
  )
  const connectorTools = s.events().filter((e) => e.type === 'tools.available').at(-1)?.names ?? []
  check(connectorRun?.type === 'done', 'connector-run-finished')
  check(
    connectorTools.some((n) => n.startsWith('colleague-connector__')),
    'bound-connector-exposes-plugin-tools',
    JSON.stringify(connectorTools)
  )

  // ---------- 运行链 5. 记忆开关 ----------
  const noMem = await s.call(
    { cmd: 'colleagues.create', name: '无记忆助理', memoryEnabled: false },
    'colleagues.created'
  )
  check(noMem?.colleague?.memoryEnabled === false, 'memory-flag-persisted', JSON.stringify(noMem?.colleague ?? null))
  const memColleague = await s.call(
    { cmd: 'colleagues.create', name: '有记忆助理', memoryEnabled: true },
    'colleagues.created'
  )
  await s.close()

  // 直接写入一条工作区记忆,再分别用两个助理运行,观察注入事件。
  const db = new Database(chainDb)
  const workspaceId = db.prepare('SELECT id FROM workspace LIMIT 1').get()?.id
  const now = new Date().toISOString()
  const content = 'MEMORY-MARKER-需要被检索'
  const hash = require('node:crypto')
    .createHash('sha256')
    .update(`workspace\u0000fact\u0000${content}`)
    .digest('hex')
  db.prepare(
    `INSERT INTO memory_entry (id, scope, workspace_id, kind, content, content_hash, source_path, pinned, tokens, created_at, deleted_at)
     VALUES (?, 'workspace', ?, 'fact', ?, ?, NULL, 0, 10, ?, NULL)`
  ).run(`mem-${Date.now()}`, workspaceId, content, hash, now)
  db.close()

  const s2 = openSession(chainWorkspace, chainData, { OPENWB_SKILLS_DIR: skillsDir })
  await s2.waitForEvent((e) => e.type === 'ready')
  const noMemConv = await s2.call(
    { cmd: 'conversation.new', title: '无记忆运行', colleagueId: noMem?.colleague?.id },
    'conversation.created'
  )
  await s2.run(
    { text: content, conversationId: noMemConv?.conversationId },
  )
  const noMemInjection = s2.events().filter((e) => e.type === 'memory.injected').at(-1)
  check(
    Array.isArray(noMemInjection?.blocks) && noMemInjection.blocks.length === 0,
    'memory-disabled-skips-injection',
    JSON.stringify(noMemInjection ?? null)
  )

  const memConv = await s2.call(
    { cmd: 'conversation.new', title: '有记忆运行', colleagueId: memColleague?.colleague?.id },
    'conversation.created'
  )
  await s2.run(
    { text: content, conversationId: memConv?.conversationId },
  )
  const memInjection = s2.events().filter((e) => e.type === 'memory.injected').at(-1)
  check(
    Array.isArray(memInjection?.blocks) && memInjection.blocks.length > 0,
    'memory-enabled-injects',
    JSON.stringify(memInjection ?? null)
  )
  await s2.close()
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
  if (appStderr) console.log(appStderr.slice(-1500))
  process.exit(1)
}
console.log('\n助理验收全部通过')

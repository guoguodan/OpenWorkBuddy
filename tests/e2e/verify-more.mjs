/**
 * 更多入口真实化验收。
 *
 * 桌面端 UI:
 *   六个"更多"入口分别打开项目 / 我的邮箱 / 腾讯文档 / ima / 乐享 / 灵感,
 *   项目创建/编辑/置顶/删除、项目内新建任务并归属、重启后保留;
 *   连接状态切换与重启保持,地址必须真实可达才算已连接;
 *   灵感空态、发布、收藏、刷新后保留。
 * daemon 运行链:
 *   项目指令进入 system、项目技能白名单收窄工具、项目上下文进入 trace。
 *
 * 用法: node tests/e2e/verify-more.mjs
 * 前置: pnpm --filter @openwb/daemon build && pnpm --filter @openwb/desktop build
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const electron = resolve(root, 'apps/desktop/node_modules/electron/dist/electron.exe')
const daemonEntry = resolve(root, 'apps/daemon/dist/index.js')
const port = 9339
const endpoint = `http://127.0.0.1:${port}/json/list`
const require = createRequire(resolve(root, 'apps/daemon/package.json'))
const Database = require('better-sqlite3')

const serviceStub = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('ok')
})
await new Promise((resolveListen) => serviceStub.listen(0, '127.0.0.1', resolveListen))
const serviceUrl = `http://127.0.0.1:${serviceStub.address().port}`

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
      res({ ws, evaluate, send })
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

const base = await mkdtemp(join(tmpdir(), 'owb-more-'))
const uiWorkspace = join(base, 'ui-ws')
const uiData = join(base, 'ui-data')
const chainWorkspace = join(base, 'chain-ws')
const chainData = join(base, 'chain-data')
const chainDb = join(chainData, 'openwb.db')
const skillsDir = join(base, 'skills')

await mkdir(uiWorkspace, { recursive: true })
await mkdir(uiData, { recursive: true })
await mkdir(chainWorkspace, { recursive: true })
await mkdir(chainData, { recursive: true })
await writeFile(join(chainWorkspace, 'README.md'), '# more chain\n', 'utf8')

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

  const openMore = async (label) => {
    await evaluate(`document.querySelector('[data-testid="open-more"]').click()`)
    await waitFor(evaluate, `Boolean(document.querySelector('.owb-more__menu'))`)
    await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll('.owb-more__menu button')).find((x) => x.textContent.includes(${JSON.stringify(label)}))
      if (!b) throw new Error('缺少更多入口 ' + ${JSON.stringify(label)})
      b.click()
    })()`)
    await sleep(300)
  }
  const closeSheet = async () => {
    await evaluate(`document.querySelector('.owb-sheet-overlay .owb-icon-btn')?.click()`)
    await sleep(300)
  }
  const fillField = async (testid, value) => {
    await evaluate(`(() => {
      const el = document.querySelector('[data-testid="${testid}"]')
      if (!el) throw new Error('缺少字段 ' + ${JSON.stringify(testid)})
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await sleep(80)
  }

  // ---------- 1. 六个入口都打开正确页面 ----------
  await openMore('项目')
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[role="dialog"][aria-label="项目"]'))`),
    'more-opens-projects'
  )
  await closeSheet()

  await openMore('我的邮箱')
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="connection-panel"]'))`),
    'more-opens-mailbox'
  )
  await closeSheet()

  await openMore('腾讯文档')
  check(
    await waitFor(evaluate, `document.querySelector('[data-testid="connection-panel"]')?.innerText.includes('腾讯文档')`),
    'more-opens-tencent-docs'
  )
  await closeSheet()

  await openMore('ima')
  check(
    await waitFor(evaluate, `document.querySelector('[data-testid="connection-panel"]')?.innerText.includes('ima')`),
    'more-opens-ima'
  )
  await closeSheet()

  await openMore('乐享知识库')
  check(
    await waitFor(evaluate, `document.querySelector('[data-testid="connection-panel"]')?.innerText.includes('乐享知识库')`),
    'more-opens-lexiang'
  )
  await closeSheet()

  await openMore('灵感社区')
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[role="dialog"][aria-label="灵感"]'))`),
    'more-opens-inspiration'
  )
  await closeSheet()

  // ---------- 2. 项目创建 / 编辑 / 置顶 / 删除 ----------
  await openMore('项目')
  await waitFor(evaluate, `Boolean(document.querySelector('[role="dialog"][aria-label="项目"]'))`)
  await evaluate(`document.querySelector('[data-testid="project-create"]').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="project-form"]'))`)
  await fillField('project-name', '企业级 AI 工作台')
  await evaluate(`(() => {
    const form = document.querySelector('[data-testid="project-form"]')
    const ta = form.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '先对照竞品再给取舍;结论必须带依据。')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await evaluate(`document.querySelector('[data-testid="project-save"]').click()`)
  const projectCard = await waitFor(
    evaluate,
    `Boolean(document.querySelector('[data-testid="project-card"]'))`
  )
  check(projectCard, 'project-created')
  const projectId = await evaluate(
    `document.querySelector('[data-testid="project-card"]').dataset.projectId`
  )
  check(!!projectId, 'project-has-id', projectId)

  // 置顶
  await evaluate(`(() => {
    document.querySelector('[data-testid="project-more"]').click()
  })()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="project-menu"]'))`)
  await evaluate(`(() => {
    Array.from(document.querySelectorAll('[data-testid="project-menu"] button')).find((b) => b.textContent.trim() === '置顶').click()
  })()`)
  const pinned = await waitFor(
    evaluate,
    `document.querySelector('[data-testid="project-card"]')?.innerText.includes('已置顶')`
  )
  check(pinned, 'project-pinned')

  // 重命名
  await evaluate(`(() => {
    document.querySelector('[data-testid="project-more"]').click()
  })()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="project-menu"]'))`)
  await evaluate(`(() => {
    Array.from(document.querySelectorAll('[data-testid="project-menu"] button')).find((b) => b.textContent.trim() === '重命名').click()
  })()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="project-rename-input"]'))`)
  await fillField('project-rename-input', '企业级 AI 工作台 Pro')
  await evaluate(`document.querySelector('[data-testid="project-rename-save"]').click()`)
  const renamed = await waitFor(
    evaluate,
    `document.querySelector('[data-testid="project-card"]')?.innerText.includes('企业级 AI 工作台 Pro')`
  )
  check(renamed, 'project-edited')

  // 项目内新建任务
  await evaluate(`document.querySelector('.owb-project-tile__main').click()`)
  await waitFor(evaluate, `!document.querySelector('[data-testid="project-card"]')`)
  const taskTitle = await evaluate(`(async () => {
    const list = await window.openwb.conversation.list()
    return list.conversations.some((c) => c.title.includes('企业级 AI 工作台 Pro'))
  })()`)
  check(taskTitle, 'project-task-created')

  // 项目任务归属与计数
  await openMore('项目')
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="project-card"]'))`)
  const taskCount = await evaluate(
    `document.querySelector('[data-testid="project-card"]')?.innerText.match(/(\\d+) 个任务/)?.[1] ?? ''`
  )
  check(taskCount === '1', 'project-task-count', taskCount)

  // 项目不再跳资料库
  const projectDialog = await evaluate(
    `document.querySelector('[role="dialog"][aria-label="项目"]')?.getAttribute('aria-label')`
  )
  check(projectDialog === '项目', 'projects-not-library', projectDialog)
  await closeSheet()

  // ---------- 3. 连接状态切换与持久化 ----------
  await openMore('我的邮箱')
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="connection-panel"]'))`)
  await fillField('connection-endpoint', serviceUrl)
  await fillField('connection-account', 'team@example.com')
  await evaluate(`document.querySelector('[data-testid="connection-connect"]').click()`)
  const connected = await waitFor(
    evaluate,
    `document.querySelector('[data-testid="connection-status"]')?.innerText.includes('已连接')`
  )
  check(connected, 'connection-connected')

  // 可解析但不可达的地址同样不能显示为已连接。
  await evaluate(`document.querySelector('[data-testid="connection-provider-ima"]').click()`)
  await sleep(200)
  await fillField('connection-endpoint', 'http://127.0.0.1:1')
  await evaluate(`document.querySelector('[data-testid="connection-connect"]').click()`)
  const unreachableError = await waitFor(
    evaluate,
    `document.querySelector('[data-testid="connection-status"]')?.innerText.includes('连接异常')`
  )
  check(unreachableError, 'unreachable-endpoint-becomes-error')
  const unreachableText = await evaluate(
    `document.querySelector('[data-testid="connection-error"]')?.innerText ?? ''`
  )
  check(
    /无法连接|拒绝连接|连接超时/.test(unreachableText),
    'unreachable-endpoint-has-reason',
    unreachableText
  )

  // 非法地址 -> error,不能显示为已连接
  await evaluate(`document.querySelector('[data-testid="connection-provider-tencentDocs"]').click()`)
  await sleep(200)
  await fillField('connection-endpoint', 'not-a-url')
  await evaluate(`document.querySelector('[data-testid="connection-connect"]').click()`)
  const invalidError = await waitFor(
    evaluate,
    `document.querySelector('[data-testid="connection-status"]')?.innerText.includes('连接异常')`
  )
  check(invalidError, 'invalid-endpoint-becomes-error')
  const errorText = await evaluate(
    `document.querySelector('[data-testid="connection-error"]')?.innerText ?? ''`
  )
  check(errorText.includes('连接地址无效'), 'invalid-endpoint-error-message', errorText)
  await closeSheet()

  // ---------- 4. 灵感空态 / 发布 / 收藏 / 刷新保留 ----------
  await openMore('灵感社区')
  await waitFor(evaluate, `Boolean(document.querySelector('[role="dialog"][aria-label="灵感"]'))`)
  const emptyText = await evaluate(
    `document.querySelector('[data-testid="inspiration-empty"]')?.innerText ?? ''`
  )
  check(emptyText.includes('暂无灵感') && emptyText.includes('灵感和建议将显示在这里'), 'inspiration-empty-state', emptyText)

  await evaluate(`document.querySelector('[data-testid="inspiration-publish"]').click()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="inspiration-form"]'))`)
  await fillField('inspiration-title', '把灵感沉淀成可复用线索')
  await evaluate(`(() => {
    const el = document.querySelector('[data-testid="inspiration-form"] textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, '把可复用的观察写成可交互的产品线索')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await fillField('inspiration-tags', '产品 交互')
  await evaluate(`document.querySelector('[data-testid="inspiration-save"]').click()`)
  const postShown = await waitFor(
    evaluate,
    `Boolean(document.querySelector('[data-testid="inspiration-card"]'))`
  )
  check(postShown, 'inspiration-published')
  await evaluate(`document.querySelector('[data-testid="inspiration-favorite"]').click()`)
  const favorited = await waitFor(
    evaluate,
    `(document.querySelector('[data-testid="inspiration-favorite"]')?.getAttribute('aria-label') ?? '').includes('取消收藏')`
  )
  check(favorited, 'inspiration-favorited')

  await evaluate(`location.reload()`)
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="welcome"]'))`, 40000)
  await openMore('灵感社区')
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="inspiration-card"]'))`)
  const persisted = await evaluate(
    `document.querySelector('[data-testid="inspiration-card"]')?.innerText ?? ''`
  )
  check(persisted.includes('可复用线索'), 'inspiration-persists-after-reload', persisted)
  await closeSheet()

  // ---------- 5. 项目重启后保留 ----------
  await openMore('项目')
  await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="project-card"]'))`)
  const projectPersisted = await evaluate(
    `document.querySelector('[data-testid="project-card"]')?.innerText ?? ''`
  )
  check(projectPersisted.includes('企业级 AI 工作台 Pro'), 'project-persists-after-reload', projectPersisted)
  await closeSheet()

  // ---------- 6. 运行链:项目指令 / 技能白名单 / 项目上下文 ----------
  const s = openSession(chainWorkspace, chainData, { OPENWB_SKILLS_DIR: skillsDir })
  await s.waitForEvent((e) => e.type === 'ready')
  const project = await s.call(
    {
      cmd: 'projects.create',
      name: '链上项目',
      description: '链上项目简介',
      instructions: '链上项目指令',
      skillNames: ['research']
    },
    'projects.created'
  )
  const projectId2 = project?.project?.id
  check(!!projectId2, 'daemon-project-created', JSON.stringify(project))

  // 协议级:客户端即使声明 connected,也必须以 daemon 实际探测结果为准。
  const forged = await s.call(
    {
      cmd: 'connections.set',
      provider: 'mailbox',
      status: 'connected',
      endpoint: 'http://127.0.0.1:1',
      account: 'forged@example.com',
      lastError: null
    },
    'connections.updated'
  )
  check(
    forged?.connection?.status === 'error' && forged.connection.lastError,
    'daemon-ignores-forged-connected-status',
    JSON.stringify(forged)
  )
  const reachable = await s.call(
    { cmd: 'connections.set', provider: 'mailbox', status: 'error', endpoint: serviceUrl },
    'connections.updated'
  )
  check(
    reachable?.connection?.status === 'connected' &&
      reachable.connection.endpoint === serviceUrl &&
      reachable.connection.lastError === null,
    'daemon-verifies-reachable-endpoint',
    JSON.stringify(reachable)
  )
  const listed = await s.call({ cmd: 'connections.list' }, 'connections.list')
  check(
    listed?.connections?.find((c) => c.provider === 'mailbox')?.status === 'connected',
    'daemon-persists-probed-status',
    JSON.stringify(listed)
  )

  const conv = await s.call(
    { cmd: 'conversation.new', title: '项目会话', projectId: projectId2 },
    'conversation.created'
  )
  check(conv?.type === 'conversation.created', 'project-conversation-created', JSON.stringify(conv))

  const done = await s.run({
    text: '按研究技能处理',
    skill: 'research',
    conversationId: conv?.conversationId
  })
  check(done?.type === 'done', 'project-run-finished', JSON.stringify(done))

  const traceDir = join(chainWorkspace, '.openwb/traces')
  const files = (await readdir(traceDir)).filter((f) => f.startsWith('prompt-craft-'))
  const last = files.sort().at(-1)
  const trace = JSON.parse(await readFile(join(traceDir, last), 'utf8'))
  check(trace.projectId === projectId2, 'trace-carries-project-id', JSON.stringify(trace.projectId))
  check(
    typeof trace.systemSha256 === 'string' && trace.systemSha256.length === 64,
    'trace-carries-system-hash',
    String(trace.systemSha256)
  )
  check(
    trace.skill === 'research' &&
      trace.allowedTools?.includes('read_file') &&
      trace.allowedTools?.includes('glob') &&
      !trace.allowedTools?.includes('write_file'),
    'project-whitelisted-skill-narrows-tools',
    JSON.stringify(trace.allowedTools)
  )

  // 项目白名单之外的技能必须不可加载(这里项目只放行 research)
  const forbidden = await s.run({
    text: '加载 writer',
    skill: 'writer',
    conversationId: conv?.conversationId
  })
  check(
    forbidden?.type === 'error' && /未知技能/.test(forbidden.message ?? ''),
    'project-blocks-out-of-whitelist-skill',
    JSON.stringify(forbidden)
  )

  // 项目删除只解除任务归属,任务本身必须保留。
  await s.call({ cmd: 'projects.delete', id: projectId2 }, 'projects.deleted')
  const afterDelete = await s.call({ cmd: 'conversation.list' }, 'conversation.list')
  const kept = (afterDelete?.conversations ?? []).find((c) => c.id === conv?.conversationId)
  check(!!kept, 'project-delete-keeps-task', JSON.stringify(afterDelete?.conversations ?? []).slice(0, 200))
  check(kept?.projectId === null, 'project-delete-clears-ownership', JSON.stringify(kept?.projectId))

  // 项目上下文确实进入 system:用 trace 的注入段落 + system 摘要对齐验证。
  check(
    Array.isArray(trace.injected) && trace.injected.includes('project'),
    'project-section-marked-injected',
    JSON.stringify(trace.injected)
  )
  const noProjectConv = await s.call(
    { cmd: 'conversation.new', title: '无项目会话' },
    'conversation.created'
  )
  await s.run({ text: '只回复 ok', conversationId: noProjectConv?.conversationId })
  const traceFiles = (await readdir(traceDir))
    .filter((f) => f.startsWith('prompt-craft-'))
    .sort()
  const plainTrace = JSON.parse(await readFile(join(traceDir, traceFiles.at(-1)), 'utf8'))
  check(
    plainTrace.systemSha256 !== trace.systemSha256,
    'project-changes-system-prompt',
    `${plainTrace.systemSha256} vs ${trace.systemSha256}`
  )
  check(
    !plainTrace.injected || !plainTrace.injected.includes('project'),
    'plain-task-has-no-project-section',
    JSON.stringify(plainTrace.injected)
  )
  await s.close()
} catch (err) {
  failed++
  console.error(`FAIL 运行异常: ${err?.message ?? err}`)
  if (appStderr) console.error(appStderr.slice(-2000))
} finally {
  try {
    session?.ws?.close()
  } catch {}
  app.kill()
  await new Promise((resolveClose) => serviceStub.close(() => resolveClose()))
  await sleep(1200)
  await rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 })
}

if (failed > 0) {
  console.log(`\n${failed} 项失败`)
  if (appStderr) console.log(appStderr.slice(-1500))
  process.exit(1)
}
console.log('\n更多入口验收全部通过')

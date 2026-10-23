/**
 * P5 验收(IMPLEMENTATION §6.7 十条)。
 * 用法: node tests/e2e/verify-p5.mjs
 * 前置: pnpm --filter @openwb/daemon build
 *
 * 全程离线:用 tests/fixtures/mcp-echo-server.mjs 充当第三方 MCP server,
 * 不依赖网络、不依赖真实模型(走 OPENWB_MOCK)。
 */
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const entry = resolve(root, 'apps/daemon/dist/index.js')
const fixture = resolve(root, 'tests/fixtures/mcp-echo-server.mjs')

if (!existsSync(entry)) {
  console.error(`缺少 daemon 产物: ${entry}`)
  console.error('先执行: pnpm --filter @openwb/daemon build')
  process.exit(1)
}

let failed = 0
const check = (ok, label, detail = '') => {
  if (ok) console.log(`PASS ${label}`)
  else {
    failed++
    console.log(`FAIL ${label}${detail ? ` :: ${detail}` : ''}`)
  }
}

/**
 * 握手帧必须是 stdout 第一帧。
 * 已装插件时插件会在启动阶段发 plugin.status;若 hello 晚发,桌面端会直接判协议错误。
 */
const checkHelloFirst = (r, label) => {
  const first = r.events[0]
  check(first?.type === 'hello', label, first?.type ?? '无事件')
}

const base = await mkdtemp(join(tmpdir(), 'owb-p5-'))
const workspace = join(base, 'ws')
const dataDir = join(base, 'data')
const sourceRoot = join(base, 'sources')
await mkdir(workspace, { recursive: true })
await mkdir(dataDir, { recursive: true })
await mkdir(sourceRoot, { recursive: true })
await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'p5-ws' }), 'utf8')

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
      out.push({ type: 'PARSE_ERROR', raw: json })
    }
  }
  return out
}

/**
 * 起一个 daemon 会话。send 是"帧数组 → 需等待的帧类型"的钩子:
 * 收到期望类型后立即结束 stdin,避免固定 sleep 拖慢整体。
 */
function runSession(frames, { waitFor = 'done', timeoutMs = 45_000, env = {} } = {}) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: {
        ...process.env,
        OPENWB_MOCK: '1',
        OPENWB_WORKSPACE: workspace,
        OPENWB_DATA_DIR: dataDir,
        OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
        OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts'),
        OPENWB_PLUGIN_HEALTH_MS: '60000',
        ...env
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const chunks = []
    let err = ''
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      res({ code, events: decodeFrames(Buffer.concat(chunks)), err })
    }
    const timer = setTimeout(() => {
      child.kill()
      finish('timeout')
    }, timeoutMs)

    child.stdout.on('data', (b) => {
      chunks.push(b)
      const events = decodeFrames(Buffer.concat(chunks))
      const reached =
        typeof waitFor === 'function' ? events.some(waitFor) : events.some((e) => e.type === waitFor)
      if (reached) {
        child.stdin.end()
        setTimeout(() => finish(null), 300)
      }
    })
    child.stderr.on('data', (b) => {
      err += String(b)
    })
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rej(e)
    })
    child.on('close', (code) => finish(code))

    for (const frame of frames) child.stdin.write(encodeFrame(frame))
  })
}

async function makePlugin(name, manifestPatch = {}, opts = {}) {
  const dir = join(sourceRoot, name)
  await mkdir(join(dir, 'dist'), { recursive: true })
  await cp(fixture, join(dir, 'dist/server.mjs'))
  if (opts.extraFiles) {
    for (const [rel, content] of Object.entries(opts.extraFiles)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true })
      await writeFile(join(dir, rel), content, 'utf8')
    }
  }
  const manifest = {
    schemaVersion: 1,
    name,
    displayName: opts.displayName ?? name,
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
    highCreditTools: {},
    ...manifestPatch
  }
  await writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return dir
}

const pluginNames = []

// ── 1/2. 安装最小 MCP server → 工具带命名空间前缀,调用结果正确回填 ───────────────
const echoDir = await makePlugin('p5-echo', {}, { displayName: '回显连接器' })
pluginNames.push('p5-echo')
let r = await runSession([{ cmd: 'plugins.install', sourceDir: echoDir, requestId: 'i1' }], {
  waitFor: 'plugins.installed'
})
checkHelloFirst(r, '0a. 首帧是 hello')
let installed = r.events.find((e) => e.type === 'plugins.installed')
check(Boolean(installed), '1. 安装最小 MCP server', r.err.slice(-400))
const snap = installed?.plugin
check(snap?.state === 'ready', '1b. 安装后插件就绪', JSON.stringify(snap?.state))
const toolNames = (snap?.tools ?? []).map((t) => t.name)
check(
  toolNames.length === 4 && toolNames.every((n) => n.startsWith('p5-echo__')),
  '1c. 工具名带 <插件名>__ 前缀',
  JSON.stringify(toolNames)
)

// 真实调用工具:走 craft 模式的 agent 循环,确认结果回填到会话
r = await runSession(
  [{ text: '帮我调用 echo 工具,参数 text 为 p5-hello', mode: 'craft', requestId: 'c1' }],
  { waitFor: 'done', timeoutMs: 90_000 }
)
const finished = r.events.filter((e) => e.type === 'tool.finished')
const echoCall = finished.find((e) => (e.summary ?? '').includes('echo:p5-hello'))
check(Boolean(echoCall), '2. 插件工具调用结果回填到会话', JSON.stringify(finished).slice(0, 400))
check(echoCall?.ok === true, '2b. 成功调用标记为 ok')
const errors1 = r.events.filter((e) => e.type === 'error')
check(errors1.length === 0, '2c. 调用过程无错误帧', JSON.stringify(errors1).slice(0, 300))

// ── 3. 杀掉插件进程 → 自动重启,期间状态为 reconnecting ───────────────────────
{
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      OPENWB_MOCK: '1',
      OPENWB_WORKSPACE: workspace,
      OPENWB_DATA_DIR: dataDir,
      OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
      OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts'),
      OPENWB_PLUGIN_HEALTH_MS: '60000'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const chunks = []
  let live = []
  child.stdout.on('data', (b) => {
    chunks.push(b)
    live = decodeFrames(Buffer.concat(chunks))
  })
  let err = ''
  child.stderr.on('data', (b) => {
    err += String(b)
  })

  const waitForEvent = async (predicate, ms) => {
    const start = Date.now()
    while (Date.now() - start < ms) {
      const hit = live.find(predicate)
      if (hit) return hit
      await new Promise((res) => setTimeout(res, 100))
    }
    return null
  }

  const ready = await waitForEvent((e) => e.type === 'ready', 20_000)
  const readyPlugin = ready?.plugins?.find((p) => p.name === 'p5-echo')
  check(readyPlugin?.state === 'ready', '3a. 重启后插件从磁盘恢复为就绪', JSON.stringify(readyPlugin?.state))

  const pid = readyPlugin?.pids?.[0]
  check(typeof pid === 'number', '3b. 快照里带有子进程 pid', String(pid))
  if (typeof pid === 'number') {
    try {
      process.kill(pid)
    } catch {
      // 已退出
    }
    const reconnect = await waitForEvent(
      (e) => e.type === 'plugin.status' && e.plugin?.name === 'p5-echo' && e.plugin.state === 'reconnecting',
      5_000
    )
    check(Boolean(reconnect), '3c. 进程被杀后 3 秒内进入重连中')
    const back = await waitForEvent(
      (e) => e.type === 'plugin.status' && e.plugin?.name === 'p5-echo' && e.plugin.state === 'ready' &&
        (!reconnect || e.plugin.pids?.[0] !== pid),
      15_000
    )
    check(Boolean(back), '3d. 退避后自动重启回就绪', err.slice(-300))
  }
  child.stdin.end()
  child.kill()
}

// ── 4. 连续 3 次启动失败 → 禁用,daemon 仍正常 ────────────────────────────────
{
  const crashDir = await makePlugin(
    'p5-crash',
    { mcpServers: { echo: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/dist/server.mjs'], env: { FAULT: 'always-crash' }, defer_loading: false } } },
    { displayName: '必然失败连接器' }
  )
  pluginNames.push('p5-crash')
  r = await runSession([{ cmd: 'plugins.install', sourceDir: crashDir, requestId: 'i2' }], {
    waitFor: 'error',
    timeoutMs: 60_000
  })
  const installErr = r.events.find((e) => e.type === 'error')
  check(
    Boolean(installErr) && (installErr.message ?? '').includes('first-start'),
    '4a. 首次启动失败即回滚安装',
    JSON.stringify(installErr).slice(0, 300)
  )
  const rolledBack = !existsSync(join(dataDir, 'plugins', 'p5-crash'))
  check(rolledBack, '4b. 回滚后插件目录已删除')

  // 手工放入一个必然失败的插件,验证"连续失败 3 次降级"而 daemon 不退出。
  // 退避是 1s -> 2s -> 4s:第 3 次失败约在 3s 后,必须等 plugin.status 变成 disabled,
  // 不能在 ready 之后就立刻读列表(那时还停在 reconnecting)。
  const manual = join(dataDir, 'plugins', 'p5-crash')
  await cp(crashDir, manual, { recursive: true })
  r = await runSession([{ cmd: 'plugins.list', requestId: 'l1' }], {
    waitFor: 'plugins.list',
    timeoutMs: 60_000
  })
  const firstList = r.events.find((e) => e.type === 'plugins.list')
  const seen = firstList?.plugins?.find((p) => p.name === 'p5-crash')
  check(r.code !== 'timeout', '4c. 启动失败插件不影响 daemon 启动')
  check(['reconnecting', 'crashed', 'disabled'].includes(seen?.state), '4c2. 失败插件进入重连状态', String(seen?.state))

  r = await runSession([{ cmd: 'plugins.list', requestId: 'l1b' }], {
    waitFor: (e) =>
      e.type === 'plugin.status' && e.plugin?.name === 'p5-crash' && e.plugin.state === 'disabled',
    timeoutMs: 30_000
  })
  const disabledFrame = r.events
    .filter((e) => e.type === 'plugin.status' && e.plugin?.name === 'p5-crash')
    .at(-1)
  check(disabledFrame?.plugin?.state === 'disabled', '4d. 连续失败 3 次后被禁用', String(disabledFrame?.plugin?.state))
  check(disabledFrame?.plugin?.enabled === false, '4e. 禁用同时写回 enabled=false')

  const list = r.events.find((e) => e.type === 'plugins.list')
  const healthy = list?.plugins?.find((p) => p.name === 'p5-echo')
  check(healthy?.state === 'ready', '4f. 其它插件仍正常工作', String(healthy?.state))

  // probe(测试连接)必须只探测,不改持久化 enabled,也不累计失败次数
  r = await runSession([{ cmd: 'plugins.probe', name: 'p5-echo', requestId: 'p1' }], {
    waitFor: 'plugins.probed'
  })
  const probed = r.events.find((e) => e.type === 'plugins.probed')
  check(probed?.ok === true && probed?.tools === 4, '4g. 测试连接返回工具数', JSON.stringify(probed).slice(0, 200))

  r = await runSession([{ cmd: 'plugins.list', requestId: 'l1c' }], { waitFor: 'plugins.list' })
  const afterProbe = r.events.find((e) => e.type === 'plugins.list')?.plugins?.find((p) => p.name === 'p5-echo')
  check(afterProbe?.enabled === true && afterProbe?.state === 'ready', '4h. 探测后插件状态未被改动', JSON.stringify(afterProbe?.state))
  await rm(manual, { recursive: true, force: true })
}

// ── 5. 卸载后工具立即不可用 ──────────────────────────────────────────────────
r = await runSession([{ cmd: 'plugins.uninstall', name: 'p5-echo', requestId: 'u1' }], {
  waitFor: 'plugins.uninstalled'
})
check(r.events.some((e) => e.type === 'plugins.uninstalled'), '5a. 卸载成功')
check(!existsSync(join(dataDir, 'plugins', 'p5-echo')), '5b. 插件目录已删除')

r = await runSession([{ cmd: 'plugins.list', requestId: 'l2' }], { waitFor: 'plugins.list' })
const afterList = r.events.find((e) => e.type === 'plugins.list')
check(!(afterList?.plugins ?? []).some((p) => p.name === 'p5-echo'), '5c. 列表中不再出现')

r = await runSession([{ text: '调用 p5-echo__echo', mode: 'craft', requestId: 'c2' }], {
  waitFor: 'done',
  timeoutMs: 90_000
})
const goneCall = r.events.find((e) => e.type === 'tool.finished' && (e.summary ?? '').includes('p5-echo__echo'))
check(
  Boolean(goneCall) && goneCall.ok === false,
  '5d. 卸载后调用返回明确错误',
  JSON.stringify(goneCall ?? null).slice(0, 300)
)

// ── 6/7/9/10. 安装期校验 ────────────────────────────────────────────────────
{
  const bad = await makePlugin('p5-badperm', { permissions: ['camera'] })
  r = await runSession([{ cmd: 'plugins.install', sourceDir: bad, requestId: 'i3' }], { waitFor: 'error' })
  const err = r.events.find((e) => e.type === 'error')
  check(
    Boolean(err) && (err.message ?? '').includes('camera'),
    '6. 未知权限被拒绝且指出权限名',
    JSON.stringify(err).slice(0, 300)
  )
}
{
  const leaky = await makePlugin('p5-leaky', {}, {
    extraFiles: { 'dist/keys.txt': 'OPENAI_API_KEY=sk-abcdefghijklmnop0123456789\n' }
  })
  r = await runSession([{ cmd: 'plugins.install', sourceDir: leaky, requestId: 'i4' }], { waitFor: 'error' })
  const err = r.events.find((e) => e.type === 'error')
  check(
    Boolean(err) && (err.message ?? '').includes('明文凭据'),
    '7. 含 sk- 明文的插件被拒绝',
    JSON.stringify(err).slice(0, 300)
  )
}
{
  const lazy = await makePlugin('p5-lazy', {
    highCreditTools: { echo: { approvalKind: 'writeExternal', group: 'g' } },
    mcpServers: {
      echo: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/dist/server.mjs'], env: {}, defer_loading: true }
    }
  })
  r = await runSession([{ cmd: 'plugins.install', sourceDir: lazy, requestId: 'i5' }], { waitFor: 'error' })
  const err = r.events.find((e) => e.type === 'error')
  check(
    Boolean(err) && (err.message ?? '').includes('defer_loading'),
    '9. highCreditTools + defer_loading 安装失败',
    JSON.stringify(err).slice(0, 300)
  )
}
{
  const shellDir = await makePlugin('p5-shell', { permissions: ['shell'] })
  pluginNames.push('p5-shell')
  r = await runSession([{ cmd: 'plugins.install', sourceDir: shellDir, requestId: 'i6' }], { waitFor: 'error' })
  const err = r.events.find((e) => e.type === 'error')
  check(
    Boolean(err) && (err.message ?? '').includes('shell'),
    '10a. 含 shell 权限未确认时安装被拒',
    JSON.stringify(err).slice(0, 300)
  )

  r = await runSession(
    [{ cmd: 'plugins.install', sourceDir: shellDir, confirmShell: true, requestId: 'i7' }],
    { waitFor: 'plugins.installed' }
  )
  const shellInstalled = r.events.find((e) => e.type === 'plugins.installed')
  check(shellInstalled?.plugin?.enabled === false, '10b. 确认后安装但默认禁用')

  r = await runSession(
    [{ cmd: 'plugins.setEnabled', name: 'p5-shell', enabled: true, requestId: 'e1' }],
    { waitFor: 'error' }
  )
  const enableErr = r.events.find((e) => e.type === 'error')
  check(
    Boolean(enableErr) && (enableErr.message ?? '').includes('confirmShell'),
    '10c. 启用 shell 插件需二次确认',
    JSON.stringify(enableErr).slice(0, 300)
  )

  r = await runSession(
    [{ cmd: 'plugins.setEnabled', name: 'p5-shell', enabled: true, confirmShell: true, requestId: 'e2' }],
    { waitFor: 'plugin.status' }
  )
  const enabledFrame = r.events.filter((e) => e.type === 'plugin.status').at(-1)
  check(enabledFrame?.plugin?.enabled === true, '10d. 二次确认后成功启用')
  await rm(join(dataDir, 'plugins', 'p5-shell'), { recursive: true, force: true })
}

// ── 8. 插件子进程读不到 OPENAI_API_KEY ──────────────────────────────────────
{
  const probeDir = await makePlugin('p5-env', {}, { displayName: '环境隔离探针' })
  pluginNames.push('p5-env')
  r = await runSession([{ cmd: 'plugins.install', sourceDir: probeDir, requestId: 'i8' }], {
    waitFor: 'plugins.installed'
  })
  const ok = r.events.some((e) => e.type === 'plugins.installed')
  check(ok, '8a. 环境隔离探针安装成功', r.err.slice(-300))
  if (ok) {
    r = await runSession(
      [{ text: '调用 p5-env__env_probe 工具,把返回的数组原样告诉我', mode: 'craft', requestId: 'c3' }],
      {
        waitFor: 'done',
        timeoutMs: 90_000,
        env: { OPENAI_API_KEY: 'sk-should-not-leak-1234567890' }
      }
    )
    const probe = r.events.find(
      (e) => e.type === 'tool.finished' && (e.summary ?? '').includes('[]')
    )
    const leaky = r.events.find(
      (e) => e.type === 'tool.finished' && /OPENAI_|GITHUB_|AWS_/.test(e.summary ?? '')
    )
    check(Boolean(probe) && !leaky, '8b. 子进程环境里没有宿主密钥', JSON.stringify(leaky ?? {}).slice(0, 300))
    await runSession([{ cmd: 'plugins.uninstall', name: 'p5-env', requestId: 'u2' }], {
      waitFor: 'plugins.uninstalled'
    })
  }
}

// ── 收尾 ────────────────────────────────────────────────────────────────────
for (const name of pluginNames) {
  await rm(join(dataDir, 'plugins', name), { recursive: true, force: true }).catch(() => undefined)
}
await rm(base, { recursive: true, force: true }).catch(() => undefined)

console.log(failed === 0 ? '\nP5 全部验收通过' : `\nP5 有 ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)

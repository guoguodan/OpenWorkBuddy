/**
 * 会话级专家绑定验收。
 *
 * 覆盖:
 *   - 创建时校验专家存在、类型为 expert、已启用;
 *   - conversation.list 返回 expertId/expertName;
 *   - 同一会话后续消息沿用专家,无需重复传 expertId;
 *   - trace 的 injected 含 expert,且不落专家指令原文;
 *   - 已绑定的专家被关闭后,发送自动解除绑定并继续运行;
 *   - 显式指定失效专家时直接拒绝。
 *
 * 用法: node tests/e2e/verify-experts.mjs
 * 前置: pnpm --filter @openwb/daemon build
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const daemonEntry = resolve(root, 'apps/daemon/dist/index.js')
if (!existsSync(daemonEntry)) {
  console.error('缺少 daemon 产物,先执行 pnpm --filter @openwb/daemon build')
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

function openSession(workspace, dataDir) {
  const child = spawn(process.execPath, [daemonEntry], {
    cwd: root,
    env: {
      ...process.env,
      OPENWB_MOCK: '1',
      OPENWB_WORKSPACE: workspace,
      OPENWB_DATA_DIR: dataDir,
      OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
      OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts'),
      OPENWB_AUTOMATION_AUTOSTART: '0'
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
    send({ ...frame, requestId: frame.requestId ?? `r-${Math.random().toString(36).slice(2, 8)}` })
    return waitForEvent((e) => e.type === 'done' || e.type === 'error', timeoutMs)
  }
  const close = async () => {
    child.stdin.end()
    await Promise.race([closed, sleep(3000)])
    child.kill()
  }
  return { child, send, call, run, waitForEvent, events, close, stderr: () => err }
}

async function writeExpert(dir, name, manifestPatch = {}) {
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'plugin.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        name,
        displayName: '行业研究专家',
        version: '1.0.0',
        kind: 'expert',
        publisher: 'owb-tests',
        minHostVersion: '0.0.1',
        description: '擅长行业分析与趋势判断',
        instructions: 'TRACE-SECRET-MARKER 先给结论再列证据。',
        mcpServers: {},
        permissions: [],
        credentials: [],
        highCreditTools: {},
        ...manifestPatch
      },
      null,
      2
    ),
    'utf8'
  )
  return dir
}

const base = await mkdtemp(join(tmpdir(), 'owb-expert-'))
const workspace = join(base, 'ws')
const dataDir = join(base, 'data')
const pluginSource = join(base, 'plugin-src')
await mkdir(workspace, { recursive: true })
await mkdir(dataDir, { recursive: true })
await writeFile(join(workspace, 'README.md'), '# expert\n', 'utf8')
const expertDir = await writeExpert(join(pluginSource, 'research-expert'), 'research-expert')

const s = openSession(workspace, dataDir)
try {
  await s.waitForEvent((e) => e.type === 'ready')
  const installed = await s.call(
    { cmd: 'plugins.install', sourceDir: expertDir },
    'plugins.installed',
    30000
  )
  check(installed?.plugin?.kind === 'expert', 'expert-installed', JSON.stringify(installed).slice(0, 200))
  check(
    installed?.plugin?.instructions?.includes('TRACE-SECRET-MARKER'),
    'expert-instructions-available-at-runtime'
  )

  const unknown = await s.call(
    { cmd: 'conversation.new', title: '未知专家', expertId: 'missing-expert' },
    'conversation.created'
  )
  check(unknown?.type === 'error' && /专家不存在/.test(unknown.message ?? ''), 'unknown-expert-rejected', JSON.stringify(unknown))

  const connectorDir = join(pluginSource, 'plain-connector')
  await mkdir(join(connectorDir, 'dist'), { recursive: true })
  await writeFile(
    join(connectorDir, 'plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'plain-connector',
      displayName: '普通连接器',
      version: '1.0.0',
      kind: 'connector',
      mcpServers: { echo: { type: 'stdio', command: 'node', args: ['-e', 'process.exit(0)'] } }
    }),
    'utf8'
  )
  await s.call({ cmd: 'plugins.install', sourceDir: connectorDir }, 'plugins.installed', 30000)
  const wrongKind = await s.call(
    { cmd: 'conversation.new', title: '错误类型专家', expertId: 'plain-connector' },
    'conversation.created'
  )
  check(wrongKind?.type === 'error' && /专家不存在/.test(wrongKind.message ?? ''), 'connector-rejected-as-expert', JSON.stringify(wrongKind))

  await s.call({ cmd: 'plugins.setEnabled', name: 'research-expert', enabled: false }, 'plugin.status')
  const disabled = await s.call(
    { cmd: 'conversation.new', title: '已关闭专家', expertId: 'research-expert' },
    'conversation.created'
  )
  check(disabled?.type === 'error' && /已关闭/.test(disabled.message ?? ''), 'disabled-expert-rejected', JSON.stringify(disabled))
  await s.call({ cmd: 'plugins.setEnabled', name: 'research-expert', enabled: true }, 'plugin.status')

  const created = await s.call(
    { cmd: 'conversation.new', title: '与行业研究专家协作', expertId: 'research-expert' },
    'conversation.created'
  )
  const conversationId = created?.conversationId
  check(Boolean(conversationId), 'expert-conversation-created', JSON.stringify(created))
  const listed = await s.call({ cmd: 'conversation.list' }, 'conversation.list')
  const item = (listed?.conversations ?? []).find((c) => c.id === conversationId)
  check(item?.expertId === 'research-expert' && item?.expertName === '行业研究专家', 'expert-visible-in-list', JSON.stringify(item ?? null))

  const first = await s.run({ text: '只回复 ok', conversationId })
  check(first?.type === 'done', 'expert-run-finished', JSON.stringify(first))
  const traceFiles = (await readdir(join(workspace, '.openwb/traces'))).filter((f) => f.startsWith('prompt-')).sort()
  const trace = JSON.parse(await readFile(join(workspace, '.openwb/traces', traceFiles.at(-1)), 'utf8'))
  check(trace.injected?.includes('expert'), 'expert-section-injected', JSON.stringify(trace.injected ?? null))
  check(!JSON.stringify(trace).includes('TRACE-SECRET-MARKER'), 'trace-does-not-leak-instructions')

  const second = await s.run({ text: '再来一次', conversationId })
  check(second?.type === 'done', 'expert-followup-finished', JSON.stringify(second))
  const traceFiles2 = (await readdir(join(workspace, '.openwb/traces'))).filter((f) => f.startsWith('prompt-')).sort()
  const trace2 = JSON.parse(await readFile(join(workspace, '.openwb/traces', traceFiles2.at(-1)), 'utf8'))
  check(trace2.injected?.includes('expert'), 'expert-followup-keeps-binding', JSON.stringify(trace2.injected ?? null))

  await s.call({ cmd: 'plugins.setEnabled', name: 'research-expert', enabled: false }, 'plugin.status')
  const released = await s.run({ text: '专家关闭后继续', conversationId })
  check(released?.type === 'done', 'disabled-bound-expert-falls-back', JSON.stringify(released))
  const release = s.events().find((e) => e.type === 'expert.released')
  check(release?.expertId === 'research-expert', 'expert-release-event', JSON.stringify(release ?? null))
  const listed2 = await s.call({ cmd: 'conversation.list' }, 'conversation.list')
  const item2 = (listed2?.conversations ?? []).find((c) => c.id === conversationId)
  check(item2?.expertId === null, 'expert-binding-cleared', JSON.stringify(item2 ?? null))

  const explicit = await s.run({ text: '显式指定失效专家', conversationId, expertId: 'research-expert' })
  check(explicit?.type === 'error' && /已关闭/.test(explicit.message ?? ''), 'explicit-disabled-expert-rejected', JSON.stringify(explicit))
} finally {
  await s.close()
  await rm(base, { recursive: true, force: true })
}

if (failed > 0) {
  console.log(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n会话级专家绑定验收全部通过')

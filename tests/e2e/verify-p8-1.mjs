/**
 * P8-1 审批闸门验收。
 * 用法: node tests/e2e/verify-p8-1.mjs
 * 前置: pnpm --filter @openwb/daemon build
 *
 * 用 mcp-guard-server.mjs 的 marker 文件证明"未审批 = 真的没执行"。
 * 全程离线(OPENWB_MOCK=1)。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const entry = resolve(root, 'apps/daemon/dist/index.js')
const fixture = resolve(root, 'tests/fixtures/mcp-guard-server.mjs')

if (!existsSync(entry)) {
  console.error('缺少 daemon 产物,先执行: pnpm --filter @openwb/daemon build')
  process.exit(1)
}

const require = createRequire(resolve(root, 'apps/daemon/package.json'))
const Database = require('better-sqlite3')

let failed = 0
const check = (ok, label, detail = '') => {
  if (ok) console.log(`PASS ${label}`)
  else {
    failed++
    console.log(`FAIL ${label}${detail ? ` :: ${detail}` : ''}`)
  }
}

const base = await mkdtemp(join(tmpdir(), 'owb-p8-1-'))
const workspace = join(base, 'ws')
const dataDir = join(base, 'data')
const sourceRoot = join(base, 'sources')
const markerPath = join(base, 'executed.log')
await mkdir(workspace, { recursive: true })
await mkdir(dataDir, { recursive: true })
await mkdir(sourceRoot, { recursive: true })
await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'p8-ws' }), 'utf8')

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

/** 可交互 session:测试需要"收到审批卡后再回答",不能预先拼好帧。 */
function openSession(env = {}) {
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
      OPENWB_AUTOMATION_AUTOSTART: '0',
      OPENWB_APPROVAL_TIMEOUT_MS: '20000',
      ...env
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const chunks = []
  let err = ''
  let cursor = 0
  child.stdout.on('data', (b) => chunks.push(b))
  child.stderr.on('data', (b) => { err += String(b) })
  const closed = new Promise((r) => child.on('close', (code) => r(code)))

  const events = () => decodeFrames(Buffer.concat(chunks))
  const send = (frame) => child.stdin.write(encodeFrame(frame))
  const waitFor = async (predicate, timeoutMs = 30_000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const all = events()
      for (let i = cursor; i < all.length; i++) {
        if (predicate(all[i])) {
          cursor = i + 1
          return all[i]
        }
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    return null
  }
  const close = async () => {
    child.stdin.end()
    await Promise.race([closed, new Promise((r) => setTimeout(r, 3000))])
    child.kill()
  }
  return { child, send, waitFor, events, close, stderr: () => err }
}

async function makePlugin() {
  const name = 'p8-guard'
  const dir = join(sourceRoot, name)
  await mkdir(join(dir, 'dist'), { recursive: true })
  await cp(fixture, join(dir, 'dist/server.mjs'))
  const manifest = {
    schemaVersion: 1,
    name,
    displayName: '审批验收连接器',
    version: '1.0.0',
    kind: 'connector',
    publisher: 'owb-tests',
    minHostVersion: '0.0.1',
    mcpServers: {
      guard: {
        type: 'stdio',
        command: 'node',
        args: ['${PLUGIN_ROOT}/dist/server.mjs', markerPath],
        env: {},
        defer_loading: false
      }
    },
    permissions: [],
    credentials: [],
    highCreditTools: {
      charge: { approvalKind: 'charge', group: 'billing' },
      audit: { approvalKind: 'charge', group: 'billing' }
    }
  }
  await writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return { name, dir, manifest }
}

async function markers() {
  if (!existsSync(markerPath)) return []
  const raw = await readFile(markerPath, 'utf8')
  return raw.split(/\r?\n/).filter(Boolean)
}

async function clearMarkers() {
  await rm(markerPath, { force: true })
}

const plugin = await makePlugin()

// ── 1. 未发送 approval.ready:风险工具必须 fail-closed 且未执行 ────────────────
{
  const s = openSession()
  check(Boolean(await s.waitFor((e) => e.type === 'ready')), '0. daemon 启动')
  s.send({ cmd: 'plugins.install', sourceDir: plugin.dir, requestId: 'i0' })
  const installed = await s.waitFor((e) => e.type === 'plugins.installed', 60_000)
  check(installed?.plugin?.state === 'ready', '0b. 安装审批验收插件', s.stderr().slice(-400))

  const requestId = 'call-no-ui'
  s.send({ text: `调用 ${plugin.name}__charge`, mode: 'craft', requestId })
  const finished = await s.waitFor((e) => e.type === 'tool.finished', 30_000)
  const denied = s.events().find((e) => e.type === 'approval.denied')
  check(finished?.ok === false, '1a. UI 未就绪时工具未成功执行', JSON.stringify(finished).slice(0, 300))
  check(denied?.code === 'APPROVAL_UNAVAILABLE' && denied?.retryable === true, '1b. 返回可重试的 APPROVAL_UNAVAILABLE', JSON.stringify(denied))
  check(!s.events().some((e) => e.type === 'approval.request'), '1c. 未静默排队审批')
  check((await markers()).length === 0, '1d. 未审批时工具真的没有执行(marker 为空)')
  await s.close()
}

// ── 2. 拒绝授权:工具不执行 ───────────────────────────────────────────────────
{
  const s = openSession()
  await s.waitFor((e) => e.type === 'ready')
  s.send({ cmd: 'approval.ready', requestId: 'r0' })
  check(Boolean(await s.waitFor((e) => e.type === 'approval.ready')), '2. UI 声明审批就绪')
  s.send({ text: `调用 ${plugin.name}__charge`, mode: 'craft', requestId: 'call-denied' })
  const request = await s.waitFor((e) => e.type === 'approval.request', 30_000)
  check(Boolean(request?.request?.id), '2b. 弹出审批请求')
  check(request?.request?.riskKind === 'billing', '2c. 识别为计费风险', String(request?.request?.riskKind))
  check(request?.request?.groupKey === 'plugin:p8-guard:billing', '2d. 授权组按插件+组粒度', String(request?.request?.groupKey))
  check(
    Array.isArray(request?.request?.scopes) &&
      request.request.scopes.join(',') === 'once,session,always',
    '2e. 只提供三档授权范围,没有"所有工具"',
    JSON.stringify(request?.request?.scopes)
  )
  s.send({ cmd: 'approval.respond', approvalId: request.request.id, approved: false })
  const denied = await s.waitFor((e) => e.type === 'approval.resolved', 10_000)
  check(denied?.approved === false, '2f. 拒绝被记录')
  const finished = await s.waitFor((e) => e.type === 'tool.finished', 20_000)
  check((finished?.summary ?? '').includes('USER_DENIED') || finished?.ok === false, '2g. 拒绝后工具未成功', JSON.stringify(finished))
  check((await markers()).length === 0, '2h. 拒绝后工具真的没有执行')
  await s.close()
}

// ── 3. session 授权:同组第二个工具不再询问 ───────────────────────────────────
{
  await clearMarkers()
  const s = openSession()
  await s.waitFor((e) => e.type === 'ready')
  s.send({ cmd: 'approval.ready' })
  await s.waitFor((e) => e.type === 'approval.ready')
  s.send({ text: `调用 ${plugin.name}__charge`, mode: 'craft' })
  const first = await s.waitFor((e) => e.type === 'approval.request', 30_000)
  s.send({ cmd: 'approval.respond', approvalId: first.request.id, approved: true, scope: 'session' })
  const firstDone = await s.waitFor((e) => e.type === 'done', 30_000)
  check(Boolean(firstDone), '3a. 首次调用完成')
  check((await markers()).includes('charge'), '3b. 授权后 charge 执行')

  s.send({ text: `调用 ${plugin.name}__audit`, mode: 'craft' })
  const secondDone = await s.waitFor((e) => e.type === 'done', 30_000)
  check(Boolean(secondDone), '3c. 同组第二次调用完成')
  const approvalCount = s.events().filter((e) => e.type === 'approval.request').length
  check(approvalCount === 1, '3d. 同会话同组不再重复询问', String(approvalCount))
  check((await markers()).includes('audit'), '3e. 第二个工具确实执行')
  await s.close()
}

// ── 4. always 授权持久化、可见、可撤销 ────────────────────────────────────────
{
  await clearMarkers()
  const s = openSession()
  await s.waitFor((e) => e.type === 'ready')
  s.send({ cmd: 'approval.ready' })
  await s.waitFor((e) => e.type === 'approval.ready')
  s.send({ text: `调用 ${plugin.name}__charge`, mode: 'craft' })
  const request = await s.waitFor((e) => e.type === 'approval.request', 30_000)
  s.send({ cmd: 'approval.respond', approvalId: request.request.id, approved: true, scope: 'always' })
  await s.waitFor((e) => e.type === 'done', 30_000)

  s.send({ cmd: 'approval.grants', requestId: 'g1' })
  const grants = await s.waitFor((e) => e.type === 'approval.grants', 10_000)
  const grant = (grants?.grants ?? []).find((g) => g.groupKey === 'plugin:p8-guard:billing')
  check(Boolean(grant), '4a. 长期授权出现在授权列表')
  const days = grant?.expiresAt ? (Date.parse(grant.expiresAt) - Date.now()) / 86_400_000 : 0
  check(days > 29 && days <= 30.01, '4b. 默认 30 天有效期', String(days.toFixed(2)))

  s.send({ cmd: 'approval.revoke', groupKey: 'plugin:p8-guard:billing', requestId: 'rv1' })
  const revoked = await s.waitFor((e) => e.type === 'approval.revoked', 10_000)
  check(revoked?.removed === true, '4c. 撤销长期授权')
  const remaining = s.events().filter((e) => e.type === 'approval.request').length
  s.send({ text: `调用 ${plugin.name}__audit`, mode: 'craft' })
  const again = await s.waitFor((e) => e.type === 'approval.request', 20_000)
  check(Boolean(again), '4d. 撤销后重新询问', `之前请求数 ${remaining}`)
  s.send({ cmd: 'approval.respond', approvalId: again.request.id, approved: false })
  await s.waitFor((e) => e.type === 'progress' || e.type === 'done', 20_000).catch(() => null)
  await s.close()
}

// ── 5. always 授权跨会话生效,且过期后重新询问 ───────────────────────────────
{
  await clearMarkers()
  const s = openSession()
  await s.waitFor((e) => e.type === 'ready')
  s.send({ cmd: 'approval.ready' })
  await s.waitFor((e) => e.type === 'approval.ready')
  s.send({ text: `调用 ${plugin.name}__charge`, mode: 'craft' })
  const request = await s.waitFor((e) => e.type === 'approval.request', 30_000)
  s.send({ cmd: 'approval.respond', approvalId: request.request.id, approved: true, scope: 'always' })
  await s.waitFor((e) => e.type === 'done', 30_000)
  await s.close()

  const db = new Database(join(dataDir, 'openwb.db'))
  const before = db.prepare('SELECT group_key, expires_at FROM approval_grant WHERE group_key = ?').get('plugin:p8-guard:billing')
  check(before?.group_key === 'plugin:p8-guard:billing', '5a. always 授权已写入数据库')
  db.prepare('UPDATE approval_grant SET expires_at = ? WHERE group_key = ?').run(
    new Date(Date.now() - 60_000).toISOString(),
    'plugin:p8-guard:billing'
  )
  db.close()

  const s2 = openSession()
  await s2.waitFor((e) => e.type === 'ready')
  s2.send({ cmd: 'approval.ready' })
  await s2.waitFor((e) => e.type === 'approval.ready')
  s2.send({ text: `调用 ${plugin.name}__audit`, mode: 'craft' })
  const again = await s2.waitFor((e) => e.type === 'approval.request', 30_000)
  check(Boolean(again), '5b. 过期授权不再放行,重新询问')
  s2.send({ cmd: 'approval.respond', approvalId: again.request.id, approved: false })
  await s2.close()
}

// ── 6. 清单在运行期被改坏:必须 ask,而不是继续放行 ──────────────────────────
{
  await clearMarkers()
  const s = openSession()
  await s.waitFor((e) => e.type === 'ready')
  s.send({ cmd: 'approval.ready' })
  await s.waitFor((e) => e.type === 'approval.ready')
  const manifestPath = join(dataDir, 'plugins', plugin.name, 'plugin.json')
  const original = await readFile(manifestPath, 'utf8')
  await writeFile(manifestPath, '{ not valid json', 'utf8')
  s.send({ text: `调用 ${plugin.name}__charge`, mode: 'craft' })
  const request = await s.waitFor((e) => e.type === 'approval.request', 30_000)
  check(request?.request?.riskKind === 'unknown', '6a. 清单损坏按未知风险处理', String(request?.request?.riskKind))
  check((request?.request?.title ?? '').includes('风险声明不可用'), '6b. 审批卡说明清单不可用', String(request?.request?.title))
  s.send({ cmd: 'approval.respond', approvalId: request.request.id, approved: false })
  await s.waitFor((e) => e.type === 'approval.resolved', 10_000)
  check((await markers()).length === 0, '6c. 清单损坏且拒绝时工具未执行')
  await writeFile(manifestPath, original, 'utf8')
  await s.close()
}

// ── 7. 非法 scope 不得默认放行 ───────────────────────────────────────────────
{
  const s = openSession()
  await s.waitFor((e) => e.type === 'ready')
  s.send({ cmd: 'approval.ready' })
  await s.waitFor((e) => e.type === 'approval.ready')
  s.send({ text: `调用 ${plugin.name}__charge`, mode: 'craft' })
  const request = await s.waitFor((e) => e.type === 'approval.request', 30_000)
  s.send({ cmd: 'approval.respond', approvalId: request.request.id, approved: true, scope: 'everything', requestId: 'bad' })
  const answered = await s.waitFor((e) => e.type === 'approval.answered', 10_000)
  check(answered?.ok === false && answered?.code === 'BAD_SCOPE', '7a. 非法 scope 被拒绝', JSON.stringify(answered))
  check((await markers()).length === 0, '7b. 非法 scope 不会放行执行')
  s.send({ cmd: 'approval.respond', approvalId: request.request.id, approved: false })
  await s.close()
}

await rm(base, { recursive: true, force: true })

if (failed > 0) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\nP8-1 审批闸门验收通过')

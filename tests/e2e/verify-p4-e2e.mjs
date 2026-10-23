/**
 * P4 端到端验收（对应 IMPLEMENTATION §5.8）。
 * 用法: node tests/e2e/verify-p4-e2e.mjs
 * 前置: pnpm --filter @openwb/daemon build
 *
 * 说明:全部走 OPENWB_MOCK,不依赖网络与 API Key。
 * token 统计另由 packages/storage 单测覆盖;这里补一条"重启后历史可读"的端到端链路。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const entry = resolve(root, 'apps/daemon/dist/index.js')
const require = createRequire(resolve(root, 'apps/daemon/package.json'))
const Database = require('better-sqlite3')

if (!existsSync(entry)) {
  console.error(`缺少 daemon 产物: ${entry}`)
  console.error('先执行: pnpm --filter @openwb/daemon build')
  process.exit(1)
}

let failed = 0
const check = (ok, label, detail = '') => {
  if (ok) console.log(`PASS ${label}`)
  else { failed++; console.log(`FAIL ${label} ${detail}`) }
}

const base = await mkdtemp(join(tmpdir(), 'owb-p4-e2e-'))
const workspace = join(base, 'ws')
const dataDir = join(base, 'data')
const dbPath = join(dataDir, 'openwb.db')
await mkdir(workspace, { recursive: true })
await mkdir(join(workspace, '.git'), { recursive: true })
await writeFile(join(workspace, 'README.md'), '# p4 workspace\n', 'utf8')
await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'p4-ws', devDependencies: { vitest: '^5.0.0' } }, null, 2), 'utf8')
await writeFile(join(workspace, '.gitignore'), 'node_modules/\n', 'utf8')

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
    try { out.push(JSON.parse(json)) } catch { out.push({ type: 'PARSE_ERROR', raw: json }) }
  }
  return out
}

/** 起一个 daemon,顺序发送 frames,写完 stdin 后等它把队列跑完再退出 */
function runSession(frames, opts = {}) {
  const dir = opts.dataDir ?? dataDir
  const ws = opts.workspace ?? workspace
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: {
        ...process.env,
        OPENWB_MOCK: '1',
        OPENWB_WORKSPACE: ws,
        OPENWB_DATA_DIR: dir,
        OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
        OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts'),
        ...(opts.skillsDir ? { OPENWB_SKILLS_DIR: opts.skillsDir } : {})
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const chunks = []
    let err = ''
    const timer = setTimeout(() => { child.kill(); rej(new Error(`daemon 超时 ${opts.timeoutMs ?? 60000}ms`)) }, opts.timeoutMs ?? 60000)
    child.stdout.on('data', (b) => chunks.push(b))
    child.stderr.on('data', (b) => { err += String(b) })
    child.on('error', (e) => { clearTimeout(timer); rej(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      res({ code, events: decodeFrames(Buffer.concat(chunks)), err })
    })
    for (const f of frames) child.stdin.write(encodeFrame(f))
    child.stdin.end()
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const eventOf = (events, type) => events.find((e) => e.type === type)

try {
  // ---------- 1. 建表 + 版本 ----------
  const first = await runSession([{ cmd: 'modes.list', requestId: 'init' }])
  check(first.code === 0, 'daemon-exit-zero', `code=${first.code} ${first.err.slice(0, 200)}`)
  check(existsSync(dbPath), 'db-file-created', dbPath)

  const db = new Database(dbPath, { readonly: true })
  const tableNames = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
    .all()
    .map((r) => r.name)
  const expectedTables = [
    'workspace', 'conversation', 'message', 'task', 'artifact',
    'skill', 'plugin', 'automation', 'approval_grant', 'memory_entry', 'event_log'
  ]
  check(expectedTables.every((t) => tableNames.includes(t)), 'all-tables-exist', JSON.stringify(tableNames))
  check(tableNames.includes('memory_fts'), 'fts-table-exists')
  check(db.pragma('user_version', { simple: true }) >= 1, 'schema-version-at-least-1')
  db.close()

  // ---------- 2. 重启后历史仍在 ----------
  const s1 = await runSession([
    { text: '请只回复:第一条持久化消息', mode: 'craft', clientRequestId: 'persist-1' }
  ])
  const convId = eventOf(s1.events, 'conversation.ready')?.conversationId
  check(!!convId, 'conversation-ready', JSON.stringify(s1.events.map((e) => e.type)))
  check(!!eventOf(s1.events, 'memory.injected'), 'memory-injected-event')

  // 模拟模型回填 token 统计(daemon 落 assistant 消息时写 token_in/token_out)
  const writer = new Database(dbPath)
  writer.prepare("UPDATE message SET token_in = 123, token_out = 45 WHERE conversation_id = ? AND role = 'assistant'").run(convId)
  writer.close()

  const s2 = await runSession([{ cmd: 'conversation.history', conversationId: convId, requestId: 'hist' }])
  const hist = eventOf(s2.events, 'conversation.history')
  const assistant = hist?.messages?.find((m) => m.role === 'assistant')
  check((hist?.messages ?? []).length === 2, 'history-survives-restart', JSON.stringify((hist?.messages ?? []).map((m) => m.role)))
  check(assistant?.content?.text?.includes('第一条持久化消息'), 'history-content-intact')
  check(assistant?.tokenIn === 123 && assistant?.tokenOut === 45, 'history-token-stats-intact', JSON.stringify(assistant ?? null))

  // ---------- 3. clientRequestId 幂等 ----------
  const s3 = await runSession([
    { text: '幂等请求', mode: 'craft', conversationId: convId, clientRequestId: 'dup-1' },
    { text: '幂等请求', mode: 'craft', conversationId: convId, clientRequestId: 'dup-1' }
  ])
  check(!!eventOf(s3.events, 'deduped'), 'duplicate-emits-deduped')
  const reader = new Database(dbPath, { readonly: true })
  const dupRows = reader
    .prepare("SELECT count(*) AS n FROM message WHERE conversation_id = ? AND client_request_id = 'dup-1'")
    .get(convId)
  check(dupRows.n === 1, 'duplicate-stored-once', JSON.stringify(dupRows))
  reader.close()

  // ---------- 4. 会话隔离 ----------
  const s4 = await runSession([
    { cmd: 'conversation.new', title: '会话B', mode: 'craft', requestId: 'new-b' }
  ])
  const convB = eventOf(s4.events, 'conversation.created')?.conversationId
  check(!!convB && convB !== convId, 'conversation-created', String(convB))

  const s5 = await runSession([{ text: '只属于B的消息', mode: 'craft', conversationId: convB, clientRequestId: 'b-1' }])
  check(s5.events.some((e) => e.type === 'done'), 'conversation-b-run-done')

  const s6 = await runSession([
    { cmd: 'conversation.history', conversationId: convId, requestId: 'h-a' }
  ])
  const aJson = JSON.stringify(eventOf(s6.events, 'conversation.history')?.messages ?? [])
  const s7 = await runSession([
    { cmd: 'conversation.history', conversationId: convB, requestId: 'h-b' }
  ])
  const bJson = JSON.stringify(eventOf(s7.events, 'conversation.history')?.messages ?? [])
  check(!aJson.includes('只属于B的消息'), 'conversation-isolation')
  check(bJson.includes('只属于B的消息'), 'conversation-b-has-own-message')

  // ---------- 5. 删除会话级联 ----------
  const s8 = await runSession([{ cmd: 'conversation.delete', conversationId: convB, requestId: 'del-b' }])
  check(!!eventOf(s8.events, 'conversation.deleted'), 'conversation-delete-event')
  const counter = new Database(dbPath, { readonly: true })
  const orphan = {
    message: counter.prepare('SELECT count(*) AS n FROM message WHERE conversation_id = ?').get(convB).n,
    task: counter.prepare('SELECT count(*) AS n FROM task WHERE conversation_id = ?').get(convB).n,
    event: counter.prepare('SELECT count(*) AS n FROM event_log WHERE conversation_id = ?').get(convB).n
  }
  counter.close()
  check(orphan.message === 0 && orphan.task === 0 && orphan.event === 0, 'cascade-delete-no-orphans', JSON.stringify(orphan))

  // ---------- 6. 版本过高拒绝启动 ----------
  const badDir = join(base, 'data-bad')
  await mkdir(badDir, { recursive: true })
  const badDb = new Database(join(badDir, 'openwb.db'))
  badDb.pragma('user_version = 999')
  badDb.close()
  const bad = await runSession([{ cmd: 'modes.list' }], { dataDir: badDir })
  const dbUnavailable = bad.events.find((e) => e.type === 'error' && e.code === 'DB_UNAVAILABLE')
  check(!!dbUnavailable, 'too-new-schema-refused', JSON.stringify(bad.events.map((e) => e.type)))
  check(/高于应用支持/.test(bad.err) || /高于应用支持/.test(dbUnavailable?.message ?? ''), 'refusal-message-explicit', bad.err.slice(0, 200))

  // ---------- 7. 工作区日志同日追加 ----------
  await runSession([{ text: '日志第一条', mode: 'craft', clientRequestId: 'log-1' }])
  await runSession([{ text: '日志第二条', mode: 'craft', clientRequestId: 'log-2' }])
  const day = new Date().toISOString().slice(0, 10)
  const logFile = join(workspace, '.openwb', 'memory', `${day}.md`)
  const logText = await readFile(logFile, 'utf8')
  const logLines = logText.trim().split(/\r?\n/).filter(Boolean)
  // 前面几轮会话也会写日志,这里只关心"是追加而不是覆盖":两条新行都在,且顺序正确
  const firstIdx = logLines.findIndex((l) => l.includes('日志第一条'))
  const secondIdx = logLines.findIndex((l) => l.includes('日志第二条'))
  check(firstIdx >= 0 && secondIdx > firstIdx, 'daily-log-appends-not-overwrites', JSON.stringify(logLines))
  check(logLines.every((l) => /^- \d{4}-\d{2}-\d{2}T.+ \| \w+ \| /.test(l)), 'daily-log-line-format', JSON.stringify(logLines[0]))

  // ---------- 8. 用户级记忆超预算:保留偏好、截断事实 ----------
  const memoryFile = join(dataDir, 'memory', 'MEMORY.md')
  const prefs = ['偏好甲:结论先行', '偏好乙:中文输出', '偏好丙:代码用 TypeScript']
  const facts = Array.from({ length: 30 }, (_, i) => `事实${i}:` + '很长的历史事实内容'.repeat(12))
  await writeFile(
    memoryFile,
    ['# 用户记忆', '', '## 偏好', ...prefs.map((p) => `- ${p}`), '', '## 事实', ...facts.map((f) => `- ${f}`), ''].join('\n'),
    'utf8'
  )
  const hashOf = (kind, content) =>
    createHash('sha256').update(`user\u0000${kind}\u0000${content.replace(/\s+/g, ' ').trim()}`).digest('hex')
  const seeder = new Database(dbPath)
  const insert = seeder.prepare(
    `INSERT INTO memory_entry (id, scope, workspace_id, kind, content, content_hash, source_path, pinned, tokens, created_at, deleted_at)
     VALUES (?, 'user', NULL, ?, ?, ?, ?, 0, ?, ?, NULL)`
  )
  let seq = 0
  const now = new Date().toISOString()
  const prefIds = []
  for (const p of prefs) {
    const id = `01PREF${String(seq++).padStart(20, '0')}`
    prefIds.push(id)
    insert.run(id, 'preference', p, hashOf('preference', p), memoryFile, 12, now)
  }
  for (const f of facts) {
    const id = `01FACT${String(seq++).padStart(20, '0')}`
    insert.run(id, 'fact', f, hashOf('fact', f), memoryFile, 200, now)
  }
  seeder.close()

  const s9 = await runSession([{ text: '记忆预算检查', mode: 'craft', clientRequestId: 'mem-budget' }])
  const injected = eventOf(s9.events, 'memory.injected')
  const userBlock = injected?.blocks?.find((b) => b.scope === 'user')
  check(!!injected, 'memory-injected-for-budget')
  check(prefIds.every((id) => userBlock?.ids?.includes(id)), 'all-preferences-retained', JSON.stringify(userBlock ?? null))
  check((userBlock?.truncated ?? 0) > 0, 'facts-truncated', JSON.stringify(userBlock ?? null))
  check((injected?.truncatedTotal ?? 0) > 0, 'truncated-total-positive')

  // ---------- 9. 删除记忆后不再注入 ----------
  const listBefore = await runSession([{ cmd: 'memory.list', scope: 'user', requestId: 'm1' }])
  const items = eventOf(listBefore.events, 'memory.list')?.items ?? []
  const target = items.find((i) => i.kind === 'preference')
  check(!!target, 'memory-list-has-user-items', String(items.length))

  const del = await runSession([{ cmd: 'memory.delete', id: target.id, requestId: 'mdel' }])
  check(!!eventOf(del.events, 'memory.deleted'), 'memory-delete-event')

  const listAfter = await runSession([{ cmd: 'memory.list', scope: 'user', requestId: 'm2' }])
  const afterItems = eventOf(listAfter.events, 'memory.list')?.items ?? []
  check(!afterItems.some((i) => i.id === target.id), 'memory-gone-from-list')
  const mdAfter = await readFile(memoryFile, 'utf8')
  check(!mdAfter.includes(target.content), 'memory-gone-from-file')

  const s10 = await runSession([{ text: '记忆预算再检查', mode: 'craft', clientRequestId: 'mem-budget-2' }])
  const injected2 = eventOf(s10.events, 'memory.injected')
  const userBlock2 = injected2?.blocks?.find((b) => b.scope === 'user')
  check(!userBlock2?.ids?.includes(target.id), 'deleted-memory-not-injected', JSON.stringify(userBlock2 ?? null))

  // ---------- 10. .gitignore ----------
  const gitignore = await readFile(join(workspace, '.gitignore'), 'utf8')
  check(gitignore.split(/\r?\n/).filter((l) => l.trim() === '.openwb/').length === 1, 'gitignore-has-openwb')

  // ---------- 11. 数据完整性(备份策略由 storage 单测覆盖) ----------
  const finalDb = new Database(dbPath, { readonly: true })
  const integrity = finalDb.pragma('integrity_check', { simple: true })
  const ftsCount = finalDb.prepare('SELECT count(*) AS n FROM memory_fts').get().n
  const allRows = finalDb.prepare('SELECT count(*) AS n FROM memory_entry').get().n
  const liveRows = finalDb.prepare('SELECT count(*) AS n FROM memory_entry WHERE deleted_at IS NULL').get().n
  finalDb.close()
  check(integrity === 'ok', 'db-integrity-ok', String(integrity))
  // 软删除是设计选择:memory_fts 镜像全部行,查询期再按 deleted_at 过滤。
  check(ftsCount === allRows, 'fts-mirrors-all-rows', `${ftsCount} vs ${allRows}`)
  check(liveRows === allRows - 1, 'soft-delete-kept-one-row', `${liveRows} vs ${allRows}`)
  check(!existsSync(join(badDir, 'backups')), 'no-backup-on-fresh-db')

  await sleep(50)
} catch (err) {
  failed++
  console.error(`FAIL 运行异常: ${err?.stack ?? err}`)
} finally {
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

console.log(failed === 0 ? '\nP4 e2e: all checks passed' : `\nP4 e2e: ${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)

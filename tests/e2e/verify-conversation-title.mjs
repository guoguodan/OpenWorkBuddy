/**
 * 会话自动标题验收。
 *
 * 覆盖:
 *   - 首轮结束后自动生成可辨识标题,不再是"新会话";
 *   - 自动标题通过 conversation.updated 推送,侧栏无需整表刷新;
 *   - 用户手动改名优先展示,且不会被下一轮自动标题覆盖;
 *   - 会话列表与数据库都保留自动标题作为兜底。
 *
 * 用法: node tests/e2e/verify-conversation-title.mjs
 * 前置: pnpm --filter @openwb/daemon build
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const entry = resolve(root, 'apps/daemon/dist/index.js')
if (!existsSync(entry)) {
  console.error('缺少 daemon 产物,先执行 pnpm --filter @openwb/daemon build')
  process.exit(1)
}

const require = createRequire(resolve(root, 'apps/daemon/package.json'))
const Database = require('better-sqlite3')

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
  const child = spawn(process.execPath, [entry], {
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
  const waitForEvent = async (predicate, timeoutMs = 15000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const all = events()
      for (let i = cursor; i < all.length; i++) {
        if (predicate(all[i])) {
          cursor = i + 1
          return all[i]
        }
      }
      await sleep(20)
    }
    return null
  }
  const call = async (frame, type, timeoutMs = 15000) => {
    const requestId = frame.requestId ?? `r-${Math.random().toString(36).slice(2, 8)}`
    send({ ...frame, requestId })
    return waitForEvent((e) => e.requestId === requestId && (e.type === type || e.type === 'error'), timeoutMs)
  }
  const close = async () => {
    child.stdin.end()
    await Promise.race([closed, sleep(5000)])
    child.kill()
  }
  return { send, call, waitForEvent, events, close, stderr: () => err }
}

const base = await mkdtemp(join(tmpdir(), 'owb-title-e2e-'))
const workspace = join(base, 'ws')
const dataDir = join(base, 'data')
await mkdir(workspace, { recursive: true })
await writeFile(join(workspace, 'package.json'), '{"name":"title-e2e"}\n', 'utf8')

const session = openSession(workspace, dataDir)
try {
  const created = await session.call({ cmd: 'conversation.new', title: '新会话' }, 'conversation.created')
  const conversationId = created?.conversationId
  check(Boolean(conversationId), '创建测试会话')

  session.send({
    cmd: 'chat',
    conversationId,
    mode: 'craft',
    text: '帮我把 PDF 资料转换成 Markdown,并整理成一份目录清晰的知识库'
  })
  // 标题在 done 之前发出:先抓事件再等 done,否则游标会越过它。
  const titleEvent = await session.waitForEvent(
    (e) => e.type === 'conversation.updated' && e.conversation?.id === conversationId,
    20000
  )
  const done = await session.waitForEvent((e) => e.type === 'done', 20000)
  check(Boolean(done), '首轮完成')
  const autoTitle = titleEvent?.conversation?.title ?? ''
  check(Boolean(titleEvent), '收到自动标题事件')
  check(autoTitle.length > 0 && autoTitle !== '新会话', '自动标题可辨识', autoTitle)
  check(!/[。！？.!?]$/.test(autoTitle), '自动标题不带句末标点', autoTitle)
  check(Array.from(autoTitle).length <= 24, '自动标题长度受限', autoTitle)

  const listed = await session.call({ cmd: 'conversation.list' }, 'conversation.list')
  const item = listed?.conversations?.find((c) => c.id === conversationId)
  check(item?.title === autoTitle, '会话列表展示自动标题', JSON.stringify(item ?? {}))
  check(item?.autoTitle === autoTitle, '列表区分自动标题字段', JSON.stringify(item ?? {}))

  const renamed = await session.call(
    { cmd: 'conversation.rename', conversationId, title: '我的固定标题' },
    'conversation.updated'
  )
  check(renamed?.conversation?.title === '我的固定标题', '手动改名立即生效', JSON.stringify(renamed ?? {}))

  // 再跑一轮:自动标题不得覆盖用户标题。
  session.send({ cmd: 'chat', conversationId, mode: 'craft', text: '继续补充第三节' })
  const secondDone = await session.waitForEvent((e) => e.type === 'done', 20000)
  check(Boolean(secondDone), '第二轮完成')
  await sleep(500)
  const after = await session.call({ cmd: 'conversation.list' }, 'conversation.list')
  const afterItem = after?.conversations?.find((c) => c.id === conversationId)
  check(afterItem?.title === '我的固定标题', '后续轮次不覆盖用户标题', JSON.stringify(afterItem ?? {}))
  check(afterItem?.autoTitle === autoTitle, '自动标题仍保留为兜底', JSON.stringify(afterItem ?? {}))

  await session.close()
  const db = new Database(join(dataDir, 'openwb.db'), { readonly: true })
  const row = db.prepare('select title, custom_title from conversation where id = ?').get(conversationId)
  db.close()
  check(row?.title === autoTitle, '数据库中保留自动标题', JSON.stringify(row ?? {}))
  check(row?.custom_title === '我的固定标题', '数据库分离保存用户标题', JSON.stringify(row ?? {}))
} finally {
  await session.close()
  if (failed > 0) {
    const err = session.stderr().trim()
    if (err) console.log(`--- daemon stderr ---\n${err.split('\n').slice(-12).join('\n')}`)
  }
  await rm(base, { recursive: true, force: true }).catch(() => undefined)
}

process.exit(failed === 0 ? 0 : 1)

/**
 * P8-2 个人文件保护验收。
 * 用法: node tests/e2e/verify-p8-2.mjs
 * 前置: pnpm --filter @openwb/daemon build
 *
 * 全程在临时目录里跑:
 *  - USERPROFILE/HOME 指向临时主目录,所谓"桌面"只是 <tmp>/home/Desktop;
 *  - OPENWB_TRASH_FAKE=1 用内存回收站,不碰开发机真实回收站;
 *  - 文件是否消失、备份是否存在,都由测试自己核对。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const entry = resolve(root, 'apps/daemon/dist/index.js')

if (!existsSync(entry)) {
  console.error('缺少 daemon 产物,先执行: pnpm --filter @openwb/daemon build')
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

const base = await mkdtemp(join(tmpdir(), 'owb-p8-2-'))
const workspace = join(base, 'ws')
const dataDir = join(base, 'data')
const home = join(base, 'home')
const desktop = join(home, 'Desktop')
const systemPath =
  process.platform === 'win32'
    ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
    : '/usr/bin/env'

await mkdir(workspace, { recursive: true })
await mkdir(dataDir, { recursive: true })
await mkdir(desktop, { recursive: true })
await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'p8-2-ws' }), 'utf8')

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

function openSession() {
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      OPENWB_MOCK: '1',
      OPENWB_WORKSPACE: workspace,
      OPENWB_DATA_DIR: dataDir,
      OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
      OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts'),
      OPENWB_TRASH_FAKE: '1',
      OPENWB_PLUGIN_HEALTH_MS: '60000',
      OPENWB_AUTOMATION_AUTOSTART: '0',
      OPENWB_APPROVAL_TIMEOUT_MS: '20000',
      USERPROFILE: home,
      HOME: home
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
      await new Promise((r) => setTimeout(r, 40))
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

async function startReady() {
  const s = openSession()
  check(Boolean(await s.waitFor((e) => e.type === 'ready')), '0. daemon 启动', s.stderr().slice(-300))
  s.send({ cmd: 'approval.ready', requestId: 'ready' })
  check(Boolean(await s.waitFor((e) => e.type === 'approval.ready')), '0b. 审批界面就绪')
  return s
}

async function backups() {
  const rootDir = join(dataDir, 'backups', 'destructive')
  if (!existsSync(rootDir)) return []
  const out = []
  for (const name of await readdir(rootDir)) {
    const manifestPath = join(rootDir, name, 'manifest.json')
    if (!existsSync(manifestPath)) continue
    out.push({
      manifestPath,
      manifest: JSON.parse(await readFile(manifestPath, 'utf8'))
    })
  }
  return out.sort((a, b) => a.manifestPath.localeCompare(b.manifestPath))
}

// ── 1. 拒绝授权:文件必须原样保留 ───────────────────────────────────────────
{
  const keepPath = join(desktop, 'keep-me.txt')
  await writeFile(keepPath, 'keep', 'utf8')
  const s = await startReady()
  s.send({ text: `delete_files:["${keepPath.replace(/\\/g, '\\\\')}"]`, mode: 'craft' })
  const request = await s.waitFor((e) => e.type === 'approval.request')
  check(Boolean(request?.request?.id), '1a. 删除桌面文件先弹出确认')
  check(request?.request?.riskKind === 'destructive', '1b. 识别为破坏性操作', String(request?.request?.riskKind))
  check(request?.request?.plan?.operation === 'delete', '1c. 审批卡携带删除计划')
  check(request?.request?.plan?.items?.length === 1, '1d. 清单包含 1 项')
  check(Array.isArray(request?.request?.scopes) && request.request.scopes.join(',') === 'once', '1e. 破坏性操作只允许仅本次', JSON.stringify(request?.request?.scopes))
  check(existsSync(keepPath), '1f. 审批前文件没有被提前删除')
  s.send({ cmd: 'approval.respond', approvalId: request.request.id, approved: false })
  const finished = await s.waitFor((e) => e.type === 'tool.finished')
  check(finished?.ok === false, '1g. 拒绝后工具失败', JSON.stringify(finished))
  check(existsSync(keepPath), '1h. 拒绝后文件仍然存在')
  await s.close()
}

// ── 2. 批准删除:清单、备份、可还原证据 ─────────────────────────────────────
{
  const a = join(desktop, 'alpha.txt')
  const b = join(desktop, 'beta.txt')
  await writeFile(a, 'alpha-content', 'utf8')
  await writeFile(b, 'beta-content', 'utf8')
  const s = await startReady()
  const payload = [a, b].map((p) => p.replace(/\\/g, '\\\\'))
  s.send({ text: `delete_files:["${payload[0]}","${payload[1]}"]`, mode: 'craft' })
  const request = await s.waitFor((e) => e.type === 'approval.request')
  const items = request?.request?.plan?.items ?? []
  check(items.length === 2, '2a. 审批清单列出完整 2 项', JSON.stringify(items))
  check(items.every((i) => i.kind === 'file' && typeof i.size === 'number'), '2b. 清单含类型与大小')
  check(items.some((i) => i.path.endsWith('alpha.txt')) && items.some((i) => i.path.endsWith('beta.txt')), '2c. 清单路径完整')
  check(existsSync(a) && existsSync(b), '2d. 批准前两个文件都在')
  s.send({ cmd: 'approval.respond', approvalId: request.request.id, approved: true, scope: 'once' })
  const finished = await s.waitFor((e) => e.type === 'tool.finished')
  check(finished?.ok === true && (finished.summary ?? '').includes('2 项'), '2e. 删除成功且摘要含数量', JSON.stringify(finished))
  check(!existsSync(a) && !existsSync(b), '2f. 两个文件已从原位置移除')
  const all = await backups()
  const record = all.find((x) => x.manifest.items.some((i) => i.originalPath === a))
  check(Boolean(record), '2g. 生成备份清单', JSON.stringify(all.map((x) => x.manifestPath)))
  check(record?.manifest.items.length === 2, '2h. 备份清单覆盖两项')
  const alphaBackup = record?.manifest.items.find((i) => i.originalPath === a)
  check(
    Boolean(alphaBackup?.backupPath) && existsSync(alphaBackup.backupPath),
    '2i. 备份文件真实存在'
  )
  check(
    alphaBackup ? (await readFile(alphaBackup.backupPath, 'utf8')) === 'alpha-content' : false,
    '2j. 备份内容与原文件一致(可还原)'
  )
  check(
    (finished?.summary ?? '').includes(record?.manifestPath ? dirname(record.manifestPath) : '__missing__'),
    '2k. 工具摘要给出备份目录'
  )
  s.send({ cmd: 'approval.respond', approvalId: 'not-a-real-id', approved: true, scope: 'once' })
  await s.close()
}

// ── 3. 单批 11 项:在触碰磁盘前拒绝,不弹审批 ───────────────────────────────
{
  const many = Array.from({ length: 11 }, (_, i) => join(desktop, `bulk-${i}.txt`).replace(/\\/g, '\\\\'))
  const s = await startReady()
  s.send({ text: `delete_files:[${many.map((p) => `"${p}"`).join(',')}]`, mode: 'craft' })
  const denied = await s.waitFor((e) => e.type === 'approval.denied')
  check(denied?.code === 'BATCH_TOO_LARGE', '3a. 11 项返回 BATCH_TOO_LARGE', JSON.stringify(denied))
  check(!s.events().some((e) => e.type === 'approval.request'), '3b. 超批次不弹审批')
  check(!existsSync(join(desktop, 'bulk-0.txt')), '3c. 未创建/未触碰任何目标')
  await s.close()
}

// ── 4. 系统目录:直接拒绝,不弹审批 ─────────────────────────────────────────
{
  const s = await startReady()
  s.send({ text: `delete_files:["${systemPath.replace(/\\/g, '\\\\')}"]`, mode: 'craft' })
  const denied = await s.waitFor((e) => e.type === 'approval.denied')
  check(denied?.code === 'PATH_SYSTEM_DENIED', '4a. 系统目录返回 PATH_SYSTEM_DENIED', JSON.stringify(denied))
  check(!s.events().some((e) => e.type === 'approval.request'), '4b. 系统目录不弹审批')
  await s.close()
}

// ── 5. shell 参数按数组传递,`; rm -rf /` 不被解释 ─────────────────────────
{
  const s = await startReady()
  s.send({
    text: 'shell:{"command":"node","args":["-e","console.log(process.argv[1])","; rm -rf /"]}',
    mode: 'craft'
  })
  const finished = await s.waitFor((e) => e.type === 'tool.finished')
  check(finished?.ok === true, '5a. node 参数调用成功', JSON.stringify(finished))
  check((finished?.summary ?? '').includes('; rm -rf /'), '5b. 分号与 rm 作为普通参数原样到达', String(finished?.summary))
  await s.close()
}

// ── 6. shell 永久删除命令:直接拒绝并提示改用 delete_files ──────────────────
{
  const victim = join(desktop, 'shell-victim.txt')
  await writeFile(victim, 'do-not-delete', 'utf8')
  const s = await startReady()
  s.send({ text: 'shell:{"command":"rm","args":["-rf","' + victim.replace(/\\/g, '\\\\') + '"]}', mode: 'craft' })
  const denied = await s.waitFor((e) => e.type === 'approval.denied')
  check(denied?.code === 'USE_DELETE_TOOL', '6a. shell rm 返回 USE_DELETE_TOOL', JSON.stringify(denied))
  check(!s.events().some((e) => e.type === 'approval.request'), '6b. shell rm 不提供“批准后执行”')
  check(existsSync(victim), '6c. shell rm 没有删除文件')
  await s.close()
}

// ── 7. 扫描首轮只读;下一轮明确执行才可审批 ─────────────────────────────────
{
  const scanTarget = join(desktop, 'scan-target.txt')
  await writeFile(scanTarget, 'scan', 'utf8')
  const escaped = scanTarget.replace(/\\/g, '\\\\')
  const s = await startReady()
  s.send({ text: `帮我清理桌面并直接 delete_files:["${escaped}"]`, mode: 'craft' })
  const blocked = await s.waitFor((e) => e.type === 'tool.finished')
  check(
    blocked?.ok === false && (blocked.summary ?? '').includes('第一轮'),
    '7a. 首轮夹带删除仍被拦为只读',
    JSON.stringify(blocked)
  )
  check(!s.events().some((e) => e.type === 'approval.request'), '7b. 首轮不弹审批')
  check(existsSync(scanTarget), '7c. 首轮文件没有被删除')

  s.send({ text: `执行删除 delete_files:["${escaped}"]`, mode: 'craft' })
  const request = await s.waitFor((e) => e.type === 'approval.request')
  check(Boolean(request?.request?.id), '7d. 下一轮明确执行后可以审批')
  s.send({ cmd: 'approval.respond', approvalId: request.request.id, approved: true, scope: 'once' })
  const finished = await s.waitFor((e) => e.type === 'tool.finished')
  check(finished?.ok === true && !existsSync(scanTarget), '7e. 用户确认后执行删除')
  await s.close()
}

// ── 8. 移动:审批清单、原路径消失、目标存在、备份可还原 ─────────────────────
{
  const from = join(desktop, 'move-from.txt')
  const to = join(home, 'Documents', 'move-to.txt')
  await mkdir(dirname(to), { recursive: true })
  await writeFile(from, 'move-content', 'utf8')
  const s = await startReady()
  s.send({
    text: `move_files:[{"from":"${from.replace(/\\/g, '\\\\')}","to":"${to.replace(/\\/g, '\\\\')}"}]`,
    mode: 'craft'
  })
  const request = await s.waitFor((e) => e.type === 'approval.request')
  const item = request?.request?.plan?.items?.[0]
  check(request?.request?.plan?.operation === 'move', '8a. 审批卡标明移动操作')
  check(item?.path === from && item?.destPath === to, '8b. 审批清单含原路径与目标路径', JSON.stringify(item))
  s.send({ cmd: 'approval.respond', approvalId: request.request.id, approved: true, scope: 'once' })
  const finished = await s.waitFor((e) => e.type === 'tool.finished')
  check(finished?.ok === true && (finished.summary ?? '').includes('1 项'), '8c. 移动成功', JSON.stringify(finished))
  check(!existsSync(from), '8d. 原路径已消失')
  check(existsSync(to) && (await readFile(to, 'utf8')) === 'move-content', '8e. 目标路径内容正确')
  const record = (await backups()).find((x) => x.manifest.items.some((i) => i.originalPath === from))
  check(record?.manifest.operation === 'move', '8f. 移动也生成备份清单')
  const backedUp = record?.manifest.items.find((i) => i.originalPath === from)
  check(Boolean(backedUp?.backupPath) && existsSync(backedUp.backupPath), '8g. 移动前原始内容已备份')
  await s.close()
}

await rm(base, { recursive: true, force: true })

if (failed > 0) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\nP8-2 个人文件保护验收通过')

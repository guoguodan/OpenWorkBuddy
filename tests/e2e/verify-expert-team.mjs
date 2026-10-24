/**
 * 专家互斥与专家团队验收(WM-MODE-07)。
 *
 * 覆盖:
 *   - 专家团队清单可安装,snapshot 暴露成员引用;
 *   - 团队运行时合并成员准则,trace 记为 expert + expert-team,且不落原文;
 *   - 同一会话显式切换到另一个专家返回 EXPERT_CONFLICT(带双方 ID/名称);
 *   - 重复指定同一专家是幂等的,不会被互斥拦掉;
 *   - 团队成员被关闭后,团队运行 fail-closed 并说明是哪个成员。
 *
 * 用法: node tests/e2e/verify-expert-team.mjs
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
    child.stdin.write(encodeFrame({ ...frame, requestId }))
    return waitForEvent((e) => e.requestId === requestId && (e.type === type || e.type === 'error'), timeoutMs)
  }
  const run = async (frame, timeoutMs = 30000) => {
    child.stdin.write(encodeFrame({ ...frame, requestId: frame.requestId ?? `r-${Math.random().toString(36).slice(2, 8)}` }))
    return waitForEvent((e) => e.type === 'done' || e.type === 'error', timeoutMs)
  }
  const send = (frame) => child.stdin.write(encodeFrame({ ...frame, requestId: `r-${Math.random().toString(36).slice(2, 8)}` }))
  const close = async () => {
    child.stdin.end()
    await Promise.race([closed, sleep(3000)])
    child.kill()
  }
  return { child, call, run, send, waitForEvent, events, close, stderr: () => err }
}

async function writeExpert(dir, name, patch = {}) {
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
        instructions: `${name.toUpperCase()}-INSTRUCTION`,
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

const base = await mkdtemp(join(tmpdir(), 'owb-expert-team-'))
const workspace = join(base, 'ws')
const dataDir = join(base, 'data')
const pluginSource = join(base, 'plugin-src')
await mkdir(workspace, { recursive: true })
await mkdir(dataDir, { recursive: true })
await writeFile(join(workspace, 'README.md'), '# expert team\n', 'utf8')

const legalDir = await writeExpert(join(pluginSource, 'legal-expert'), 'legal-expert', {
  displayName: '法务顾问',
  instructions: 'LEGAL-SECRET 关注违约与责任上限。'
})
const financeDir = await writeExpert(join(pluginSource, 'finance-expert'), 'finance-expert', {
  displayName: '财务分析师',
  instructions: 'FINANCE-SECRET 先算现金流与估值区间。'
})
const teamDir = await writeExpert(join(pluginSource, 'deal-team'), 'deal-team', {
  displayName: '并购专家团队',
  description: '法务与财务协同',
  instructions: 'TEAM-SECRET 结论必须同时覆盖法律与财务视角。',
  team: [
    { ref: 'legal-expert', role: '合规' },
    { ref: 'finance-expert' }
  ]
})

const s = openSession(workspace, dataDir)
try {
  await s.waitForEvent((e) => e.type === 'ready')
  for (const dir of [legalDir, financeDir, teamDir]) {
    const installed = await s.call({ cmd: 'plugins.install', sourceDir: dir }, 'plugins.installed', 30000)
    check(installed?.type === 'plugins.installed', `install-${dir.split(/[\\\\/]/).pop()}`, JSON.stringify(installed).slice(0, 240))
  }
  const listed = await s.call({ cmd: 'plugins.list' }, 'plugins.list')
  const team = (listed?.plugins ?? []).find((p) => p.name === 'deal-team')
  check(team?.kind === 'expert', 'team-is-expert-kind', JSON.stringify(team ?? null).slice(0, 200))
  check(
    team?.team?.length === 2 && team.team[0].ref === 'legal-expert' && team.team[0].role === '合规',
    'team-members-exposed-in-snapshot',
    JSON.stringify(team?.team ?? null)
  )

  const teamConversation = await s.call(
    { cmd: 'conversation.new', title: '与并购专家团队协作', expertId: 'deal-team' },
    'conversation.created'
  )
  const teamConversationId = teamConversation?.conversationId
  check(Boolean(teamConversationId), 'team-conversation-created', JSON.stringify(teamConversation))

  const teamRun = await s.run({ text: '只回复 ok', conversationId: teamConversationId })
  check(teamRun?.type === 'done', 'team-run-finished', JSON.stringify(teamRun))
  const traces = (await readdir(join(workspace, '.openwb/traces'))).filter((f) => f.startsWith('prompt-')).sort()
  const trace = JSON.parse(await readFile(join(workspace, '.openwb/traces', traces.at(-1)), 'utf8'))
  check(
    trace.injected?.includes('expert') && trace.injected?.includes('expert-team'),
    'team-trace-sections',
    JSON.stringify(trace.injected ?? null)
  )
  const rawTrace = JSON.stringify(trace)
  check(
    !rawTrace.includes('LEGAL-SECRET') && !rawTrace.includes('FINANCE-SECRET') && !rawTrace.includes('TEAM-SECRET'),
    'team-trace-does-not-leak-instructions'
  )

  // conversation.send 是"长任务"入口:冲突在事件流里返回,不带 requestId。
  const conflictWait = s.waitForEvent((e) => e.type === 'error' && e.code === 'EXPERT_CONFLICT')
  s.send({ cmd: 'conversation.send', text: '换成法务', conversationId: teamConversationId, expertId: 'legal-expert' })
  const conflict = await conflictWait
  check(conflict?.type === 'error' && conflict.code === 'EXPERT_CONFLICT', 'second-expert-rejected', JSON.stringify(conflict))
  check(
    conflict?.currentExpertId === 'deal-team' &&
      conflict?.currentExpertName === '并购专家团队' &&
      conflict?.requestedExpertId === 'legal-expert' &&
      conflict?.requestedExpertName === '法务顾问',
    'conflict-carries-both-sides',
    JSON.stringify(conflict)
  )
  check(/一个会话只允许一个专家/.test(conflict?.message ?? ''), 'conflict-message-explanatory', conflict?.message ?? '')

  const same = await s.run({ text: '继续当前专家', conversationId: teamConversationId, expertId: 'deal-team' })
  check(same?.type === 'done', 'same-expert-is-idempotent', JSON.stringify(same))

  await s.call({ cmd: 'plugins.setEnabled', name: 'finance-expert', enabled: false }, 'plugin.status')
  const brokenTeam = await s.call(
    { cmd: 'conversation.new', title: '成员关闭', expertId: 'deal-team' },
    'conversation.created'
  )
  check(
    brokenTeam?.type === 'error' && /成员已关闭/.test(brokenTeam.message ?? '') && /财务分析师/.test(brokenTeam.message ?? ''),
    'disabled-team-member-fails-closed',
    JSON.stringify(brokenTeam)
  )
  await s.call({ cmd: 'plugins.setEnabled', name: 'finance-expert', enabled: true }, 'plugin.status')

  await s.call({ cmd: 'plugins.uninstall', name: 'legal-expert' }, 'plugins.uninstalled')
  const missingMember = await s.call(
    { cmd: 'conversation.new', title: '成员卸载', expertId: 'deal-team' },
    'conversation.created'
  )
  check(
    missingMember?.type === 'error' && /成员不存在/.test(missingMember.message ?? ''),
    'missing-team-member-fails-closed',
    JSON.stringify(missingMember)
  )
} finally {
  await s.close()
  await rm(base, { recursive: true, force: true })
}

if (failed > 0) {
  console.log(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n专家互斥与专家团队验收全部通过')

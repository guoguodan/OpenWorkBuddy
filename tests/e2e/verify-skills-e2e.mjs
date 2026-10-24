/**
 * P3 端到端验收:技能发现、按需加载、工具收窄、删除即失效。
 * 用法: node tests/e2e/verify-skills-e2e.mjs
 * 前置: pnpm --filter @openwb/daemon build
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const entry = resolve(root, 'apps/daemon/dist/index.js')
const port = 9401

if (!existsSync(entry)) {
  console.error(`缺少 daemon 产物: ${entry}`)
  console.error('先执行 pnpm --filter @openwb/daemon build')
  process.exit(1)
}

let failed = 0
const check = (ok, label, detail = '') => {
  if (ok) console.log(`PASS ${label}`)
  else { failed++; console.log(`FAIL ${label} ${detail}`) }
}

/** v2 帧:4 字节大端长度 + UTF-8 JSON */
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

/** 启动 daemon,发一条命令后关闭 */
function runDaemon({ workspace, skillsDir, text, mode, mock = true, timeoutMs = 60000, dataDir, commands }) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: {
        ...process.env,
        OPENWB_WORKSPACE: workspace,
        OPENWB_DATA_DIR: dataDir ?? resolve(workspace, '.data'),
        OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
        OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts'),
        OPENWB_SKILLS_DIR: skillsDir,
        ...(mock ? { OPENWB_MOCK: '1' } : {})
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const chunks = []
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      rej(new Error(`daemon 超时 ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (b) => { chunks.push(b) })
    child.stderr.on('data', (b) => { err += String(b) })
    child.on('error', (e) => { clearTimeout(timer); rej(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      const events = decodeFrames(Buffer.concat(chunks))
      res({ code, events, err })
    })
    if (commands) {
      for (const command of commands) child.stdin.write(encodeFrame(command))
      child.stdin.end()
    } else {
      child.stdin.end(encodeFrame({ text, mode }))
    }
  })
}

/** 启动 daemon,依次执行命令;用于验证设置持久化后再重启仍生效。 */
function runCommands(options, commands) {
  return runDaemon({ ...options, commands })
}

const base = await mkdtemp(join(tmpdir(), 'owb-skill-e2e-'))
try {
  const skillsDir = join(base, 'skills')
  await mkdir(join(skillsDir, 'demo-skill'), { recursive: true })
  await mkdir(join(base, 'ws'), { recursive: true })
  await writeFile(join(base, 'ws', 'README.md'), '# demo\n', 'utf8')

  await writeFile(
    join(skillsDir, 'demo-skill', 'SKILL.md'),
    [
      '---',
      'name: demo-skill',
      'description: 只读演示技能,用于验收工具收窄',
      'allowed-tools: read_file, glob',
      '---',
      '',
      '# Demo Skill',
      '这是技能正文标记 DEMO-BODY-MARKER。',
      '只允许读取,不允许写入。'
    ].join('\n'),
    'utf8'
  )

  // 1. 启动即可见
  const listed = await runDaemon({ workspace: join(base, 'ws'), skillsDir, text: 'x', mode: 'craft' })
  const ready = listed.events.find((e) => e.type === 'ready')
  check(
    ready?.skills?.some((s) => s.name === 'demo-skill'),
    'skill-discovered-on-start',
    JSON.stringify(ready?.skills ?? [])
  )
  check(
    listed.err.includes('[skills] 1 个'),
    'skill-log-visible',
    listed.err.split('\n').find((l) => l.includes('[skills]')) ?? '(missing)'
  )

  // 2. 索引只带 name + description,不带正文
  const indexInPrompt = !listed.err.includes('DEMO-BODY-MARKER')
  check(indexInPrompt, 'body-not-injected-eagerly')

  // 3. 技能收窄:craft 模式下声明只读,load_skill 后 write_file 不可见
  const narrowed = await runDaemon({
    workspace: join(base, 'ws'),
    skillsDir,
    text: '加载 demo-skill',
    mode: 'craft',
    mock: false,
    timeoutMs: 120000
  })
  const toolsEvents = narrowed.events.filter((e) => e.type === 'tools.available')
  const activated = narrowed.events.find((e) => e.type === 'skill.activated')
  const before = toolsEvents[0]?.names ?? []
  const after = toolsEvents.at(-1)?.names ?? []

  check(before.includes('write_file'), 'craft-starts-with-write', JSON.stringify(before))
  check(!!activated && activated.name === 'demo-skill', 'skill-activated', JSON.stringify(activated ?? null))
  check(!after.includes('write_file'), 'write-tool-removed-after-load', JSON.stringify(after))
  check(after.includes('read_file'), 'read-tool-retained', JSON.stringify(after))

  // 4. trace 记录技能名
  const traceDir = join(base, 'ws', '.openwb/traces')
  let traceSkill = null
  try {
    const files = await (await import('node:fs/promises')).readdir(traceDir)
    const latest = files.filter((f) => f.endsWith('.json')).sort().at(-1)
    if (latest) {
      const trace = JSON.parse(await readFile(join(traceDir, latest), 'utf8'))
      traceSkill = trace.skill ?? null
    }
  } catch {}
  check(traceSkill === 'demo-skill', 'trace-records-skill', String(traceSkill))

  // 5. 删除技能目录后不再被发现
  await rm(join(skillsDir, 'demo-skill'), { recursive: true, force: true })
  const gone = await runDaemon({ workspace: join(base, 'ws'), skillsDir, text: 'x', mode: 'craft' })
  const ready2 = gone.events.find((e) => e.type === 'ready')
  check(
    !ready2?.skills?.some((s) => s.name === 'demo-skill'),
    'deleted-skill-not-listed',
    JSON.stringify(ready2?.skills ?? [])
  )

  // 6. 含明文凭据的技能被拒绝(不出现在索引,且 stderr 有原因)
  await mkdir(join(skillsDir, 'leaky'), { recursive: true })
  await writeFile(
    join(skillsDir, 'leaky', 'SKILL.md'),
    [
      '---',
      'name: leaky',
      'description: 含明文密钥的技能',
      '---',
      '',
      'token: sk-abcdefghijklmnopqrstuvwxyz'
    ].join('\n'),
    'utf8'
  )
  const leaky = await runDaemon({ workspace: join(base, 'ws'), skillsDir, text: 'x', mode: 'craft' })
  const ready3 = leaky.events.find((e) => e.type === 'ready')
  check(
    !ready3?.skills?.some((s) => s.name === 'leaky'),
    'credential-skill-rejected',
    JSON.stringify(ready3?.skills ?? [])
  )

  // 7. 关闭自动触发:仍安装、可显示,但从索引移除且拒绝加载
  await rm(join(skillsDir, 'leaky'), { recursive: true, force: true })
  await mkdir(join(skillsDir, 'demo-skill'), { recursive: true })
  await writeFile(
    join(skillsDir, 'demo-skill', 'SKILL.md'),
    [
      '---',
      'name: demo-skill',
      'description: 只读演示技能,用于验收工具收窄',
      'allowed-tools: read_file, glob',
      '---',
      '',
      '# Demo Skill',
      '这是技能正文标记 DEMO-BODY-MARKER。'
    ].join('\n'),
    'utf8'
  )

  const wb = join(base, 'ws')
  const off = await runCommands(
    { workspace: wb, skillsDir, text: '', mode: 'craft' },
    [
      { cmd: 'skills.setEnabled', name: 'demo-skill', enabled: false },
      { cmd: 'skills.list' },
      { text: '必须加载这个技能', mode: 'craft', skill: 'demo-skill' }
    ]
  )
  const disabledList = off.events.filter((e) => e.type === 'skills.list').at(-1)
  const listedSkill = disabledList?.skills?.find((s) => s.name === 'demo-skill')
  check(listedSkill?.enabled === false, 'disabled-skill-stays-listed', JSON.stringify(disabledList?.skills ?? []))
  const refused = off.events.find((e) => e.type === 'error' && e.code === 'CONTEXT_FAILED')
  check(
    refused && String(refused.message).includes('已关闭自动触发'),
    'disabled-skill-load-refused',
    JSON.stringify(off.events.filter((e) => e.type === 'error'))
  )
  const activatedAfterOff = off.events.find((e) => e.type === 'skill.activated')
  check(!activatedAfterOff, 'disabled-skill-not-activated', JSON.stringify(activatedAfterOff ?? null))

  const restarted = await runCommands(
    { workspace: wb, skillsDir, text: '', mode: 'craft' },
    [{ cmd: 'skills.list' }, { text: 'x', mode: 'craft' }]
  )
  const listAfterRestart = restarted.events.filter((e) => e.type === 'skills.list').at(-1)
  check(
    listAfterRestart?.skills?.find((s) => s.name === 'demo-skill')?.enabled === false,
    'disabled-state-survives-restart',
    JSON.stringify(listAfterRestart?.skills ?? [])
  )
  const readyAfterRestart = restarted.events.find((e) => e.type === 'ready')
  check(
    !readyAfterRestart?.skills?.some((s) => s.name === 'demo-skill'),
    'disabled-skill-excluded-from-ready-index',
    JSON.stringify(readyAfterRestart?.skills ?? [])
  )

  const on = await runCommands(
    { workspace: wb, skillsDir, text: '', mode: 'craft' },
    [
      { cmd: 'skills.setEnabled', name: 'demo-skill', enabled: true },
      { cmd: 'skills.list' },
      { text: '加载 demo-skill', mode: 'craft', skill: 'demo-skill' }
    ]
  )
  const reenabled = on.events.filter((e) => e.type === 'skills.list').at(-1)
  check(
    reenabled?.skills?.find((s) => s.name === 'demo-skill')?.enabled === true,
    'skill-can-be-reenabled',
    JSON.stringify(reenabled?.skills ?? [])
  )
  const reActivated = on.events.find((e) => e.type === 'skill.activated')
  check(reActivated?.name === 'demo-skill', 'reenabled-skill-loads-again', JSON.stringify(reActivated ?? null))
} finally {
  await rm(base, { recursive: true, force: true })
}

process.exit(failed === 0 ? 0 : 1)

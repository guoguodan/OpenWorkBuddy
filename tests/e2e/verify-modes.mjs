/**
 * P2 验收脚本:对每个模式跑一遍 daemon(离线 mock),核对工具可见面。
 * 用法: node tests/e2e/verify-modes.mjs
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const entry = resolve(root, 'apps/daemon/dist/index.js')

const expected = {
  craft: ['glob', 'grep', 'present_files', 'read_file', 'shell', 'write_file'],
  plan: ['glob', 'grep', 'present_files', 'read_file'],
  ask: ['glob', 'grep', 'read_file'],
  expert: ['glob', 'grep', 'present_files', 'read_file'],
  quick: []
}

function run(mode) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: { ...process.env, OPENWB_MOCK: '1', OPENWB_WORKSPACE: root },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (b) => { out += String(b) })
    child.stderr.on('data', (b) => { err += String(b) })
    child.on('error', rej)
    child.on('close', (code) => {
      const events = out.split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l) } catch { return { type: 'PARSE_ERROR', raw: l } }
      })
      res({ code, events, err })
    })
    child.stdin.end(JSON.stringify({ text: '只读 package.json 并告诉我依赖数量', mode }) + '\n')
  })
}

let failed = 0
for (const [mode, want] of Object.entries(expected)) {
  const { code, events, err } = await run(mode)
  const avail = events.find((e) => e.type === 'tools.available')
  const got = avail ? [...avail.names].sort() : null
  const modeEvent = events.find((e) => e.type === 'mode.selected')
  const errors = events.filter((e) => e.type === 'error')
  const readStarted = events.some((e) => e.type === 'tool.started' && e.name === 'read_file')
  const ok = code === 0 && JSON.stringify(got) === JSON.stringify(want) && modeEvent?.modeId === mode
    && errors.length === 0 && (want.includes('read_file') === readStarted)
  if (!ok) {
    failed++
    console.log(`FAIL ${mode}`)
    console.log(`  exit=${code} mode=${modeEvent?.modeId} tools=${JSON.stringify(got)} readStarted=${readStarted}`)
    if (errors.length) console.log(`  errors=${JSON.stringify(errors)}`)
    if (err.trim()) console.log(`  stderr=${err.trim().slice(0, 400)}`)
  } else {
    console.log(`PASS ${mode} tools=[${got.join(', ')}] readStarted=${readStarted}`)
  }
}

process.exit(failed === 0 ? 0 : 1)
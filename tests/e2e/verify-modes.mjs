/**
 * P2 验收脚本:对每个模式跑一遍 daemon(离线 mock),核对工具可见面。
 * 用法: node tests/e2e/verify-modes.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

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

const base = await mkdtemp(join(tmpdir(), 'owb-modes-e2e-'))

function run(mode, index) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: {
        ...process.env,
        OPENWB_MOCK: '1',
        OPENWB_WORKSPACE: join(base, `ws-${index}`),
        OPENWB_DATA_DIR: join(base, `data-${index}`),
        OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
        OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts')
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const chunks = []
    let err = ''
    child.stdout.on('data', (b) => { chunks.push(b) })
    child.stderr.on('data', (b) => { err += String(b) })
    child.on('error', rej)
    child.on('close', (code) => {
      res({ code, events: decodeFrames(Buffer.concat(chunks)), err })
    })
    child.stdin.end(encodeFrame({ text: '只读 package.json 并告诉我依赖数量', mode }))
  })
}

let failed = 0
let index = 0
for (const [mode, want] of Object.entries(expected)) {
  const { code, events, err } = await run(mode, index++)
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

await rm(base, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
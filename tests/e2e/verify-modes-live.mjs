/**
 * P2 真实模型验收:同一诉求在 ask / craft 两种模式下的行为差异。
 * 用法: node tests/e2e/verify-modes-live.mjs
 * 需要 OpenWorkBuddy/.env 中配置 OPENAI_API_KEY / OPENAI_BASE_URL / OPENWB_MODEL
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const entry = resolve(root, 'apps/daemon/dist/index.js')

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

function runDaemon({ mode, workspace, dataDir, text }) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: {
        ...process.env,
        OPENWB_WORKSPACE: workspace,
        OPENWB_DATA_DIR: dataDir,
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
    child.on('close', (code) => res({ code, events: decodeFrames(Buffer.concat(chunks)), err }))
    child.stdin.end(encodeFrame({ text, mode }))
  })
}

let failed = 0
const check = (ok, label, detail = '') => {
  if (ok) console.log(`PASS ${label}`)
  else { failed++; console.log(`FAIL ${label} ${detail}`) }
}

const base = await mkdtemp(join(tmpdir(), 'owb-live-'))
try {
  const task = '请把字符串 "hello-openwb" 写入 notes/hello.txt,然后只回复"完成1"。'
  const results = {}

  for (const mode of ['ask', 'craft']) {
    const ws = join(base, mode)
    await mkdir(ws, { recursive: true })
    await writeFile(join(ws, 'README.md'), '# live test workspace\n', 'utf8')

    const { code, events, err } = await runDaemon({
      mode,
      workspace: ws,
      dataDir: join(base, `data-${mode}`),
      text: task
    })
    const avail = events.find((e) => e.type === 'tools.available')
    const textOut = events.filter((e) => e.type === 'delta').map((e) => e.text).join('')
    const errors = events.filter((e) => e.type === 'error')
    let written = false
    try {
      written = (await readFile(join(ws, 'notes/hello.txt'), 'utf8')).includes('hello-openwb')
    } catch { written = false }

    results[mode] = { code, tools: avail?.names ?? [], textOut, errors, written }
    console.log(`--- ${mode} ---`)
    console.log(`tools=[${results[mode].tools.join(', ')}] written=${written} errors=${errors.length}`)
    console.log(`reply=${textOut.replace(/\s+/g, ' ').slice(0, 220)}`)
    if (errors.length) console.log(`error=${JSON.stringify(errors).slice(0, 300)}`)
    if (err.trim()) console.log(`stderr=${err.trim().split('\n').filter((l) => !l.startsWith('[trace]')).join(' | ').slice(0, 300)}`)
  }

  check(!results.ask.tools.includes('write_file'), 'ask-has-no-write-tool')
  check(results.ask.written === false, 'ask-did-not-write')
  check(results.craft.tools.includes('write_file'), 'craft-has-write-tool')
  check(results.craft.written === true, 'craft-wrote-file')
  check(results.ask.code === 0 && results.craft.code === 0, 'both-exit-zero')
} finally {
  await rm(base, { recursive: true, force: true })
}

process.exit(failed === 0 ? 0 : 1)
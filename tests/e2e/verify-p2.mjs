/**
 * P2 验收:提示词稳定性 + 策略写错时启动失败。
 * 用法: node tests/e2e/verify-p2.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, cp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const entry = resolve(root, 'apps/daemon/dist/index.js')

const base = await mkdtemp(join(tmpdir(), 'owb-p2-'))
const workspace = join(base, 'ws')
await mkdir(workspace, { recursive: true })
const traceDir = join(workspace, '.openwb/traces')

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

function runDaemon({ mode, modesDir, dataDir }) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: {
        ...process.env,
        OPENWB_MOCK: '1',
        OPENWB_WORKSPACE: workspace,
        OPENWB_DATA_DIR: dataDir ?? join(base, 'data'),
        OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts'),
        OPENWB_MODES_DIR: modesDir ?? resolve(root, 'resources/modes')
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const chunks = []
    let err = ''
    child.stdout.on('data', (b) => { chunks.push(b) })
    child.stderr.on('data', (b) => { err += String(b) })
    child.on('error', rej)
    child.on('close', (code) => res({ code, events: decodeFrames(Buffer.concat(chunks)), err }))
    if (mode) child.stdin.end(encodeFrame({ text: '稳定性检查', mode }))
    else child.stdin.end()
  })
}

async function latestTrace(mode) {
  const files = (await readdir(traceDir)).filter((f) => f.startsWith(`prompt-${mode}-`))
  files.sort()
  const last = files.at(-1)
  return JSON.parse(await readFile(join(traceDir, last), 'utf8'))
}

let failed = 0
const check = (ok, label, detail = '') => {
  if (ok) console.log(`PASS ${label}`)
  else { failed++; console.log(`FAIL ${label} ${detail}`) }
}

// 1) 同一输入两次组装,sha256 必须一致
await runDaemon({ mode: 'craft' })
const a = await latestTrace('craft')
await new Promise((r) => setTimeout(r, 12))
await runDaemon({ mode: 'craft' })
const b = await latestTrace('craft')
check(a.outputSha256 === b.outputSha256, 'assembler-stable', `${a.outputSha256} vs ${b.outputSha256}`)

// 2) 策略字段写错 -> 启动失败并指出文件与字段
const broken = await mkdtemp(join(tmpdir(), 'owb-modes-'))
try {
  await cp(resolve(root, 'resources/modes'), broken, { recursive: true })
  const target = join(broken, 'ask.yaml')
  const yaml = await readFile(target, 'utf8')
  await writeFile(target, yaml.replace('toolPolicy:\n  allow:', 'toolPolicy:\n  allowz:'), 'utf8')

  const { code, err } = await runDaemon({ mode: 'craft', modesDir: broken })
  check(code === 2, 'broken-policy-exit-code', `code=${code}`)
  check(err.includes('ask.yaml'), 'broken-policy-names-file', err.trim().slice(0, 160))
  check(/toolPolicy|allow/.test(err), 'broken-policy-names-field', err.trim().slice(0, 160))
} finally {
  await rm(broken, { recursive: true, force: true })
}

await rm(base, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
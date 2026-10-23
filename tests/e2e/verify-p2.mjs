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
const traceDir = resolve(root, '.openwb/traces')

function runDaemon({ mode, modesDir }) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: {
        ...process.env,
        OPENWB_MOCK: '1',
        OPENWB_WORKSPACE: root,
        ...(modesDir ? { OPENWB_MODES_DIR: modesDir } : {})
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (b) => { out += String(b) })
    child.stderr.on('data', (b) => { err += String(b) })
    child.on('error', rej)
    child.on('close', (code) => res({ code, out, err }))
    if (mode) child.stdin.end(JSON.stringify({ text: '稳定性检查', mode }) + '\n')
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

  const { code, err } = await runDaemon({ modesDir: broken })
  check(code === 2, 'broken-policy-exit-code', `code=${code}`)
  check(err.includes('ask.yaml'), 'broken-policy-names-file', err.trim().slice(0, 160))
  check(/toolPolicy|allow/.test(err), 'broken-policy-names-field', err.trim().slice(0, 160))
} finally {
  await rm(broken, { recursive: true, force: true })
}

process.exit(failed === 0 ? 0 : 1)
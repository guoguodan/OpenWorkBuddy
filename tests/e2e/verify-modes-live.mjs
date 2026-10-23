/**
 * P2 真实模型验收:同一诉求在 ask / craft 两种模式下的行为差异。
 * 用法: node tests/e2e/verify-modes-live.mjs
 * 需要 OpenWorkBuddy/.env 中配置 OPENAI_API_KEY / OPENAI_BASE_URL / OPENWB_MODEL
 */
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const entry = resolve(root, 'apps/daemon/dist/index.js')

function runDaemon({ mode, workspace, text }) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: {
        ...process.env,
        OPENWB_WORKSPACE: workspace,
        OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
        OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts')
      },
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
    child.stdin.end(JSON.stringify({ text, mode }) + '\n')
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

    const { code, events, err } = await runDaemon({ mode, workspace: ws, text: task })
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
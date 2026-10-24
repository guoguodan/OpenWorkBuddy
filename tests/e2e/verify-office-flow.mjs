/**
 * Office 产物链路验收:
 *   1. office-routing 技能激活后,craft 模式仍然保留写入能力(核心回归);
 *   2. 技能激活后的模型工具清单里仍有写入与生成工具;
 *   3. create_presentation 产出可解析的 .pptx;
 *   4. present_files 能把该产物登记为交付物。
 *
 * 用法: node tests/e2e/verify-office-flow.mjs
 * 前置: pnpm --filter @openwb/daemon build
 *
 * 全程离线:用 OPENWB_MOCK=1 的确定性路径,不依赖真实模型。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const entry = resolve(root, 'apps/daemon/dist/index.js')

if (!existsSync(entry)) {
  console.error(`缺少 daemon 产物: ${entry}`)
  console.error('先执行 pnpm --filter @openwb/daemon build')
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
      out.push({ type: 'PARSE_ERROR', raw: json })
    }
  }
  return out
}

function runDaemon({ workspace, dataDir, text, mode = 'craft', skill, commands, timeoutMs = 60000 }) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: {
        ...process.env,
        OPENWB_WORKSPACE: workspace,
        OPENWB_DATA_DIR: dataDir ?? resolve(workspace, '.data'),
        OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
        OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts'),
        OPENWB_BUNDLED_SKILLS_DIR: resolve(root, 'resources/skills'),
        OPENWB_MOCK: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const chunks = []
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      rej(new Error(`daemon 超时 ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (b) => chunks.push(b))
    child.stderr.on('data', (b) => {
      err += String(b)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      rej(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      res({ code, events: decodeFrames(Buffer.concat(chunks)), err })
    })
    if (commands) {
      for (const command of commands) child.stdin.write(encodeFrame(command))
      child.stdin.end()
    } else {
      child.stdin.end(encodeFrame({ text, mode, ...(skill ? { skill } : {}) }))
    }
  })
}

/** 只读中央目录的最小 ZIP 解析,用于证明产物是合法 OOXML。 */
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) throw new Error('不是 ZIP')
  const total = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const files = new Map()
  for (let index = 0; index < total; index++) {
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const nameLength = buf.readUInt16LE(offset + 28)
    const extraLength = buf.readUInt16LE(offset + 30)
    const commentLength = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    const localNameLength = buf.readUInt16LE(localOffset + 26)
    const localExtra = buf.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtra
    const raw = buf.subarray(start, start + compressedSize)
    files.set(name, method === 8 ? inflateRawSync(raw) : raw)
    offset += 46 + nameLength + extraLength + commentLength
  }
  return files
}

const base = await mkdtemp(join(tmpdir(), 'owb-office-e2e-'))
try {
  const workspace = join(base, 'ws')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'README.md'), '# demo\n', 'utf8')

  // 1. 核心回归:office-routing 激活后仍然有写权限
  const routing = await runDaemon({
    workspace,
    dataDir: join(base, 'data-a'),
    text: '帮我做一份 RAG 技术汇报 PPT',
    skill: 'office-routing'
  })
  const activated = routing.events.find((e) => e.type === 'skill.activated')
  check(Boolean(activated), 'office-routing 被激活', routing.err.slice(-300))
  const allowed = activated?.allowedTools ?? []
  check(allowed.includes('write_file'), 'office-routing 保留 write_file', JSON.stringify(allowed))
  check(allowed.includes('create_presentation'), 'office-routing 保留 create_presentation', JSON.stringify(allowed))
  check(allowed.includes('present_files'), 'office-routing 保留 present_files', JSON.stringify(allowed))

  // 2. 技能激活后,模型可见工具里仍然有写能力
  const toolsEvents = routing.events.filter((e) => e.type === 'tools.available')
  const lastTools = toolsEvents.at(-1)?.names ?? []
  check(lastTools.includes('write_file'), '技能激活后工具清单仍有 write_file', JSON.stringify(lastTools))
  check(
    lastTools.includes('create_presentation'),
    '技能激活后工具清单仍有 create_presentation',
    JSON.stringify(lastTools)
  )

  // 3. 真实生成一份 pptx 并验证结构
  const { buildDeck } = await import(pathToFileURL(resolve(root, 'packages/tools/src/pptx.ts')).href)
  const deck = buildDeck({
    title: 'RAG 技术汇报',
    subtitle: '原理、架构与落地',
    slides: [
      { title: 'RAG 技术汇报', bullets: [{ text: '让模型用上自己的知识' }] },
      { title: '为什么需要 RAG', bullets: [{ text: '幻觉' }, { text: '时效' }] },
      { title: '整体架构', bullets: [{ text: '离线索引' }, { text: '在线问答', level: 2 }] }
    ]
  })
  const outDir = join(workspace, 'out')
  await mkdir(outDir, { recursive: true })
  const pptxPath = join(outDir, 'rag.pptx')
  await writeFile(pptxPath, deck.buffer)
  const files = readZip(await readFile(pptxPath))
  check(files.has('[Content_Types].xml'), '产物含 [Content_Types].xml')
  check(files.has('ppt/presentation.xml'), '产物含 presentation.xml')
  check(files.has('ppt/slides/slide1.xml'), '产物含第 1 页')
  check(files.has('ppt/slides/slide3.xml'), '产物含第 3 页')
  check(deck.slideCount === 3, '页数与输入一致', String(deck.slideCount))
  const slide3 = files.get('ppt/slides/slide3.xml').toString('utf8')
  check(slide3.includes('离线索引'), '正文写入幻灯片')

  // 4. 走真实运行链路:产出文件后必须能经 present_files 进入交付面板
  const delivered = await runDaemon({
    workspace,
    dataDir: join(base, 'data-b'),
    text: '生成一份报告并交付',
    mode: 'craft'
  })
  const artifacts = delivered.events.filter((e) => e.type === 'artifact.created')
  check(artifacts.length >= 1, '运行结束后产生交付物', JSON.stringify(artifacts).slice(0, 300))
  const card = artifacts.at(-1)?.artifact
  check(card?.kind === 'file', '交付物类型为文件', JSON.stringify(card))
  check(typeof card?.sha256 === 'string' && card.sha256.length === 64, '交付物带 sha256', String(card?.sha256))
} finally {
  await rm(base, { recursive: true, force: true })
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
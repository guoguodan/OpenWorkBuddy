/**
 * Office / PDF 应用内预览验收。
 *
 * 覆盖:
 *   - docx/xlsx/pptx 由主进程提取为受限 HTML,在沙箱 iframe 中展示;
 *   - PDF 由 PDF.js 在应用内分页绘制,不启动系统程序;
 *   - 预览仍提供"用系统程序打开"入口;
 *   - 文档路径必须位于工作区内。
 *
 * 用法: node tests/e2e/verify-office-pdf-preview.mjs
 * 前置: pnpm --filter @openwb/daemon build && pnpm --filter @openwb/desktop build
 *
 * 全程离线。测试直接向临时数据库写入交付物记录,文件内容用最小 OOXML / PDF
 * 构造,避免依赖本机 Office 或在线文档。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const electron = resolve(root, 'apps/desktop/node_modules/electron/dist/electron.exe')
const daemonEntry = resolve(root, 'apps/daemon/dist/index.js')
const require = createRequire(resolve(root, 'apps/daemon/package.json'))
const Database = require('better-sqlite3')
const port = 9351
const endpoint = `http://127.0.0.1:${port}/json/list`

if (!existsSync(electron) || !existsSync(daemonEntry)) {
  console.error('缺少 Electron 或 daemon 产物,先执行 pnpm build')
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

/** 生成最小 ZIP(method=0),只用于测试 OOXML 解析。 */
function buildZip(entries) {
  const localParts = []
  const centralParts = []
  let localOffset = 0
  for (const item of entries) {
    const name = Buffer.from(item.name, 'utf8')
    const data = Buffer.from(item.data, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, name)
    localOffset += 30 + name.length + data.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDirectory.length, 12)
  eocd.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localParts, centralDirectory, eocd])
}

function makeDocx() {
  return buildZip([
    {
      name: 'word/document.xml',
      data:
        '<w:document xmlns:w="urn:test"><w:body>' +
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>季度报告验收</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Office 预览正文</w:t></w:r></w:p>' +
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc>' +
        '<w:tc><w:p><w:r><w:t>数量</w:t></w:r></w:p></w:tc></w:tr>' +
        '<w:tr><w:tc><w:p><w:r><w:t>设备</w:t></w:r></w:p></w:tc>' +
        '<w:tc><w:p><w:r><w:t>120</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
        '</w:body></w:document>'
    }
  ])
}

function makeXlsx() {
  return buildZip([
    {
      name: 'xl/workbook.xml',
      data: '<workbook xmlns:r="urn:r"><sheets><sheet name="汇总" sheetId="1" r:id="rId1"/></sheets></workbook>'
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'
    },
    { name: 'xl/sharedStrings.xml', data: '<sst><si><t>名称</t></si><si><t>金额</t></si></sst>' },
    {
      name: 'xl/worksheets/sheet1.xml',
      data:
        '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="inlineStr"><is><t>设备</t></is></c><c r="B2"><v>120</v></c></row>' +
        '</sheetData></worksheet>'
    }
  ])
}

function makePptx() {
  return buildZip([
    {
      name: 'ppt/presentation.xml',
      data: '<presentation xmlns:r="urn:r"><sldIdLst><sldId id="256" r:id="rId1"/></sldIdLst></presentation>'
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data: '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>'
    },
    {
      name: 'ppt/slides/slide1.xml',
      data: '<sld><cSld><spTree><sp><txBody><p><r><t>季度回顾幻灯片</t></r></p></txBody></sp></spTree></cSld></sld>'
    }
  ])
}

/** 单页 PDF,内容为一段 ASCII 文本;不依赖第三方库。 */
function makePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
      + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  const stream = 'BT /F1 24 Tf 72 700 Td (PDF Preview Acceptance) Tj ET'
  objects[3] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  let body = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((content, index) => {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${content}\nendobj\n`
  })
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'ascii')
}

async function waitForPage(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await (await fetch(endpoint)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch {}
    await sleep(300)
  }
  throw new Error('Electron 页面未在 30s 内就绪')
}

function connect(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const waiting = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && waiting.has(m.id)) {
        waiting.get(m.id)(m)
        waiting.delete(m.id)
      }
    })
    const timer = setTimeout(() => rej(new Error('CDP WebSocket 连接超时')), 10000)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      const send = (method, params = {}, timeoutMs = 15000) =>
        new Promise((resolveCall, rejectCall) => {
          const myId = ++id
          const t = setTimeout(() => {
            waiting.delete(myId)
            rejectCall(new Error(`CDP ${method} 超时 ${timeoutMs}ms`))
          }, timeoutMs)
          waiting.set(myId, (m) => {
            clearTimeout(t)
            resolveCall(m)
          })
          ws.send(JSON.stringify({ id: myId, method, params }))
        })
      const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
        if (r.result?.exceptionDetails) {
          throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)
        }
        return r.result?.result?.value
      }
      res({ ws, send, evaluate })
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      rej(new Error('CDP WebSocket 连接失败'))
    })
  })
}

async function waitFor(evaluate, expression, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      if (await evaluate(expression)) return true
    } catch {
      await sleep(100)
    }
    await sleep(150)
  }
  return false
}

const base = await mkdtemp(join(tmpdir(), 'owb-office-preview-'))
const workdir = join(base, 'ws')
const dataDir = join(base, 'data')
const userData = join(base, 'electron')
await mkdir(workdir, { recursive: true })
await mkdir(dataDir, { recursive: true })
await mkdir(userData, { recursive: true })
await writeFile(join(workdir, 'package.json'), '{"name":"office-preview-ws"}\n', 'utf8')
await writeFile(join(workdir, 'quarter.docx'), makeDocx())
await writeFile(join(workdir, 'quarter.xlsx'), makeXlsx())
await writeFile(join(workdir, 'quarter.pptx'), makePptx())
await writeFile(join(workdir, 'quarter.pdf'), makePdf())

const app = spawn(
  electron,
  [
    resolve(root, 'apps/desktop'),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userData}`
  ],
  {
    cwd: workdir,
    env: {
      ...process.env,
      OPENWB_DAEMON_ENTRY: daemonEntry,
      OPENWB_WORKSPACE: workdir,
      OPENWB_DATA_DIR: dataDir,
      OPENWB_MOCK: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  }
)
let appStderr = ''
app.stderr?.on('data', (chunk) => {
  appStderr += String(chunk)
})

let client
try {
  const page = await waitForPage()
  client = await connect(page.webSocketDebuggerUrl)
  const { evaluate, send } = client

  check(
    await waitFor(evaluate, `Boolean(document.querySelector('textarea[data-testid="composer-input"]'))`),
    '界面就绪'
  )

  // 等 daemon 完成迁移并建立默认会话。
  const dbPath = join(dataDir, 'openwb.db')
  let conversationId = ''
  for (let i = 0; i < 100 && !conversationId; i++) {
    try {
      const db = new Database(dbPath, { readonly: true })
      const row = db.prepare('SELECT id FROM conversation ORDER BY updated_at DESC LIMIT 1').get()
      db.close()
      conversationId = row?.id ?? ''
    } catch {}
    if (!conversationId) await sleep(150)
  }
  if (!conversationId) throw new Error(`默认会话未创建\n${appStderr}`)

  const now = new Date().toISOString()
  const db = new Database(dbPath)
  db.pragma('busy_timeout = 5000')
  // 顶部交付物入口只在会话已有消息时渲染;补一条助手消息代表本轮产出。
  db.prepare(
    'INSERT INTO message (id, conversation_id, seq, role, content_json, status, token_in, token_out, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'office-preview-message',
    conversationId,
    1,
    'assistant',
    JSON.stringify({ text: '已生成 Office 与 PDF 验收文件。' }),
    'done',
    0,
    0,
    now
  )
  const insert = db.prepare(
    'INSERT INTO artifact (id, conversation_id, kind, title, path, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  const items = [
    ['docx-preview', 'Quarter Word', 'quarter.docx'],
    ['xlsx-preview', 'Quarter Excel', 'quarter.xlsx'],
    ['pptx-preview', 'Quarter Slides', 'quarter.pptx'],
    ['pdf-preview', 'Quarter PDF', 'quarter.pdf']
  ]
  for (const [id, title, name] of items) {
    insert.run(id, conversationId, 'file', title, name, 0, now)
  }
  db.close()

  await send('Page.reload', {}, 15000).catch(() => undefined)
  await sleep(700)
  check(
    await waitFor(evaluate, `document.querySelector('[data-testid="artifact-panel-trigger"]')?.textContent?.includes('4')`, 25000),
    '刷新后看到 4 个交付物'
  )
  await evaluate(`document.querySelector('[data-testid="artifact-panel-trigger"]')?.click()`)
  check(
    await waitFor(evaluate, `document.querySelectorAll('[data-testid="artifact-row"]').length === 4`),
    '交付物面板列出 Office 与 PDF'
  )

  const openRow = async (title) => {
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('[data-testid="artifact-row"]')]
        .find((el) => el.textContent?.includes(${JSON.stringify(title)}))
      row?.querySelector('[data-testid="artifact-open"]')?.click()
      return Boolean(row)
    })()`)
  }
  const closePreview = async () => {
    await evaluate(`document.querySelector('[data-testid="artifact-preview-close"]')?.click()`)
    await waitFor(evaluate, `!document.querySelector('[data-testid="artifact-preview"]')`)
  }

  const officeCases = [
    ['Quarter Word', 'artifact-preview-office', ['季度报告验收', 'Office 预览正文', '设备', '120']],
    ['Quarter Excel', 'artifact-preview-office', ['汇总', '名称', '金额', '设备', '120']],
    ['Quarter Slides', 'artifact-preview-office', ['第 1 页', '季度回顾幻灯片']]
  ]
  for (const [title, testId, expected] of officeCases) {
    await openRow(title)
    check(
      await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="${testId}"]'))`, 15000),
      `${title} 在应用内打开`
    )
    const srcdoc = await evaluate(
      `document.querySelector('[data-testid="${testId}"]')?.getAttribute('srcdoc') ?? ''`
    )
    check(
      expected.every((text) => srcdoc.includes(text)),
      `${title} 提取出正文`,
      srcdoc.slice(0, 180)
    )
    check(
      await evaluate(`document.querySelector('[data-testid="${testId}"]')?.getAttribute('sandbox') === ''`),
      `${title} 使用禁用脚本的沙箱 iframe`
    )
    check(
      await evaluate(`Boolean(document.querySelector('[data-testid="artifact-preview-external"]'))`),
      `${title} 保留系统程序打开入口`
    )
    await closePreview()
  }

  await openRow('Quarter PDF')
  check(
    await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="artifact-preview-pdf"]'))`, 15000),
    'PDF 在应用内打开'
  )
  check(
    await waitFor(evaluate, `document.querySelector('[data-testid="artifact-preview-pdf-count"]')?.textContent?.includes('1 页')`, 20000),
    'PDF 显示页数'
  )
  check(
    await waitFor(evaluate, `document.querySelectorAll('[data-testid="artifact-preview-pdf-page"]').length === 1`, 20000),
    'PDF 页面绘制到 canvas'
  )
  check(
    await evaluate(`document.querySelector('[data-testid="artifact-preview-pdf-page"]')?.width > 0`),
    'PDF canvas 具有有效尺寸'
  )
  check(
    await evaluate(`Boolean(document.querySelector('[data-testid="artifact-preview-external"]'))`),
    'PDF 保留系统程序打开入口'
  )
  check(
    await evaluate(
      `window.openwb.artifact.document({ path: '../outside.docx' }).then(() => false, (e) => String(e).includes('路径越界'))`
    ),
    '拒绝工作区外的文档路径'
  )
} finally {
  try {
    client?.ws.close()
  } catch {}
  app.kill()
  await Promise.race([new Promise((r) => app.on('exit', r)), sleep(3000)])
  if (failed > 0 && appStderr.trim()) {
    console.log(`--- app stderr ---\n${appStderr.trim().split('\n').slice(-15).join('\n')}`)
  }
  await rm(base, { recursive: true, force: true }).catch(() => undefined)
}

process.exit(failed === 0 ? 0 : 1)

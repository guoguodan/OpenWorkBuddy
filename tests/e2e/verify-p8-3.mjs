/**
 * P8-3 打包发布验收。
 * 用法: node tests/e2e/verify-p8-3.mjs
 * 前置: pnpm --filter @openwb/desktop build
 *       node scripts/stage-daemon.mjs
 *       pnpm --filter @openwb/desktop exec electron-builder --win dir --x64 --publish never
 *
 * 覆盖:
 *  1. 安装包结构(app.asar / resources/daemon / 资源目录)
 *  2. app.asar 不含 node_modules,且首屏 JS gzip 在预算内
 *  3. daemon 原生模块真实存在,并由 Electron 运行时成功加载
 *  4. 打包应用真实冷启动 10 次,读取 ready 标记并核对 SQLite 建库
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const release = join(root, 'release')
const unpacked = join(release, 'win-unpacked')
const exe = join(unpacked, 'OpenWorkBuddy.exe')
const installer = join(release, 'OpenWorkBuddy-0.0.1-x64.exe')
const asarPath = join(unpacked, 'resources/app.asar')
const daemon = join(unpacked, 'resources/daemon')
const require = createRequire(resolve(root, 'apps/desktop/package.json'))

let failed = 0
const check = (ok, label, detail = '') => {
  if (ok) console.log(`PASS ${label}`)
  else {
    failed++
    console.log(`FAIL ${label}${detail ? ` :: ${detail}` : ''}`)
  }
}

const requiredPaths = [
  [exe, '安装目录存在 OpenWorkBuddy.exe'],
  [installer, '存在 NSIS 安装包'],
  [asarPath, '存在 app.asar'],
  [join(daemon, 'dist/index.js'), '存在 daemon 入口'],
  [join(daemon, 'node_modules/yaml/package.json'), '存在 daemon 运行依赖 yaml'],
  [join(unpacked, 'resources/resources/modes'), '存在 modes 资源'],
  [join(unpacked, 'resources/resources/prompts'), '存在 prompts 资源'],
  [join(unpacked, 'resources/resources/skills'), '存在 skills 资源'],
  [join(unpacked, 'resources/resources/workflows'), '存在 workflows 资源']
]
for (const [path, label] of requiredPaths) check(existsSync(path), label, path)
if (failed > 0) {
  console.error('缺少打包产物,先执行构建与 electron-builder')
  process.exit(1)
}

// ── 0. 安装包体积 ───────────────────────────────────────────────────────
const installerBytes = (await stat(installer)).size
check(installerBytes <= 120 * 1024 * 1024, '安装包 ≤ 120MB', `${(installerBytes / 1024 / 1024).toFixed(2)}MB`)

// ── 1. asar 体积与内容 ───────────────────────────────────────────────────
const asarBytes = (await stat(asarPath)).size
check(asarBytes < 10 * 1024 * 1024, 'app.asar ≤ 10MB(未误打包依赖树)', `${(asarBytes / 1024 / 1024).toFixed(2)}MB`)

// 从 desktop 的依赖解析,避免把 pnpm store 内的版本号写死。
let asarModule = ''
try {
  asarModule = require.resolve('@electron/asar')
} catch {
  const storeDir = join(root, 'node_modules/.pnpm')
  const asarDir = existsSync(storeDir)
    ? (await readdir(storeDir)).filter((n) => n.startsWith('@electron+asar@')).sort().at(-1)
    : undefined
  if (asarDir) asarModule = join(storeDir, asarDir, 'node_modules/@electron/asar/lib/asar.js')
}
if (!asarModule || !existsSync(asarModule)) {
  console.error('缺少 @electron/asar,无法校验 asar 内容')
  process.exit(1)
}
const { listPackage } = require(asarModule)
const entries = listPackage(asarPath).map((p) => p.replace(/\\/g, '/'))
check(!entries.some((p) => p.startsWith('/node_modules/')), 'app.asar 不含 node_modules')
for (const required of ['/out/main/index.js', '/out/preload/index.js', '/out/renderer/index.html']) {
  check(entries.includes(required), `app.asar 含 ${required.slice(1)}`)
}

// ── 2. 首屏 JS gzip 预算 ─────────────────────────────────────────────────
const rendererAssets = join(root, 'apps/desktop/out/renderer/assets')
const jsAssets = (await readdir(rendererAssets)).filter((n) => n.endsWith('.js'))
let worst = { name: '', gzip: 0 }
for (const name of jsAssets) {
  const gzip = gzipSync(await readFile(join(rendererAssets, name))).length
  if (gzip > worst.gzip) worst = { name, gzip }
}
check(jsAssets.length > 0, '找到首屏 JS 产物')
check(worst.gzip > 0 && worst.gzip <= 1.5 * 1024 * 1024, '首屏 JS gzip ≤ 1.5MB', `${(worst.gzip / 1024).toFixed(1)}KB ${worst.name}`)

// ── 3. 原生模块真实存在 ─────────────────────────────────────────────────
const prebuildDir = join(daemon, 'node_modules/better-sqlite3/prebuilds')
const prebuilds = existsSync(prebuildDir) ? await readdir(prebuildDir) : []
const expected = `win32-${process.arch}.node`
check(prebuilds.includes(expected), `含当前架构原生模块 ${expected}`, prebuilds.join(','))
check(prebuilds.every((n) => n === expected || !n.startsWith('win32-')), '未携带其他 Windows 架构预编译', prebuilds.join(','))

const electronExe = join(root, 'apps/desktop/node_modules/electron/dist/electron.exe')
const abi = spawn(
  electronExe,
  ['-e', "const Database=require('better-sqlite3');const d=new Database(':memory:');d.close();console.log('native-ok')"],
  {
    cwd: daemon,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  }
)
let abiOut = ''
abi.stdout.on('data', (b) => (abiOut += b.toString()))
abi.stderr.on('data', (b) => (abiOut += b.toString()))
const abiCode = await new Promise((r) => abi.on('exit', r))
check(abiCode === 0 && abiOut.includes('native-ok'), 'Electron 运行时能加载 SQLite 原生模块', abiOut.trim())

// ── 4. 冷启动 10 次 ─────────────────────────────────────────────────────
const base = await mkdtemp(join(tmpdir(), 'owb-p8-3-'))
const samples = []
let readyOk = 0
let dbOk = 0
let lastError = ''
for (let i = 0; i < 10; i++) {
  const runDir = join(base, `run-${i}`)
  const readyFile = join(runDir, 'ready.json')
  await mkdir(runDir, { recursive: true })
  const started = Date.now()
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      OPENWB_DATA_DIR: join(runDir, 'data'),
      OPENWB_WORKSPACE: join(runDir, 'ws'),
      OPENWB_MOCK: '1',
      OPENWB_READY_FILE: readyFile,
      OPENWB_SMOKE_EXIT_MS: '600'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (b) => (stderr += b.toString()))
  let elapsed = 0
  for (let wait = 0; wait < 120; wait++) {
    if (existsSync(readyFile)) {
      elapsed = Date.now() - started
      break
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  const exited = await Promise.race([
    new Promise((r) => child.on('exit', () => r(true))),
    new Promise((r) => setTimeout(() => r(false), 8000))
  ])
  if (!exited) child.kill()
  let ready = null
  try {
    ready = JSON.parse(await readFile(readyFile, 'utf8'))
  } catch {
    lastError = stderr.trim().slice(0, 300)
  }
  if (ready?.packageMode === true) readyOk++
  if (existsSync(join(runDir, 'data/openwb.db'))) dbOk++
  if (elapsed > 0) samples.push(elapsed)
}

samples.sort((a, b) => a - b)
const p90 = samples.length > 0 ? samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.9) - 1)] : Infinity
console.log(`INFO 冷启动样本(ms): ${samples.join(',')} / P90=${p90}ms`)
check(readyOk === 10, '10 次冷启动都写入 ready', `${readyOk}/10 ${lastError}`)
check(dbOk === 10, '10 次冷启动都创建 openwb.db', `${dbOk}/10`)
check(samples.length === 10, '10 次冷启动都测到耗时', `${samples.length}/10`)
check(p90 <= 5000, '冷启动 P90 ≤ 5s', `${p90}ms (${samples.join(',')})`)

await rm(base, { recursive: true, force: true })

if (failed > 0) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\nP8-3 打包发布验收通过')

/**
 * P8-3 打包前置:把 daemon 构建产物与其运行依赖收进一个自包含目录。
 *
 * 为什么不用 pnpm deploy:
 *   deploy 产物用 junction 指向 .pnpm,复制到安装包后绝对路径失效;
 *   改用 npm 的扁平安装,得到全是真实文件的 node_modules。
 *
 * 为什么只保留更好体积而不是全量:
 *   better-sqlite3 带 C 源码与 8 个平台预编译,drizzle-orm 带全数据库方言;
 *   安装包只需要本平台、本架构、运行时会真正加载的文件。
 *
 * 用法: node scripts/stage-daemon.mjs [--no-install]
 * 输出: .pack-staging/daemon
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const staging = join(root, '.pack-staging')
const target = join(staging, 'daemon')
const skipInstall = process.argv.includes('--no-install')
const platformKey = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'

if (!existsSync(join(root, 'apps/daemon/dist/index.js'))) {
  console.error('缺少 daemon 产物,先执行: pnpm --filter @openwb/daemon build')
  process.exit(1)
}

if (!skipInstall) {
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })

  // 只声明 daemon 的外部运行依赖;@openwb/* 已由 tsup 内联进 dist。
  const daemonPkg = JSON.parse(await readFile(join(root, 'apps/daemon/package.json'), 'utf8'))
  const external = ['@ai-sdk/openai', 'ai', 'better-sqlite3', 'dotenv', 'drizzle-orm', 'rrule', 'yaml', 'zod']
  const dependencies = Object.fromEntries(
    external.map((name) => {
      const version = daemonPkg.dependencies[name]
      if (!version) throw new Error(`daemon 依赖清单缺少 ${name}`)
      return [name, version]
    })
  )
  await writeFile(
    join(target, 'package.json'),
    `${JSON.stringify({ name: 'openwb-daemon-runtime', version: daemonPkg.version, private: true, type: 'module', dependencies }, null, 2)}\n`,
    'utf8'
  )

  // Windows 上 npm 只是 .cmd 包装,Node 22 的 execFile 无法直接启动它
  // (EINVAL)。改为用当前 Node 执行 npm-cli.js,平台无关且不经过 shell。
  const npmCli = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ].find((candidate) => existsSync(candidate))
  if (!npmCli) {
    console.error('[stage] 找不到 npm-cli.js,无法生成运行时依赖')
    process.exit(1)
  }

  console.log('[stage] npm install --omit=dev ->', target)
  // npm 默认扁平安装;--ignore-scripts 避免在打包机重新编译原生模块,
  // better-sqlite3 的 N-API 预编译已随包发布,可直接被 Electron 加载。
  execFileSync(
    process.execPath,
    [npmCli, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'],
    { cwd: target, stdio: 'inherit' }
  )
}

// ── 1. 构建产物放入 dist,入口按 package.json main 声明 ────────────────────
const targetDist = join(target, 'dist')
await rm(targetDist, { recursive: true, force: true })
await cp(join(root, 'apps/daemon/dist'), targetDist, { recursive: true })
// daemon 的 sourcemap 只服务开发调试,安装包不需要。
for (const file of await readdir(targetDist)) {
  if (file.endsWith('.map')) await rm(join(targetDist, file), { force: true })
}

// 清掉上一轮可能残留的调试脚本/锁文件,staging 只允许出现运行时需要的三类内容。
for (const name of ['package-lock.json', 'abi-check.cjs']) {
  await rm(join(target, name), { force: true })
}

// ── 2. 删掉运行不需要的源码、类型与 sourcemap ─────────────────────────────
const nodeModules = join(target, 'node_modules')
await rm(join(nodeModules, '.package-lock.json'), { force: true })

// electron-builder 当前只产出当前架构的安装包,因此只带当前架构预编译。
// 多带一个架构约 1.9MB,且会让"安装包只含所需原生模块"的验收失效。
const keepPrebuild = new Set([`${platformKey}-${process.arch}.node`])
const dropFile = (name) =>
  /\.(map|md|markdown|txt)$/i.test(name) ||
  /\.d\.(ts|mts|cts)$/i.test(name) ||
  /^readme(\..*)?$/i.test(name) ||
  /^changelog(\..*)?$/i.test(name)
const dropDir = new Set(['src', 'test', 'tests', 'docs', 'doc', 'deps', 'benchmark', 'benchmarks', '.github'])

// 只删除包根目录下的源码/测试目录。
// @opentelemetry/api 等包把可执行产物放在 build/src,按名字一律删会直接损坏运行。
// 这里用"父目录里是否有 package.json"判定包根,而不是看 node_modules 前缀。
async function isPackageRoot(dir) {
  try {
    await stat(join(dir, 'package.json'))
    return true
  } catch {
    return false
  }
}

async function prune(dir) {
  const atRoot = await isPackageRoot(dir)
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (dropDir.has(entry.name) && atRoot) {
        await rm(full, { recursive: true, force: true })
        continue
      }
      // 只保留当前平台/架构的预编译;完整预编译约 16MB。
      if (entry.name === 'prebuilds') {
        const keepDir = dir.includes(`${platformKey}`) || dir.endsWith('better-sqlite3')
        if (keepDir) {
          for (const file of await readdir(full)) {
            if (file.endsWith('.node') && !keepPrebuild.has(file)) {
              await rm(join(full, file), { force: true })
            }
          }
        }
      }
      await prune(full)
    } else if (dropFile(entry.name)) {
      await rm(full, { force: true })
    }
  }
}

await prune(nodeModules)
// better-sqlite3 的 binding.gyp/build 仅编译期需要
for (const name of ['binding.gyp']) {
  await rm(join(nodeModules, 'better-sqlite3', name), { force: true })
}
await rm(join(nodeModules, 'better-sqlite3', 'build'), { recursive: true, force: true })

// ── 3. 自检:原生模块与外部依赖必须真实存在且无 junction ─────────────────
const required = [
  'dist/index.js',
  'node_modules/ai/package.json',
  'node_modules/zod/package.json',
  'node_modules/drizzle-orm/package.json',
  'node_modules/better-sqlite3/package.json',
  `node_modules/better-sqlite3/prebuilds/${platformKey}-${process.arch}.node`
]
const missing = []
for (const rel of required) {
  try {
    await stat(join(target, rel))
  } catch {
    missing.push(rel)
  }
}
if (missing.length > 0) {
  console.error(`[stage] 缺少打包必需文件:\n- ${missing.join('\n- ')}`)
  process.exit(1)
}

let bytes = 0
let files = 0
let links = 0
async function measure(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      links++
      continue
    }
    if (entry.isDirectory()) await measure(full)
    else {
      files++
      bytes += (await stat(full)).size
    }
  }
}
await measure(target)
if (links > 0) {
  console.error(`[stage] 产物包含 ${links} 个符号链接,安装包会失效`)
  process.exit(1)
}
console.log(`[stage] 完成: ${files} 个文件, ${(bytes / 1024 / 1024).toFixed(1)} MB`)

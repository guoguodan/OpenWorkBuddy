/**
 * 开发期桌面端启动器:与 e2e 使用同一套启动参数,区别只是不自动退出。
 * 用法: node scripts/dev-launch.mjs
 * 前置: pnpm --filter @openwb/daemon build && pnpm --filter @openwb/desktop build
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const electron = resolve(root, 'apps/desktop/node_modules/electron/dist/electron.exe')
const daemonEntry = resolve(root, 'apps/daemon/dist/index.js')
const port = 9334

if (!existsSync(electron)) {
  console.error(`缺少 Electron: ${electron}`)
  process.exit(1)
}
if (!existsSync(daemonEntry)) {
  console.error(`缺少 daemon 产物: ${daemonEntry}\n先执行 pnpm --filter @openwb/daemon build`)
  process.exit(1)
}

const workspace = await mkdtemp(join(tmpdir(), 'owb-dev-'))
await writeFile(join(workspace, 'README.md'), '# OpenWorkBuddy 体验工作区\n', 'utf8')

const app = spawn(electron, [resolve(root, 'apps/desktop'), `--remote-debugging-port=${port}`], {
  cwd: workspace,
  env: {
    ...process.env,
    OPENWB_DAEMON_ENTRY: daemonEntry,
    OPENWB_WORKSPACE: workspace,
    OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
    OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts')
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

app.stdout.on('data', () => {})
app.stderr.on('data', (b) => process.stderr.write(`[app] ${b}`))
app.on('exit', (code) => {
  console.log(`[launch] 窗口已关闭 (code=${code}),工作区保留在 ${workspace}`)
  process.exit(0)
})

const deadline = Date.now() + 30_000
while (Date.now() < deadline) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = list.find((t) => t.type === 'page')
    if (page) {
      console.log(`[launch] 已启动,工作区: ${workspace}`)
      console.log(`[launch] DevTools: http://127.0.0.1:${port}`)
      break
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 500))
}

console.log('[launch] 关闭窗口即退出。')
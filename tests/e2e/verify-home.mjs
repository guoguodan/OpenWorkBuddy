/**
 * 首页 1:1 验收:场景、能力、推荐问题、权限菜单、侧栏信息层级与三个新面板。
 * 用法: node tests/e2e/verify-home.mjs
 * 前置: pnpm --filter @openwb/daemon build && pnpm --filter @openwb/desktop build
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const electron = resolve(root, 'apps/desktop/node_modules/electron/dist/electron.exe')
const port = 9335
const endpoint = `http://127.0.0.1:${port}/json/list`

if (!existsSync(electron)) {
  console.error(`缺少 Electron 可执行文件: ${electron}`)
  console.error('先执行: node apps/desktop/node_modules/electron/install.js')
  process.exit(1)
}

let failed = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (ok, label, detail = '') => {
  if (ok) console.log(`PASS ${label}`)
  else {
    failed++
    console.log(`FAIL ${label} ${detail}`)
  }
}

async function waitForPage(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await (await fetch(endpoint)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch {}
    await sleep(500)
  }
  throw new Error('Electron 页面未在 30s 内就绪')
}

function connect(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const waiting = new Map()
    const exceptions = []
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params?.exceptionDetails
        exceptions.push(d?.exception?.description ?? d?.text ?? 'unknown exception')
      }
      if (m.id && waiting.has(m.id)) {
        waiting.get(m.id)(m)
        waiting.delete(m.id)
      }
    })
    const timer = setTimeout(() => rej(new Error('CDP WebSocket 连接超时 10s')), 10000)
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
      send('Runtime.enable', {}, 5000).catch(() => undefined)
      const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
        if (r.result?.exceptionDetails) {
          throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)
        }
        return r.result?.result?.value
      }
      res({ ws, evaluate, exceptions })
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
    if (await evaluate(expression)) return true
    await sleep(250)
  }
  return false
}

const workdir = await mkdtemp(join(tmpdir(), 'owb-home-ws-'))
const dataDir = await mkdtemp(join(tmpdir(), 'owb-home-data-'))
await writeFile(join(workdir, 'note.md'), '# 上下文样例\n\nHOME-CONTEXT-MARKER\n', 'utf8')

const env = {
  ...process.env,
  OPENWB_DAEMON_ENTRY: resolve(root, 'apps/daemon/dist/index.js'),
  OPENWB_WORKSPACE: workdir,
  OPENWB_DATA_DIR: dataDir,
  OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
  OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts')
}

const app = spawn(electron, [resolve(root, 'apps/desktop'), `--remote-debugging-port=${port}`], {
  cwd: workdir,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})
let appStderr = ''
app.stdout.on('data', () => {})
app.stderr.on('data', (b) => {
  appStderr += String(b)
})

let session
try {
  const page = await waitForPage()
  session = await connect(page.webSocketDebuggerUrl)
  const { evaluate } = session

  const ready = await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="welcome"]'))`)
  check(ready, 'welcome-rendered')

  const title = await evaluate(`document.querySelector('.owb-welcome__hero h1')?.textContent?.trim() ?? ''`)
  check(title === 'WorkBuddy, 我帮你', 'hero-title', title)

  const scenes = await evaluate(
    `Array.from(document.querySelectorAll('.owb-scene-tab')).map((b) => b.textContent.trim())`
  )
  check(JSON.stringify(scenes) === JSON.stringify(['办公', '开发', '设计']), 'scene-tabs', JSON.stringify(scenes))

  const activeScene = await evaluate(
    `document.querySelector('.owb-scene-tab[aria-selected="true"]')?.textContent?.trim() ?? ''`
  )
  check(activeScene === '办公', 'default-scene-working', activeScene)

  // 真实首页只有标题与场景切换,没有副标题。
  const heroSubtitle = await evaluate(`document.querySelector('.owb-welcome__hero p')?.textContent?.trim() ?? ''`)
  check(heroSubtitle === '', 'hero-has-no-subtitle', heroSubtitle)

  const mascotShown = await evaluate(`Boolean(document.querySelector('.owb-welcome__mascot'))`)
  check(mascotShown, 'home-mascot-rendered')

  const capabilities = await evaluate(
    `Array.from(document.querySelectorAll('.owb-capability')).map((b) => b.textContent.trim())`
  )
  const expectedCapabilities = ['文档', '金融服务', '分析数据', '制作PPT', '深度研究', '策划方案', '定时任务']
  check(
    JSON.stringify(capabilities) === JSON.stringify(expectedCapabilities),
    'capability-chips',
    JSON.stringify(capabilities)
  )

  const placeholder = await evaluate(
    `document.querySelector('textarea[data-testid="composer-input"]')?.getAttribute('placeholder') ?? ''`
  )
  check(
    placeholder === '告诉我你想做些什么？ @ 添加上下文，/调用技能与指令',
    'composer-placeholder',
    placeholder
  )

  // 模型名必须完整展示,不能因胶囊宽度被截断成 deepseek-v4-fla。
  const modelPill = await evaluate(`(() => {
    const el = document.querySelector('.owb-composer__model')
    const textEl = el?.querySelector('.owb-composer__model-text')
    if (!el || !textEl) return null
    return JSON.stringify({
      text: textEl.textContent.trim(),
      clipped: textEl.scrollWidth > textEl.clientWidth + 1,
      overflow: getComputedStyle(textEl).textOverflow,
      order: Array.from(el.children).map((x) => x.className)
    })
  })()`)
  check(modelPill !== null && !modelPill.includes('"clipped":true'), 'model-name-not-clipped', String(modelPill))

  // 页面内菜单必须存在;原生 Electron 菜单已移除,不应出现英文 File/Edit。
  const menubar = await evaluate(`document.querySelector('.owb-menubar')?.innerText ?? ''`)
  check(
    menubar.includes('编辑(E)') && menubar.includes('窗口(W)') && !menubar.includes('File'),
    'in-page-menubar-only',
    menubar.replace(/\n/g, ' | ')
  )

  // @ 直接打开工作区文件选择器,选中后成为可移除的附件;不应偷偷发送。
  const typeIntoComposer = (text) =>
    evaluate(`(() => {
      const input = document.querySelector('textarea[data-testid="composer-input"]')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(text)})
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
  await typeIntoComposer('请总结 @')
  const pickerOpen = await waitFor(
    evaluate,
    `Boolean(document.querySelector('[data-testid="composer-picker"][aria-label="添加上下文"]'))`
  )
  const fileListed = await waitFor(
    evaluate,
    `Array.from(document.querySelectorAll('[data-testid="picker-file"]')).some((b) => b.textContent.includes('note.md'))`
  )
  const pickerFiles = await evaluate(
    `Array.from(document.querySelectorAll('[data-testid="picker-file"]')).map((b) => b.textContent.trim())`
  )
  check(pickerOpen && fileListed, 'at-opens-file-picker', JSON.stringify(pickerFiles))
  await evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('[data-testid="picker-file"]')).find((x) => x.textContent.includes('note.md'))
    if (!b) throw new Error('找不到 note.md')
    b.click()
  })()`)
  const chipAdded = await waitFor(evaluate, `Boolean(document.querySelector('[data-testid="attachment-chip"]'))`)
  const chipText = await evaluate(`document.querySelector('[data-testid="attachment-chip"]')?.textContent?.trim() ?? ''`)
  const inputAfterPick = await evaluate(`document.querySelector('textarea[data-testid="composer-input"]')?.value ?? ''`)
  const sentAfterPick = await evaluate(`Boolean(document.querySelector('.owb-conversation, .owb-chat'))`)
  check(chipAdded && chipText.includes('note.md'), 'at-attachment-chip', chipText)
  check(!inputAfterPick.includes('@') && inputAfterPick.includes('请总结'), 'at-token-removed', inputAfterPick)
  check(!sentAfterPick, 'at-does-not-send')

  await evaluate(`document.querySelector('[data-testid="attachment-chip"] button').click()`)
  const chipRemoved = await waitFor(evaluate, `!document.querySelector('[data-testid="attachment-chip"]')`)
  check(chipRemoved, 'attachment-removable')

  // / 唤起技能与指令;没有已安装技能时也要给出明确空态,而不是弹不出。
  await typeIntoComposer('/')
  const skillPickerOpen = await waitFor(
    evaluate,
    `Boolean(document.querySelector('[data-testid="composer-picker"][aria-label="调用技能与指令"]'))`
  )
  check(skillPickerOpen, 'slash-opens-skill-picker')
  const noSkillPill = await evaluate(
    `!Array.from(document.querySelectorAll('.owb-composer__chip')).some((b) => b.textContent.includes('技能'))`
  )
  check(noSkillPill, 'composer-has-no-skill-pill')
  await evaluate(`document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  await typeIntoComposer('')
  await sleep(200)

  const suggestions = await evaluate(`document.querySelectorAll('.owb-suggestion').length`)
  check(suggestions === 4, 'suggestion-count', String(suggestions))

  // 场景切换不仅换 tab,能力和推荐内容也要随之变化。
  const workingCaps = capabilities
  const firstSuggestions = await evaluate(
    `Array.from(document.querySelectorAll('.owb-suggestion')).map((b) => b.textContent.trim())`
  )
  await evaluate(`document.querySelector('.owb-scene-tab[data-scene="coding"]').click()`)
  await sleep(300)
  const codingCaps = await evaluate(
    `Array.from(document.querySelectorAll('.owb-capability')).map((b) => b.textContent.trim())`
  )
  const codingSuggestions = await evaluate(
    `Array.from(document.querySelectorAll('.owb-suggestion')).map((b) => b.textContent.trim())`
  )
  check(
    codingCaps.includes('代码审查') && codingCaps.join('|') !== workingCaps.join('|'),
    'capabilities-per-scene',
    JSON.stringify(codingCaps)
  )
  check(
    JSON.stringify(codingSuggestions) !== JSON.stringify(firstSuggestions),
    'suggestions-per-scene'
  )

  await evaluate(`document.querySelector('[data-testid="refresh-suggestions"]').click()`)
  await sleep(300)
  const refreshedSuggestions = await evaluate(
    `Array.from(document.querySelectorAll('.owb-suggestion')).map((b) => b.textContent.trim())`
  )
  check(
    JSON.stringify(refreshedSuggestions) !== JSON.stringify(codingSuggestions),
    'suggestions-refresh',
    JSON.stringify(refreshedSuggestions)
  )
  const refreshedDraft = await evaluate(`document.querySelector('textarea[data-testid="composer-input"]')?.value ?? ''`)
  check(refreshedDraft === '', 'refresh-does-not-fill-input', refreshedDraft)

  await evaluate(`document.querySelector('.owb-scene-tab[data-scene="design"]').click()`)
  await sleep(300)
  const designCaps = await evaluate(
    `Array.from(document.querySelectorAll('.owb-capability')).map((b) => b.textContent.trim())`
  )
  check(designCaps.includes('页面设计'), 'capabilities-design', JSON.stringify(designCaps))

  await evaluate(`document.querySelector('.owb-scene-tab[data-scene="working"]').click()`)
  await sleep(300)

  // 能力胶囊只填充输入框,不应偷偷发送。
  await evaluate(`Array.from(document.querySelectorAll('.owb-capability')).find((b) => b.textContent.trim() === '文档').click()`)
  await sleep(300)
  const draft = await evaluate(`document.querySelector('textarea[data-testid="composer-input"]')?.value ?? ''`)
  const sentEarly = await evaluate(`Boolean(document.querySelector('.owb-conversation, .owb-chat'))`)
  check(draft.includes('工作文档'), 'capability-fills-composer', draft)
  check(!sentEarly, 'capability-does-not-send')
  await evaluate(`(() => {
    const input = document.querySelector('textarea[data-testid="composer-input"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)

  const sidebarText = await evaluate(`document.querySelector('.owb-sidebar')?.innerText ?? ''`)
  const navText = await evaluate(`document.querySelector('.owb-sidebar__nav')?.innerText ?? ''`)
  check(navText.includes('新建任务') && navText.includes('助理') && navText.includes('BETA'), 'sidebar-primary-nav', navText.replace(/\n/g, ' | '))
  check(
    navText.includes('专家·技能·连接器') && navText.includes('定时任务') && navText.includes('资料库') && navText.includes('更多'),
    'sidebar-secondary-nav',
    navText.replace(/\n/g, ' | ')
  )
  check(
    !/记忆|模型·连接器|团队频道|授权管理/.test(navText.replace(/专家·技能·连接器/g, '')),
    'sidebar-no-legacy-entries',
    navText.replace(/\n/g, ' | ')
  )
  check(sidebarText.includes('做任务赢积分好礼') && sidebarText.includes('立即前往'), 'sidebar-promo-card')

  // 侧栏不展示技能计数徽标;发现应用是带箭头的描边胶囊。
  const navBadge = await evaluate(`Boolean(document.querySelector('.owb-nav-count'))`)
  check(!navBadge, 'sidebar-no-skill-count-badge')
  const discoverShape = await evaluate(`(() => {
    const b = document.querySelector('.owb-discover')
    if (!b) return null
    const s = getComputedStyle(b)
    return JSON.stringify({ border: s.borderTopWidth, radius: s.borderTopLeftRadius, arrows: b.querySelectorAll('svg').length })
  })()`)
  check(
    discoverShape !== null && !discoverShape.includes('"border":"0px"') && discoverShape.includes('"arrows":2'),
    'sidebar-discover-pill',
    String(discoverShape)
  )

  // 权限菜单:可打开、三项、切换后持久化。
  await evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('.owb-composer__meta-btn')).find((x) => x.textContent.includes('默认权限'))
    if (!b) throw new Error('找不到权限按钮')
    b.click()
  })()`)
  await sleep(300)
  const permissionItems = await evaluate(
    `Array.from(document.querySelectorAll('[role="menuitemradio"]')).map((b) => b.textContent.trim())`
  )
  check(permissionItems.length === 3, 'permission-menu-items', JSON.stringify(permissionItems))
  await evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('[role="menuitemradio"]')).find((x) => x.textContent.includes('只读'))
    if (!b) throw new Error('找不到只读档位')
    b.click()
  })()`)
  await sleep(600)
  const readOnlyVisible = await evaluate(
    `Array.from(document.querySelectorAll('.owb-composer__meta-btn')).some((x) => x.textContent.includes('只读'))`
  )
  const persistedMode = await evaluate(
    `(async () => (await window.openwb.settings.get()).settings.permissionMode)()`
  )
  check(readOnlyVisible, 'permission-menu-switch-visible')
  check(persistedMode === 'readOnly', 'permission-persisted', String(persistedMode))
  await evaluate(`window.openwb.settings.set({ key: 'permissionMode', value: 'default' })`)
  await sleep(300)

  // 更多菜单与真实产品一致。
  await evaluate(`document.querySelector('[data-testid="open-more"]').click()`)
  await sleep(300)
  const moreItems = await evaluate(
    `Array.from(document.querySelectorAll('.owb-more__menu [role="menuitem"]')).map((b) => b.textContent.trim())`
  )
  check(
    ['项目', '我的邮箱', '腾讯文档', 'ima', '乐享知识库', '灵感社区'].every((label) =>
      moreItems.some((t) => t.startsWith(label))
    ),
    'more-menu-entries',
    JSON.stringify(moreItems)
  )
  await evaluate(`document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  await sleep(200)

  // 助理面板
  await evaluate(`document.querySelector('[data-testid="open-colleagues"]').click()`)
  const colleagueOpen = await waitFor(evaluate, `Boolean(document.querySelector('[role="dialog"][aria-label="助理"]'))`)
  const colleagueText = await evaluate(`document.querySelector('[role="dialog"][aria-label="助理"]')?.innerText ?? ''`)
  check(colleagueOpen && colleagueText.includes('创建助理'), 'colleagues-panel-open', colleagueText.slice(0, 120))
  await evaluate(`document.querySelector('[aria-label="关闭助理"]').click()`)
  await sleep(300)

  // 定时任务面板
  await evaluate(`document.querySelector('[data-testid="open-automation"]').click()`)
  const autoOpen = await waitFor(evaluate, `Boolean(document.querySelector('[role="dialog"][aria-label="定时任务"]'))`)
  const autoText = await evaluate(`document.querySelector('[role="dialog"][aria-label="定时任务"]')?.innerText ?? ''`)
  check(autoOpen && autoText.includes('新建定时任务'), 'automation-panel-open', autoText.slice(0, 120))
  await evaluate(`document.querySelector('[aria-label="关闭定时任务"]').click()`)
  await sleep(300)

  // 资料库面板
  await evaluate(`document.querySelector('[data-testid="open-library"]').click()`)
  const libOpen = await waitFor(evaluate, `Boolean(document.querySelector('[role="dialog"][aria-label="资料库"]'))`)
  const libText = await evaluate(`document.querySelector('[role="dialog"][aria-label="资料库"]')?.innerText ?? ''`)
  check(libOpen && libText.includes('资料库'), 'library-panel-open', libText.slice(0, 120))
  await evaluate(`document.querySelector('[aria-label="关闭资料库"]').click()`)
  await sleep(300)

  // 账号入口进入设置,记忆仍可从设置打开。
  await evaluate(`document.querySelector('.owb-account').click()`)
  const settingsOpen = await waitFor(evaluate, `Boolean(document.querySelector('[role="dialog"][aria-label="设置"]'))`)
  const settingsText = await evaluate(`document.querySelector('[role="dialog"][aria-label="设置"]')?.innerText ?? ''`)
  check(settingsOpen && settingsText.includes('账号与设置'), 'settings-panel-open', settingsText.slice(0, 120))
  check(settingsText.includes('记忆') && settingsText.includes('频道与同步') && settingsText.includes('长期授权'), 'settings-hides-legacy-entries')
  await evaluate(`document.querySelector('[aria-label="关闭设置"]').click()`)
  await sleep(300)

  const hasUncaught = session.exceptions.length > 0
  check(!hasUncaught, 'renderer-no-uncaught-exception', session.exceptions.slice(0, 3).join(' | '))
} catch (err) {
  failed++
  console.error(`FAIL 运行异常: ${err?.message ?? err}`)
  if (appStderr) console.error(appStderr.split('\n').slice(-20).join('\n'))
} finally {
  session?.ws.close()
  app.kill()
  await sleep(1200)
  await rm(workdir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 })
  await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 })
}

process.exit(failed === 0 ? 0 : 1)

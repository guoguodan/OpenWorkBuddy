/**
 * Electron 预览沙箱冒烟:用真实 Chromium 验证 CSP 生效。
 * 由 verify-p7-3.mjs 以 electron preview-smoke-main.cjs <html> 启动。
 */
const { app, BrowserWindow, session } = require('electron')
const path = require('node:path')

const target = process.argv[2]
const CSP = [
  "default-src 'none'",
  "img-src data: blob:",
  "style-src 'unsafe-inline'",
  "script-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

const logs = []

async function main() {
  const part = session.fromPartition('preview-smoke-' + Date.now(), { cache: false })
  part.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } })
  })
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      session: part
    }
  })
  win.webContents.on('console-message', (...args) => {
    const details = args[1]
    if (details && typeof details === 'object' && typeof details.message === 'string') logs.push(details.message)
    else if (typeof args[2] === 'string') logs.push(args[2])
  })
  await win.loadFile(path.resolve(target))
  await new Promise((r) => setTimeout(r, 600))
  const ran = await win.webContents.executeJavaScript('typeof window.__ran')
  const report = {
    ran,
    cspViolations: logs.filter((m) => /Content Security Policy|Refused to (execute|connect|load)/i.test(m)),
    logs
  }
  process.stdout.write('SMOKE_RESULT ' + JSON.stringify(report) + '\n')
  app.exit(ran === 'undefined' ? 0 : 1)
}

app.whenReady().then(main).catch((err) => {
  process.stdout.write('SMOKE_ERROR ' + err.message + '\n')
  app.exit(2)
})

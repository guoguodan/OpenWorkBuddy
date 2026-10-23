/**
 * P7-3 预览面板验收。
 * 用法: node tests/e2e/verify-p7-3.mjs
 * 用真实 Electron 验证 CSP,不需先构建应用。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const require = createRequire(resolve(root, 'apps/desktop/package.json'))
const electronPath = require('electron')

let failed = 0
const check = (ok, label, detail = '') => {
  if (ok) console.log(`PASS ${label}`)
  else {
    failed++
    console.log(`FAIL ${label}${detail ? ' :: ' + detail : ''}`)
  }
}

const base = await mkdtemp(join(tmpdir(), 'owb-p7-3-'))
const html = join(base, 'evil.html')
await mkdir(base, { recursive: true })
const page = [
  '<!doctype html><meta charset="utf-8"><h1>preview</h1>',
  '<script>window.__ran = 1; alert(1);</script>',
  "<script>fetch('https://example.com').catch(function(){})</script>"
].join('\n')
await writeFile(html, page, 'utf8')

function runSmoke() {
  return new Promise((resolveRun) => {
    const child = spawn(electronPath, [join(root, 'tests/e2e/fixtures/preview-smoke-main.cjs'), html], {
      cwd: root,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (b) => { out += String(b) })
    child.stderr.on('data', (b) => { err += String(b) })
    const timer = setTimeout(() => child.kill(), 30_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveRun({ code, out, err })
    })
  })
}

try {
  const result = await runSmoke()
  const match = /SMOKE_RESULT (\{.*\})/.exec(result.out)
  check(!!match, 'electron-smoke-ran', (result.out + result.err).slice(-400))
  if (match) {
    const report = JSON.parse(match[1])
    check(report.ran === 'undefined', 'inline-script-not-executed', JSON.stringify(report))
    check(report.cspViolations.length > 0, 'csp-violation-visible-in-console', JSON.stringify(report.cspViolations))
    check(
      report.cspViolations.some((m) => /script-src|inline script/i.test(m)),
      'script-src-blocked',
      JSON.stringify(report.cspViolations)
    )
  }
  check(result.code === 0, 'electron-exit-ok', String(result.code))
} finally {
  await rm(base, { recursive: true, force: true })
}

console.log(failed === 0 ? '\nP7-3 全部通过' : '\nP7-3 失败 ' + failed + ' 项')
process.exitCode = failed === 0 ? 0 : 1

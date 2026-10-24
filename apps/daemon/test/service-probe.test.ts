import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { probeServiceEndpoint } from '../src/service-probe.js'

const servers: Server[] = []

async function listen(
  handler: Parameters<typeof createServer>[0]
): Promise<{ server: Server; url: string; port: number }> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { server, url: `http://127.0.0.1:${port}`, port }
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
  )
})

describe('probeServiceEndpoint', () => {
  it('rejects malformed, non-http and credential-bearing endpoints without network access', async () => {
    for (const endpoint of [
      'not-a-url',
      'ftp://example.com',
      'https://user:secret@example.com',
      'https://token@example.com'
    ]) {
      const result = await probeServiceEndpoint(endpoint)
      expect(result.ok).toBe(false)
      expect(result.error).toContain('连接地址无效')
    }
  })

  it('reports a reachable service as connected', async () => {
    const { url } = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>ok</html>')
    })
    const result = await probeServiceEndpoint(`${url}/mailbox?token=hidden`, { timeoutMs: 2000 })
    expect(result).toMatchObject({ ok: true, status: 200, method: 'HEAD', error: null })
  })

  it('falls back to GET when the gateway rejects HEAD', async () => {
    const { url } = await listen((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(405)
        res.end()
        return
      }
      res.writeHead(204)
      res.end()
    })
    const result = await probeServiceEndpoint(url, { timeoutMs: 2000 })
    expect(result).toMatchObject({ ok: true, status: 204, method: 'GET', error: null })
  })

  it('explains auth, missing and unavailable responses instead of claiming success', async () => {
    // 地址会规范化为 origin,所以用独立服务验证每一类状态码,而不是依赖路径。
    const authServer = await listen((_req, res) => {
      res.writeHead(401)
      res.end()
    })
    const missingServer = await listen((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    const unavailableServer = await listen((_req, res) => {
      res.writeHead(503)
      res.end()
    })

    const auth = await probeServiceEndpoint(authServer.url, { timeoutMs: 2000 })
    expect(auth).toMatchObject({ ok: false, status: 401, method: 'GET' })
    expect(auth.error).toContain('身份验证')

    const missing = await probeServiceEndpoint(missingServer.url, { timeoutMs: 2000 })
    expect(missing).toMatchObject({ ok: false, status: 404 })
    expect(missing.error).toContain('不存在')

    const unavailable = await probeServiceEndpoint(unavailableServer.url, { timeoutMs: 2000 })
    expect(unavailable).toMatchObject({ ok: false, status: 503 })
    expect(unavailable.error).toContain('暂时不可用')

    await Promise.all([
      closeServer(authServer.server),
      closeServer(missingServer.server),
      closeServer(unavailableServer.server)
    ])
  })

  it('refuses a closed port', async () => {
    const { server, url } = await listen((_req, res) => res.end('ok'))
    await closeServer(server)
    servers.splice(servers.indexOf(server), 1)
    const result = await probeServiceEndpoint(url, { timeoutMs: 1500 })
    expect(result.ok).toBe(false)
    expect(result.status).toBeNull()
    expect(result.error).toMatch(/无法连接|拒绝连接/)
  })

  it('honours the overall timeout for a server that never answers', async () => {
    const { url } = await listen(() => {
      // 故意不响应,验证探测有明确上限。
    })
    const started = Date.now()
    const result = await probeServiceEndpoint(url, { timeoutMs: 200 })
    expect(Date.now() - started).toBeLessThan(1500)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('连接超时')
  })
})

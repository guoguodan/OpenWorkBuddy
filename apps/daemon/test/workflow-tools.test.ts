import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  fetchPage,
  offlineSearchRunner,
  setSearchRunner,
  webFetchTool,
  webSearchTool
} from '../src/tools/workflow-tools.js'
import { extractTitle, htmlToText } from '../src/tools/web/html.js'
import { isPrivateAddress } from '../src/tools/web/network.js'
import {
  createSearchRunner,
  parseSearchPayload,
  resolveSearchConfig,
  SearchConfigError
} from '../src/tools/web/search.js'

const servers: Server[] = []

afterEach(async () => {
  setSearchRunner(null)
  delete process.env.OPENWB_WEB_SEARCH
  delete process.env.OPENWB_SEARCH_PROVIDER
  delete process.env.OPENWB_SEARCH_API_KEY
  delete process.env.OPENWB_SEARCH_ENDPOINT
  delete process.env.OPENWB_WEB_FETCH
  delete process.env.OPENWB_WEB_FETCH_ALLOW_PRIVATE
  delete process.env.OPENWB_MOCK
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

async function serve(
  handler: Parameters<typeof createServer>[1]
): Promise<{ origin: string; server: Server }> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { origin: `http://127.0.0.1:${port}`, server }
}

describe('html 正文提取', () => {
  it('取 title 与正文,去掉脚本、导航与固定头尾', () => {
    const html = `<!doctype html><html><head>
      <title>示例 &amp; 文档</title><style>.x{color:red}</style>
      </head><body>
      <header>导航</header>
      <nav>站点导航</nav>
      <article>
        <h1>标题</h1>
        <p>第一段 &lt;正文&gt;。</p>
        <script>alert(1)</script>
        <p>第二段&nbsp;内容。</p>
      </article>
      <footer>版权</footer>
      </body></html>`
    expect(extractTitle(html)).toBe('示例 & 文档')
    const text = htmlToText(html)
    expect(text).toContain('标题')
    expect(text).toContain('第一段 <正文>。')
    expect(text).toContain('第二段 内容。')
    expect(text).not.toContain('alert')
    expect(text).not.toContain('站点导航')
    expect(text).not.toContain('版权')
  })

  it('超长正文被截断并明确标注', () => {
    const html = `<p>${'字'.repeat(500)}</p>`
    const text = htmlToText(html, 100)
    expect(text.endsWith('[正文已截断]')).toBe(true)
    expect(text.length).toBeLessThan(140)
  })

  it('相邻行内标签不会把单词粘连', () => {
    expect(htmlToText('<p>Hello <b>world</b> again</p>')).toBe('Hello world again')
  })
})

describe('URL 与地址边界', () => {
  it('识别回环、私网、链路本地与文档网段', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1'
    ]) {
      expect(isPrivateAddress(address), address).toBe(true)
    }
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false)
  })

  it('拒绝非 http/https、带凭据与 localhost', async () => {
    await expect(fetchPage('file:///etc/passwd')).rejects.toThrow(/http/)
    await expect(fetchPage('http://user:pass@example.com/')).rejects.toThrow(/凭据/)
    await expect(fetchPage('http://localhost:3000/')).rejects.toThrow(/内网|回环/)
    await expect(fetchPage('http://127.0.0.1/')).rejects.toThrow(/内网|回环/)
  })
})

describe('web_fetch', () => {
  it('抓取本地页面并提取正文', async () => {
    const { origin } = await serve((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><head><title>本地页</title></head><body><main><p>正文内容</p></main></body></html>')
    })
    const page = await fetchPage(`${origin}/doc`, { allowPrivate: true })
    expect(page.title).toBe('本地页')
    expect(page.text).toContain('正文内容')
  })

  it('重定向逐跳校验,并拒绝跳到私网', async () => {
    const { origin } = await serve((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/next' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('done')
    })
    const page = await fetchPage(`${origin}/start`, { allowPrivate: true })
    expect(page.text).toBe('done')
    expect(page.url).toBe(`${origin}/next`)

    await expect(
      fetchPage('https://example.com/start', {
        fetchImpl: async (input) => {
          const target = String(input)
          if (target.includes('example.com')) {
            return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9/secret' } })
          }
          throw new Error(`不应访问 ${target}`)
        }
      })
    ).rejects.toThrow(/内网|回环/)
  })

  it('拒绝二进制响应与超大正文', async () => {
    const { origin } = await serve((req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end('binary')
    })
    await expect(fetchPage(`${origin}/a.png`, { allowPrivate: true })).rejects.toThrow(/响应类型/)

    const big = await serve((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('a'.repeat(20_000))
    })
    const page = await fetchPage(`${big.origin}/big`, { allowPrivate: true, maxBytes: 1_000, maxChars: 200 })
    expect(page.text.length).toBeLessThanOrEqual(220)
  })

  it('超时与外部取消给出不同错误', async () => {
    const { origin } = await serve(() => {
      // 故意不响应
    })
    await expect(fetchPage(`${origin}/slow`, { allowPrivate: true, timeoutMs: 30 })).rejects.toThrow(/超时/)

    const controller = new AbortController()
    const pending = fetchPage(`${origin}/slow`, {
      allowPrivate: true,
      timeoutMs: 5_000,
      signal: controller.signal
    })
    controller.abort()
    await expect(pending).rejects.toThrow(/取消/)
  })

  it('工具在 mock 下离线返回,在 live 下真实抓取', async () => {
    const { origin } = await serve((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<title>实时</title><p>实时正文</p>')
    })
    process.env.OPENWB_MOCK = '1'
    process.env.OPENWB_WEB_FETCH_ALLOW_PRIVATE = '1'
    const offline = await webFetchTool.execute({ urls: [`${origin}/x`] }, { workspaceRoot: process.cwd() })
    expect(offline[0]?.text).toContain('离线抓取占位')

    delete process.env.OPENWB_MOCK
    process.env.OPENWB_WEB_FETCH = 'live'
    const live = await webFetchTool.execute({ urls: [`${origin}/x`] }, { workspaceRoot: process.cwd() })
    expect(live[0]?.title).toBe('实时')
    expect(live[0]?.text).toContain('实时正文')
  })

  it('部分失败保留成功页并标注失败原因;全部失败才抛错', async () => {
    const { origin } = await serve((req, res) => {
      if (req.url === '/ok') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok')
        return
      }
      res.writeHead(500)
      res.end('bad')
    })
    process.env.OPENWB_WEB_FETCH = 'live'
    process.env.OPENWB_WEB_FETCH_ALLOW_PRIVATE = '1'
    const pages = await webFetchTool.execute(
      { urls: [`${origin}/ok`, `${origin}/bad`] },
      { workspaceRoot: process.cwd() }
    )
    expect(pages[0]?.text).toBe('ok')
    expect(pages[1]?.error).toMatch(/500/)
    await expect(
      webFetchTool.execute({ urls: [`${origin}/bad`] }, { workspaceRoot: process.cwd() })
    ).rejects.toThrow(/全部页面抓取失败/)
  })
})

describe('web_search', () => {
  it('未配置 provider 时明确回退到离线样例', async () => {
    const urls = await webSearchTool.execute({ query: '测试', limit: 2 }, { workspaceRoot: process.cwd() })
    expect(urls).toHaveLength(2)
    expect(urls.every((url) => url.startsWith('https://example.com/'))).toBe(true)
  })

  it('显式 live 但缺少配置时直接失败,不静默造假来源', async () => {
    process.env.OPENWB_WEB_SEARCH = 'live'
    await expect(
      webSearchTool.execute({ query: 'q' }, { workspaceRoot: process.cwd() })
    ).rejects.toThrow(/未配置检索 provider/)
  })

  it('注入 runner 后按顺序返回 URL', async () => {
    setSearchRunner({
      async search() {
        return [
          { title: 'A', url: 'https://a.example/doc', snippet: '' },
          { title: 'B', url: 'https://b.example/doc', snippet: '' }
        ]
      }
    })
    await expect(
      webSearchTool.execute({ query: 'q' }, { workspaceRoot: process.cwd() })
    ).resolves.toEqual(['https://a.example/doc', 'https://b.example/doc'])
  })

  it('provider 配置解析与错误信息', () => {
    expect(resolveSearchConfig({})).toBeNull()
    expect(
      resolveSearchConfig({ OPENWB_SEARCH_PROVIDER: 'brave', BRAVE_SEARCH_API_KEY: 'k' })
    ).toMatchObject({ provider: 'brave', apiKey: 'k', endpoint: 'https://api.search.brave.com/res/v1/web/search' })
    expect(() => resolveSearchConfig({ OPENWB_SEARCH_PROVIDER: 'tavily' })).toThrow(SearchConfigError)
    expect(() => resolveSearchConfig({ OPENWB_SEARCH_PROVIDER: 'searxng' })).toThrow(/ENDPOINT/)
    expect(() => resolveSearchConfig({ OPENWB_SEARCH_PROVIDER: 'unknown' })).toThrow(/未知检索/)
    expect(() =>
      resolveSearchConfig({ OPENWB_SEARCH_PROVIDER: 'searxng', OPENWB_SEARCH_ENDPOINT: 'file:///x' })
    ).toThrow(/http/)
  })

  it('解析四类 provider 的返回结构并去重、过滤非 http', () => {
    expect(
      parseSearchPayload(
        'brave',
        {
          web: {
            results: [
              { title: 'A', url: 'https://a.example', description: 'desc' },
              { title: 'A2', url: 'https://a.example' },
              { title: 'B', url: 'ftp://b.example' }
            ]
          }
        },
        5
      )
    ).toEqual([{ title: 'A', url: 'https://a.example/', snippet: 'desc' }])
    expect(
      parseSearchPayload('serper', { organic: [{ title: 'S', link: 'https://s.example', snippet: 'ss' }] }, 5)
    ).toEqual([{ title: 'S', url: 'https://s.example/', snippet: 'ss' }])
    expect(
      parseSearchPayload('tavily', { results: [{ title: 'T', url: 'https://t.example', content: 'tt' }] }, 5)
    ).toEqual([{ title: 'T', url: 'https://t.example/', snippet: 'tt' }])
    expect(
      parseSearchPayload('searxng', { results: [{ title: 'X', url: 'https://x.example', content: 'xx' }] }, 5)
    ).toEqual([{ title: 'X', url: 'https://x.example/', snippet: 'xx' }])
  })

  it('真实 runner 发送正确的请求并解析结果', async () => {
    let seenUrl = ''
    let seenBody = ''
    let seenKey = ''
    const { origin } = await serve((req, res) => {
      seenUrl = req.url ?? ''
      seenKey = String(req.headers.authorization ?? '')
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        seenBody = Buffer.concat(chunks).toString('utf8')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ results: [{ title: '结果', url: 'https://result.example/a', content: '摘要' }] }))
      })
    })
    const runner = createSearchRunner({
      provider: 'tavily',
      apiKey: 'secret',
      endpoint: `${origin}/search`
    })
    const hits = await runner.search('hello', 3)
    expect(hits).toEqual([{ title: '结果', url: 'https://result.example/a', snippet: '摘要' }])
    expect(seenUrl).toBe('/search')
    expect(seenKey).toBe('Bearer secret')
    expect(JSON.parse(seenBody)).toMatchObject({ query: 'hello', max_results: 3 })
  })

  it('真实 runner 对错误状态与超时明确失败', async () => {
    const { origin } = await serve((req, res) => {
      if (req.url?.startsWith('/timeout')) return
      res.writeHead(429, { 'content-type': 'text/plain' })
      res.end('quota exceeded')
    })
    const runner = createSearchRunner({ provider: 'searxng', endpoint: `${origin}/fail` })
    await expect(runner.search('q', 1)).rejects.toThrow(/429/)

    const slow = createSearchRunner({ provider: 'searxng', endpoint: `${origin}/timeout?x=1` }, { timeoutMs: 30 })
    await expect(slow.search('q', 1)).rejects.toThrow(/超时/)

    const controller = new AbortController()
    controller.abort()
    await expect(slow.search('q', 1, controller.signal)).rejects.toThrow(/取消/)
  })

  it('离线 runner 尊重取消', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(offlineSearchRunner.search('q', 3, controller.signal)).rejects.toThrow(/取消/)
  })
})

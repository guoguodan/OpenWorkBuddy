import { describe, expect, it, vi } from 'vitest'
import { classifyPath, normalizePathForCompare } from '../src/paths.js'
import { classifyRisk, pluginNameFromTool, riskFromApprovalKind } from '../src/risk.js'
import { decide, evaluate, summarizeArgs, type GateContext } from '../src/gate.js'
import { InMemorySessionGrants, MemoryPersistentGrants, approvalExpiry } from '../src/grants.js'
import { builtinRisk } from '../src/builtin-risk.js'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function context(overrides: Partial<GateContext> = {}): GateContext {
  return {
    workspaceRoot: 'C:/work/space',
    conversationId: 'conv-1',
    modeAllows: () => true,
    classifyRisk: async () => null,
    requestApproval: async () => ({ approved: true, scope: 'once' }),
    sessionGrants: new InMemorySessionGrants(),
    persistentGrants: new MemoryPersistentGrants(),
    newApprovalId: () => 'approval-1',
    ...overrides
  }
}

describe('路径分类', () => {
  const opts = { platform: 'win32' as const, home: 'C:/Users/me', systemRoots: ['C:/Windows'] }

  it('工作区优先于个人目录', () => {
    expect(classifyPath('C:/Users/me/Documents/proj/a.ts', 'C:/Users/me/Documents/proj', opts)).toBe('workspace')
  })

  it('识别桌面/下载/文档/图片', () => {
    for (const name of ['Desktop', 'Downloads', 'Documents', 'Pictures']) {
      expect(classifyPath(`C:/Users/me/${name}/x.txt`, 'C:/work', opts)).toBe('personal')
    }
  })

  it('系统目录独立于个人目录', () => {
    expect(classifyPath('C:/Windows/System32/drivers/etc/hosts', 'C:/work', opts)).toBe('system')
  })

  it('其他位置需要确认', () => {
    expect(classifyPath('D:/random/x.txt', 'C:/work', opts)).toBe('other')
  })

  it('大小写与前缀边界不被绕过', () => {
    expect(classifyPath('c:/windows/system.ini', 'C:/work', opts)).toBe('system')
    expect(classifyPath('C:/work2/x.txt', 'C:/work', opts)).toBe('other')
    expect(normalizePathForCompare('C:/Work/')).toBe('c:\\work')
  })

  it('空路径与 NUL 抛错', () => {
    expect(() => classifyPath('', 'C:/work', opts)).toThrow()
    expect(() => classifyPath('a\0b', 'C:/work', opts)).toThrow()
  })
})

describe('风险分类', () => {
  it('解析插件工具名', () => {
    expect(pluginNameFromTool('miora__text_to_image')).toBe('miora')
    expect(pluginNameFromTool('read_file')).toBeNull()
  })

  it('计费/删除/外部写入分别映射风险', () => {
    expect(riskFromApprovalKind('charge', 'img', 'p').kind).toBe('billing')
    expect(riskFromApprovalKind('delete', 'files', 'p').kind).toBe('destructive')
    expect(riskFromApprovalKind('writeExternal', 'mail', 'p').kind).toBe('high-risk')
  })

  it('清单读取失败按未知风险 fail-closed', async () => {
    const risk = await classifyRisk(
      { name: 'p__charge', arguments: {} },
      {
        workspaceRoot: 'C:/work',
        resolveManifestTool: async () => {
          throw new Error('manifest 损坏')
        },
        classifyPath: () => 'workspace'
      }
    )
    expect(risk?.kind).toBe('unknown')
    expect(risk?.gateError).toBe(true)
  })

  it('路径分类异常按未知风险处理', async () => {
    const risk = await classifyRisk(
      { name: 'write_file', arguments: { path: 'a.txt' }, effects: { writesFilesystem: true } },
      {
        workspaceRoot: 'C:/work',
        resolveManifestTool: async () => null,
        classifyPath: () => {
          throw new Error('stat 失败')
        }
      }
    )
    expect(risk?.kind).toBe('unknown')
    expect(risk?.gateError).toBe(true)
  })

  it('系统路径单独标记为拒绝类型', async () => {
    const risk = await classifyRisk(
      { name: 'write_file', arguments: { path: 'C:/Windows/a.txt' }, effects: { writesFilesystem: true } },
      {
        workspaceRoot: 'C:/work',
        resolveManifestTool: async () => null,
        classifyPath: () => 'system'
      }
    )
    expect(risk?.kind).toBe('system-path')
  })
})

describe('审批决策顺序', () => {
  it('计费判定先于模式策略', async () => {
    const verdict = await evaluate(
      { name: 'p__charge', arguments: {} },
      context({
        modeAllows: () => false,
        classifyRisk: async () => riskFromApprovalKind('charge', 'img', 'p')
      })
    )
    expect(verdict.action).toBe('ask')
  })

  it('审批通过后仍受模式边界约束', async () => {
    const decision = await decide(
      { name: 'p__charge', arguments: {} },
      context({
        modeAllows: () => false,
        classifyRisk: async () => riskFromApprovalKind('charge', 'img', 'p')
      })
    )
    expect(decision).toMatchObject({ action: 'deny', code: 'MODE_DENIED' })
  })

  it('普通工具在模式禁止时直接拒绝且不弹审批', async () => {
    const request = vi.fn()
    const decision = await decide(
      { name: 'write_file', arguments: { path: 'a.txt' } },
      context({ modeAllows: () => false, requestApproval: request })
    )
    expect(decision).toMatchObject({ action: 'deny', code: 'MODE_DENIED' })
    expect(request).not.toHaveBeenCalled()
  })

  it('路径分类异常时 ask,而不是 allow', async () => {
    const verdict = await evaluate(
      { name: 'write_file', arguments: { path: 'a.txt' } },
      context({
        classifyRisk: async () => {
          throw new Error('boom')
        }
      })
    )
    expect(verdict.action).toBe('ask')
  })

  it('审批通道不可用时拒绝执行并标记可重试', async () => {
    const decision = await decide(
      { name: 'p__charge', arguments: {} },
      context({
        classifyRisk: async () => riskFromApprovalKind('charge', 'img', 'p'),
        requestApproval: async () => {
          throw new Error('UI 未就绪')
        }
      })
    )
    expect(decision).toMatchObject({ action: 'deny', retryable: true })
  })

  it('用户拒绝时返回 USER_DENIED', async () => {
    const decision = await decide(
      { name: 'p__charge', arguments: {} },
      context({
        classifyRisk: async () => riskFromApprovalKind('charge', 'img', 'p'),
        requestApproval: async () => ({ approved: false, scope: 'once' })
      })
    )
    expect(decision).toMatchObject({ action: 'deny', code: 'USER_DENIED' })
  })

  it('系统路径直接拒绝,不进入审批', async () => {
    const request = vi.fn()
    const decision = await decide(
      { name: 'write_file', arguments: { path: 'C:/Windows/a.txt' } },
      context({
        requestApproval: request,
        classifyRisk: async () => ({
          kind: 'system-path',
          groupKey: 'path:system',
          title: '禁止',
          detail: '系统目录'
        })
      })
    )
    expect(decision).toMatchObject({ action: 'deny', code: 'PATH_SYSTEM_DENIED' })
    expect(request).not.toHaveBeenCalled()
  })
})

describe('审批记忆', () => {
  it('session 授权后同会话同组第二次不再询问', async () => {
    const sessionGrants = new InMemorySessionGrants()
    const requestApproval = vi.fn(async () => ({ approved: true, scope: 'session' as const }))
    const ctx = context({
      sessionGrants,
      requestApproval,
      classifyRisk: async () => riskFromApprovalKind('charge', 'img', 'p')
    })
    expect((await decide({ name: 'p__a', arguments: {} }, ctx)).action).toBe('allow')
    expect((await decide({ name: 'p__b', arguments: {} }, ctx)).action).toBe('allow')
    expect(requestApproval).toHaveBeenCalledTimes(1)
  })

  it('session 授权不跨会话', async () => {
    const sessionGrants = new InMemorySessionGrants()
    sessionGrants.add('conv-1', 'plugin:p:img')
    expect(sessionGrants.has('conv-2', 'plugin:p:img')).toBe(false)
  })

  it('always 授权 30 天后失效', async () => {
    const store = new MemoryPersistentGrants()
    const now = new Date('2026-01-01T00:00:00.000Z')
    store.add('plugin:p:img', 'p__charge', approvalExpiry(now, 30))
    expect(store.has('plugin:p:img', new Date(now.getTime() + 29 * DAY))).toBe(true)
    expect(store.has('plugin:p:img', new Date(now.getTime() + 31 * DAY))).toBe(false)
  })

  it('always 授权持久化后不再询问,过期后重新询问', async () => {
    const persistentGrants = new MemoryPersistentGrants()
    let now = new Date('2026-01-01T00:00:00.000Z')
    const requestApproval = vi.fn(async () => ({ approved: true, scope: 'always' as const }))
    const ctx = context({
      persistentGrants,
      requestApproval,
      now: () => now,
      classifyRisk: async () => riskFromApprovalKind('charge', 'img', 'p')
    })
    await decide({ name: 'p__charge', arguments: {} }, ctx)
    await decide({ name: 'p__charge', arguments: {} }, ctx)
    expect(requestApproval).toHaveBeenCalledTimes(1)

    now = new Date('2026-02-15T00:00:00.000Z')
    await decide({ name: 'p__charge', arguments: {} }, ctx)
    expect(requestApproval).toHaveBeenCalledTimes(2)
  })

  it('默认授权期限是 30 天', () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    expect(approvalExpiry(now)).toBe(new Date(now.getTime() + 30 * DAY).toISOString())
  })
})

describe('审批卡参数摘要', () => {
  it('掩码凭据字段且限制长度', () => {
    const summary = summarizeArgs({ apiKey: 'sk-secret', text: 'hello', nested: { token: 't' } })
    expect(summary).not.toContain('sk-secret')
    expect(summary).not.toContain('"t"')
    expect(summary).toContain('hello')
  })
})

describe('内置高危命令', () => {
  const shell = (command: string, args: string[] = []) =>
    builtinRisk({ name: 'shell', arguments: { command, args } })

  it('无条件删除类命令命中', () => {
    expect(shell('rm', ['-rf', 'build'])).toMatchObject({ kind: 'high-risk' })
    expect(shell('C:/Windows/System32/format.com')).not.toBeNull()
    expect(shell('node', ['-e', 'rm'])).toBeNull()
  })

  it('git clean / git reset 命中,但 --grep 不误判', () => {
    expect(shell('git', ['clean', '-fd'])).toMatchObject({ groupKey: 'builtin:shell:git:clean' })
    expect(shell('git', ['reset', '--hard'])).toMatchObject({ groupKey: 'builtin:shell:git:reset' })
    expect(shell('git', ['log', '--grep=clean'])).toBeNull()
  })

  it('唯一破坏性子命令才命中,模拟参数不影响判定', () => {
    expect(shell('reg', ['delete', 'HKCU\\Software\\x'])).toMatchObject({ kind: 'high-risk' })
    expect(shell('npm', ['unpublish', 'pkg'])).toMatchObject({ kind: 'high-risk' })
    expect(shell('npm', ['install'])).toBeNull()
  })
})

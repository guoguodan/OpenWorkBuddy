import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  MAX_DESTRUCTIVE_BATCH,
  SecurityError,
  backupDestructivePlan,
  destructiveRequestFromTool,
  executeDestructivePlan,
  inspectDestructiveRequest,
  restoreDestructiveBackup
} from '../src/destructive.js'
import { MemoryTrashAdapter } from '../src/trash.js'

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'owb-sec-'))
  const workspace = join(base, 'ws')
  const home = join(base, 'home')
  const backups = join(base, 'backups')
  await mkdir(workspace, { recursive: true })
  await mkdir(join(home, 'Desktop'), { recursive: true })
  await mkdir(backups, { recursive: true })
  await writeFile(join(home, 'Desktop', 'a.txt'), 'alpha', 'utf8')
  await writeFile(join(home, 'Desktop', 'b.txt'), 'beta', 'utf8')
  await mkdir(join(workspace, 'folder', 'nested'), { recursive: true })
  await writeFile(join(workspace, 'folder', 'nested', 'x.txt'), 'x', 'utf8')
  return { base, workspace, home, backups }
}

describe('破坏性请求解析', () => {
  it('单批上限 10:11 项直接拒绝', () => {
    expect(() =>
      destructiveRequestFromTool('delete_files', {
        paths: Array.from({ length: 11 }, (_, i) => `f${i}.txt`)
      })
    ).toThrowError(/BATCH_TOO_LARGE|最多处理/)
    expect(MAX_DESTRUCTIVE_BATCH).toBe(10)
  })

  it('移动必须同时给出 from / to', () => {
    expect(() => destructiveRequestFromTool('move_files', { items: [{ from: 'a' }] })).toThrow()
    expect(destructiveRequestFromTool('move_files', { items: [{ from: 'a', to: 'b' }] }).operation).toBe('move')
  })
})

describe('删除计划', () => {
  it('生成完整清单、大小与稳定指纹', async () => {
    const f = await fixture()
    const request = destructiveRequestFromTool('delete_files', {
      paths: [join(f.home, 'Desktop', 'a.txt'), join(f.home, 'Desktop', 'b.txt')]
    })
    const plan = await inspectDestructiveRequest(request, {
      workspaceRoot: f.workspace,
      home: f.home,
      platform: 'win32'
    })
    expect(plan.items).toHaveLength(2)
    expect(plan.items.map((item) => item.path).sort()).toEqual(
      [join(f.home, 'Desktop', 'a.txt'), join(f.home, 'Desktop', 'b.txt')].sort()
    )
    expect(plan.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('目录递归统计并对文件改动改变指纹', async () => {
    const f = await fixture()
    const request = destructiveRequestFromTool('delete_files', { paths: [join(f.workspace, 'folder')] })
    const before = await inspectDestructiveRequest(request, { workspaceRoot: f.workspace, home: f.home })
    await writeFile(join(f.workspace, 'folder', 'new.txt'), 'changed', 'utf8')
    const after = await inspectDestructiveRequest(request, { workspaceRoot: f.workspace, home: f.home })
    expect(before.fingerprint).not.toBe(after.fingerprint)
    expect(before.items[0]!.entryCount).toBe(2)
    expect(after.items[0]!.entryCount).toBe(3)
  })

  it('系统目录、保护根目录、符号链接都拒绝', async () => {
    const f = await fixture()
    const opts = { workspaceRoot: f.workspace, home: f.home, platform: 'win32' as const }
    await expect(
      inspectDestructiveRequest(
        destructiveRequestFromTool('delete_files', { paths: ['C:/Windows/System32/x.dll'] }),
        { ...opts, classifyPath: () => 'system' }
      )
    ).rejects.toBeInstanceOf(SecurityError)

    await expect(
      inspectDestructiveRequest(
        destructiveRequestFromTool('delete_files', { paths: [f.home] }),
        opts
      )
    ).rejects.toMatchObject({ code: 'PATH_PROTECTED_ROOT' })

    const link = join(f.workspace, 'link.txt')
    try {
      await symlink(join(f.home, 'Desktop', 'a.txt'), link)
    } catch (err) {
      // Windows 未开启开发者模式时普通用户无法建符号链接;这是环境限制,不是产品行为。
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err
      return
    }
    await expect(
      inspectDestructiveRequest(destructiveRequestFromTool('delete_files', { paths: [link] }), opts)
    ).rejects.toMatchObject({ code: 'SYMLINK_DENIED' })
  })

  it('父子目标重叠拒绝,避免重复处理', async () => {
    const f = await fixture()
    await expect(
      inspectDestructiveRequest(
        destructiveRequestFromTool('delete_files', {
          paths: [join(f.workspace, 'folder'), join(f.workspace, 'folder', 'nested', 'x.txt')]
        }),
        { workspaceRoot: f.workspace, home: f.home }
      )
    ).rejects.toMatchObject({ code: 'OVERLAPPING_TARGETS' })
  })

  it('移动目标已存在时拒绝覆盖', async () => {
    const f = await fixture()
    await writeFile(join(f.workspace, 'exists.txt'), 'keep', 'utf8')
    await expect(
      inspectDestructiveRequest(
        destructiveRequestFromTool('move_files', {
          items: [{ from: join(f.workspace, 'folder'), to: join(f.workspace, 'exists.txt') }]
        }),
        { workspaceRoot: f.workspace, home: f.home }
      )
    ).rejects.toMatchObject({ code: 'DESTINATION_EXISTS' })
  })
})

describe('备份与执行', () => {
  it('备份写 manifest,文件与目录都能还原', async () => {
    const f = await fixture()
    const plan = await inspectDestructiveRequest(
      destructiveRequestFromTool('delete_files', {
        paths: [join(f.home, 'Desktop', 'a.txt'), join(f.workspace, 'folder')]
      }),
      { workspaceRoot: f.workspace, home: f.home }
    )
    const backup = await backupDestructivePlan(plan, f.backups, {
      now: () => new Date('2026-01-01T00:00:00Z'),
      id: () => 'test'
    })
    const manifest = JSON.parse(await readFile(backup.manifestPath, 'utf8'))
    expect(manifest.items).toHaveLength(2)
    expect(manifest.items[0].sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.items[1].kind).toBe('directory')

    await rm(join(f.home, 'Desktop', 'a.txt'))
    await rm(join(f.workspace, 'folder'), { recursive: true })
    const restored = await restoreDestructiveBackup(backup.manifestPath)
    expect(restored.restored).toHaveLength(2)
    expect(await readFile(join(f.home, 'Desktop', 'a.txt'), 'utf8')).toBe('alpha')
    expect(await readFile(join(f.workspace, 'folder', 'nested', 'x.txt'), 'utf8')).toBe('x')
  })

  it('删除走回收站适配器,并在执行前重新校验指纹', async () => {
    const f = await fixture()
    const request = destructiveRequestFromTool('delete_files', { paths: [join(f.home, 'Desktop', 'a.txt')] })
    const plan = await inspectDestructiveRequest(request, { workspaceRoot: f.workspace, home: f.home })
    await writeFile(join(f.home, 'Desktop', 'a.txt'), 'changed!', 'utf8')
    const fresh = await inspectDestructiveRequest(request, { workspaceRoot: f.workspace, home: f.home })
    const trash = new MemoryTrashAdapter()
    await expect(
      executeDestructivePlan(plan, fresh, { backupRoot: f.backups, trash })
    ).rejects.toMatchObject({ code: 'PLAN_CHANGED' })
    expect(trash.calls).toHaveLength(0)
  })

  it('回收站失败时不报告成功,并保留备份路径', async () => {
    const f = await fixture()
    const request = destructiveRequestFromTool('delete_files', { paths: [join(f.home, 'Desktop', 'a.txt')] })
    const plan = await inspectDestructiveRequest(request, { workspaceRoot: f.workspace, home: f.home })
    const fresh = await inspectDestructiveRequest(request, { workspaceRoot: f.workspace, home: f.home })
    const trash = new MemoryTrashAdapter('fail')
    await expect(
      executeDestructivePlan(plan, fresh, { backupRoot: f.backups, trash })
    ).rejects.toMatchObject({ code: 'DESTRUCTIVE_FAILED' })
    expect(await stat(join(f.home, 'Desktop', 'a.txt'))).toBeTruthy()
  })

  it('移动成功:原路径消失、目标存在、备份可还原', async () => {
    const f = await fixture()
    const request = destructiveRequestFromTool('move_files', {
      items: [{ from: join(f.home, 'Desktop', 'a.txt'), to: join(f.home, 'Desktop', 'a-moved.txt') }]
    })
    const plan = await inspectDestructiveRequest(request, { workspaceRoot: f.workspace, home: f.home })
    const fresh = await inspectDestructiveRequest(request, { workspaceRoot: f.workspace, home: f.home })
    const trash = new MemoryTrashAdapter()
    const result = await executeDestructivePlan(plan, fresh, { backupRoot: f.backups, trash })
    expect(result.completed).toHaveLength(1)
    expect(await readFile(join(f.home, 'Desktop', 'a-moved.txt'), 'utf8')).toBe('alpha')
    await expect(stat(join(f.home, 'Desktop', 'a.txt'))).rejects.toThrow()
    expect(result.backupDir).toContain('backups')
  })
})

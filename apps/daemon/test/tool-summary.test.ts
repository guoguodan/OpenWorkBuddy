import { describe, expect, it } from 'vitest'
import { summarizeToolResult, toToolFailure } from '../src/tool-summary.js'

describe('summarizeToolResult', () => {
  it('把工具失败投影为可回填的失败行', () => {
    const failure = toToolFailure(Object.assign(new Error('路径越界'), { code: 'PATH_ESCAPE' }))
    expect(failure).toEqual({ ok: false, error: '路径越界', code: 'PATH_ESCAPE' })
    expect(summarizeToolResult('read_file', failure)).toEqual({ ok: false, summary: '路径越界' })
  })

  it('shell 非零退出码算失败,并带上首行输出', () => {
    const r = summarizeToolResult('shell', { code: 2, stdout: 'boom\nmore', stderr: '' })
    expect(r.ok).toBe(false)
    expect(r.summary).toBe('退出码 2 · boom / more')
    expect(summarizeToolResult('shell', { code: 0, stdout: 'ok' }).ok).toBe(true)
  })

  it('read_file 展示字节数而不是正文', () => {
    expect(summarizeToolResult('read_file', '中文abc')).toEqual({ ok: true, summary: '9 字节' })
  })

  // 回归:通用字符串分支若前置,会吞掉 write_file 的专用分支
  it('write_file 保留原始摘要', () => {
    expect(summarizeToolResult('write_file', '已写入 a.ts')).toEqual({ ok: true, summary: '已写入 a.ts' })
  })

  it('插件工具的纯文本压成一行并截断', () => {
    expect(summarizeToolResult('p5-echo__echo', 'echo:p5-hello')).toEqual({
      ok: true,
      summary: 'echo:p5-hello'
    })
    const long = summarizeToolResult('p5-echo__echo', 'x'.repeat(200))
    expect(long.summary.length).toBe(141)
    expect(long.summary.endsWith('…')).toBe(true)
  })

  it('数组与 presented 结果各有可读摘要', () => {
    expect(summarizeToolResult('glob', []).summary).toBe('无结果')
    expect(summarizeToolResult('glob', ['a', 'b']).summary).toBe('2 项')
    expect(summarizeToolResult('present_files', { presented: 3 }).summary).toBe('已呈现 3 个文件')
  })

  it('load_skill 不泄露技能正文', () => {
    expect(summarizeToolResult('load_skill', '# 很长很长的技能正文').summary).toBe('技能已加载')
  })
})

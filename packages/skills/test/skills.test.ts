import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  discoverSkills,
  loadSkill,
  narrowTools,
  parseFrontmatter,
  validateSkillDir,
  renderSkillIndex
} from '../src/index.js'

let base: string

async function makeSkill(root: string, dir: string, frontmatter: string[], body: string) {
  const full = join(root, dir)
  await mkdir(full, { recursive: true })
  await writeFile(join(full, 'SKILL.md'), ['---', ...frontmatter, '---', '', body].join('\n'), 'utf8')
  return full
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'owb-skill-unit-'))
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('parseFrontmatter', () => {
  it('解析合法 frontmatter 与正文', () => {
    const { frontmatter, body } = parseFrontmatter('---\nname: demo\ndescription: 示例\n---\n\n# 正文\n')
    expect(frontmatter).toEqual({ name: 'demo', description: '示例' })
    expect(body).toContain('# 正文')
  })

  it('拒绝缺少结束分隔符的文件', () => {
    expect(() => parseFrontmatter('---\nname: demo\n')).toThrow(/未闭合/)
  })

  it('拒绝没有 frontmatter 的文件', () => {
    expect(() => parseFrontmatter('# 直接是正文')).toThrow(/缺少 frontmatter/)
  })
})

describe('discoverSkills', () => {
  it('project 覆盖同名的 user 技能', async () => {
    const projectRoot = join(base, 'project')
    const userRoot = join(base, 'user')
    await makeSkill(projectRoot, 'alpha', ['name: alpha', 'description: 项目级'], 'project body')
    await makeSkill(userRoot, 'alpha', ['name: alpha', 'description: 用户级'], 'user body')

    const { entries } = await discoverSkills([
      { path: projectRoot, scope: 'project' },
      { path: userRoot, scope: 'user' }
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]!.scope).toBe('project')
    expect(entries[0]!.description).toBe('项目级')
  })

  it('坏技能只记 issue,不影响其它技能', async () => {
    const root = join(base, 'roots')
    await makeSkill(root, 'good', ['name: good', 'description: 正常'], 'ok')
    await makeSkill(root, 'bad', ['name: different', 'description: 名字不符'], 'x')

    const { entries, issues } = await discoverSkills([{ path: root, scope: 'project' }])
    expect(entries.map((e) => e.name)).toEqual(['good'])
    expect(issues).toHaveLength(1)
    expect(issues[0]!.path).toContain('bad')
  })

  it('目录不存在时记 issue 而不是抛错', async () => {
    const { entries, issues } = await discoverSkills([
      { path: join(base, 'not-here'), scope: 'user' }
    ])
    expect(entries).toEqual([])
    expect(issues[0]!.reason).toMatch(/不存在或不可读/)
  })
})

describe('loadSkill', () => {
  it('解析字符串形式的 allowed-tools 并排序去重', async () => {
    const root = join(base, 'r')
    await makeSkill(root, 'demo', ['name: demo', 'description: 说明', 'allowed-tools: read_file, grep, read_file'], 'body')
    const { entries } = await discoverSkills([{ path: root, scope: 'project' }])
    const manifest = await loadSkill(entries[0]!)
    expect(manifest.allowedTools).toEqual(['grep', 'read_file'])
  })

  it('未声明 allowed-tools 时为 undefined', async () => {
    const root = join(base, 'r2')
    await makeSkill(root, 'demo', ['name: demo', 'description: 说明'], 'body')
    const { entries } = await discoverSkills([{ path: root, scope: 'project' }])
    const manifest = await loadSkill(entries[0]!)
    expect(manifest.allowedTools).toBeUndefined()
  })
})

describe('narrowTools', () => {
  it('取交集', () => {
    expect(narrowTools(['read_file', 'write_file', 'shell'], ['read_file', 'shell'])).toEqual([
      'read_file',
      'shell'
    ])
  })

  it('技能不得放宽模式限制', () => {
    expect(narrowTools(['read_file'], ['read_file', 'shell'])).toEqual(['read_file'])
    expect(narrowTools(['read_file'], ['write_file'])).toEqual([])
  })

  it('未声明时不收窄', () => {
    expect(narrowTools(['read_file', 'write_file'], undefined)).toEqual(['read_file', 'write_file'])
  })
})

describe('validateSkillDir', () => {
  it('拒绝包含明文凭据的技能', async () => {
    const root = join(base, 'cred')
    const dir = await makeSkill(root, 'leaky', ['name: leaky', 'description: 含密钥'], 'key: sk-abcdefghijklmnop')
    await expect(validateSkillDir(dir)).rejects.toThrow(/凭据/)
  })

  it('拒绝 name 与目录名不一致', async () => {
    const root = join(base, 'mismatch')
    const dir = await makeSkill(root, 'dir-name', ['name: other', 'description: 不符'], 'body')
    await expect(validateSkillDir(dir)).rejects.toThrow(/不一致/)
  })

  it('拒绝 description 超过 200 字符', async () => {
    const root = join(base, 'long')
    const dir = await makeSkill(root, 'long-desc', ['name: long-desc', `description: ${'x'.repeat(201)}`], 'body')
    await expect(validateSkillDir(dir)).rejects.toThrow(/200/)
  })

  it('正常技能通过校验并返回正文', async () => {
    const root = join(base, 'ok')
    const dir = await makeSkill(root, 'ok-skill', ['name: ok-skill', 'description: 正常'], '# 正文\n内容')
    const manifest = await validateSkillDir(dir)
    expect(manifest.name).toBe('ok-skill')
    expect(manifest.body).toContain('内容')
  })
})

describe('renderSkillIndex', () => {
  it('只输出 name 与 description,不含正文', async () => {
    const root = join(base, 'idx')
    await makeSkill(root, 'demo', ['name: demo', 'description: 简短描述'], '这是正文,不应出现')
    const { entries } = await discoverSkills([{ path: root, scope: 'project' }])
    const text = renderSkillIndex(entries)
    expect(text).toContain('demo: 简短描述')
    expect(text).not.toContain('这是正文')
    expect(text).toContain('load_skill')
  })

  it('没有技能时返回空字符串', () => {
    expect(renderSkillIndex([])).toBe('')
  })
})
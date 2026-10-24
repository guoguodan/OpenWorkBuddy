import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  discoverSkills,
  detectTriggerConflicts,
  loadSkill,
  runSkillScript,
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

describe('技能依赖与触发域', () => {
  it('发现结果暴露 requires/triggers/scripts/priority', async () => {
    const root = join(base, 'meta')
    await makeSkill(
      root,
      'writer',
      [
        'name: writer',
        'description: 写作',
        'requires: base',
        'triggers: docs, reports',
        'priority: 10',
        'scripts: build.js'
      ],
      'body'
    )
    const { entries } = await discoverSkills([{ path: root, scope: 'project' }])
    expect(entries[0]!.requires).toEqual(['base'])
    expect(entries[0]!.triggers).toEqual(['docs', 'reports'])
    expect(entries[0]!.priority).toBe(10)
    expect(entries[0]!.scripts).toEqual(['build.js'])
  })

  it('同域唯一最高优先级自动胜出', async () => {
    const root = join(base, 'conflict-win')
    await makeSkill(root, 'fast', ['name: fast', 'description: 快', 'triggers: docs', 'priority: 5'], 'a')
    await makeSkill(root, 'slow', ['name: slow', 'description: 慢', 'triggers: docs', 'priority: 1'], 'b')
    const { entries, conflicts } = await discoverSkills([{ path: root, scope: 'project' }])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.trigger).toBe('docs')
    expect(conflicts[0]!.skills).toEqual(['fast', 'slow'])
    expect(conflicts[0]!.winner).toBe('fast')

    const manual = detectTriggerConflicts(entries)
    expect(manual[0]!.reason).toContain('priority')
  })

  it('同域同优先级不静默选择', async () => {
    const root = join(base, 'conflict-tie')
    await makeSkill(root, 'alpha', ['name: alpha', 'description: A', 'triggers: docs'], 'a')
    await makeSkill(root, 'beta', ['name: beta', 'description: B', 'triggers: docs'], 'b')
    const { conflicts } = await discoverSkills([{ path: root, scope: 'project' }])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.winner).toBeNull()
    expect(conflicts[0]!.reason).toContain('需要用户选择')
  })

  it('不同触发域不产生冲突', async () => {
    const root = join(base, 'no-conflict')
    await makeSkill(root, 'alpha', ['name: alpha', 'description: A', 'triggers: docs'], 'a')
    await makeSkill(root, 'beta', ['name: beta', 'description: B', 'triggers: code'], 'b')
    const { conflicts } = await discoverSkills([{ path: root, scope: 'project' }])
    expect(conflicts).toEqual([])
  })

  it('validate 阶段缺失依赖给出修复建议', async () => {
    const root = join(base, 'missing-dep')
    const dir = await makeSkill(
      root,
      'child',
      ['name: child', 'description: 子技能', 'requires: nonexistent'],
      'body'
    )
    await expect(validateSkillDir(dir, { availableSkills: [] })).rejects.toThrow(/缺少依赖技能.*nonexistent/)
  })

  it('依赖已全部安装时 validate 通过', async () => {
    const root = join(base, 'dep-ok')
    const dir = await makeSkill(
      root,
      'child',
      ['name: child', 'description: 子技能', 'requires: base'],
      'body'
    )
    const manifest = await validateSkillDir(dir, { availableSkills: ['base'] })
    expect(manifest.requires).toEqual(['base'])
  })
})

describe('技能脚本', () => {
  it('执行声明脚本并传入参数,剥离凭据环境变量', async () => {
    const root = join(base, 'scripts-ok')
    const dir = await makeSkill(
      root,
      'runner',
      ['name: runner', 'description: 运行脚本', 'scripts: probe.js'],
      'body'
    )
    await mkdir(join(dir, 'scripts'), { recursive: true })
    await writeFile(
      join(dir, 'scripts', 'probe.js'),
      [
        "process.stdout.write(JSON.stringify({",
        '  args: process.argv.slice(2),',
        '  token: process.env.OPENWB_TEST_TOKEN ?? null,',
        '  workspace: process.env.OPENWB_WORKSPACE',
        '}))'
      ].join('\n'),
      'utf8'
    )
    process.env.OPENWB_TEST_TOKEN = 'must-not-leak'
    try {
      const { entries } = await discoverSkills([{ path: root, scope: 'project' }])
      const result = await runSkillScript(entries[0]!, {
        script: 'probe.js',
        args: ['--name', 'demo'],
        workspaceRoot: base
      })
      expect(result.code).toBe(0)
      const parsed = JSON.parse(result.stdout)
      expect(parsed.args).toEqual(['--name', 'demo'])
      expect(parsed.token).toBeNull()
      expect(parsed.workspace).toBe(base)
    } finally {
      delete process.env.OPENWB_TEST_TOKEN
    }
  })

  it('拒绝未声明的脚本', async () => {
    const root = join(base, 'scripts-undeclared')
    const dir = await makeSkill(root, 'runner', ['name: runner', 'description: 无脚本'], 'body')
    await mkdir(join(dir, 'scripts'), { recursive: true })
    await writeFile(join(dir, 'scripts', 'probe.js'), 'process.exit(0)\n', 'utf8')
    const { entries } = await discoverSkills([{ path: root, scope: 'project' }])
    await expect(runSkillScript(entries[0]!, { script: 'probe.js', workspaceRoot: base })).rejects.toThrow(
      /没有声明可执行脚本/
    )
  })

  it('拒绝路径穿越与 .bat 脚本', async () => {
    const root = join(base, 'scripts-traversal')
    const dir = await makeSkill(
      root,
      'runner',
      ['name: runner', 'description: 脚本', 'scripts: ok.js, evil.bat'],
      'body'
    )
    await mkdir(join(dir, 'scripts'), { recursive: true })
    await writeFile(join(dir, 'scripts', 'ok.js'), 'process.exit(0)\n', 'utf8')
    await writeFile(join(dir, 'scripts', 'evil.bat'), 'echo bad\n', 'utf8')
    const { entries } = await discoverSkills([{ path: root, scope: 'project' }])
    await expect(
      runSkillScript(entries[0]!, { script: '../SKILL.md', workspaceRoot: base })
    ).rejects.toThrow(/未在 SKILL.md 的 scripts 中声明/)
    await expect(runSkillScript(entries[0]!, { script: 'evil.bat', workspaceRoot: base })).rejects.toThrow(
      /不允许 \.bat/
    )
  })
})

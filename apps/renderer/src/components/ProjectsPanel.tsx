import { useCallback, useEffect, useState } from 'react'
import {
  IconCheck,
  IconFolder,
  IconPlus,
  IconSearch,
  IconTool,
  IconUsers,
  IconX
} from './Icons'

interface ProjectsPanelProps {
  onClose: () => void
  onNotify: (kind: 'system' | 'info', text: string) => void
  onOpenTask: (id: string) => void
  onCreateTask: (project: ProjectInfo) => void
  onChanged: () => void
}

type FormState = {
  name: string
  description: string
  instructions: string
  skillNames: string[]
}

const EMPTY_FORM: FormState = {
  name: '',
  description: '',
  instructions: '',
  skillNames: []
}

const PROJECT_TEMPLATES = [
  {
    id: 'custom',
    name: '自定义',
    desc: '',
    instruction: ''
  },
  {
    id: 'productRequirements',
    name: '产品需求全流程',
    desc: '从需求规划、PRD 到研发测试验收',
    instruction: `# 角色
你是一个产品需求全流程协同助手，服务于产品团队从需求规划到测试上线的完整周期。

## 阶段一：需求规划
- 帮助梳理目标用户、用户痛点、使用场景和业务目标
- 进行竞品调研、行业分析和现有方案对比
- 输出需求概要、需求池整理、优先级建议和待确认问题清单

## 阶段二：PRD 撰写
- 遵循 EARS 原则撰写需求描述
- 按标准结构输出：背景、目标、用户故事、功能清单、流程、交互、数据指标、验收标准
- 补充边界场景、异常状态、权限规则和埋点需求

## 阶段三：设计与研发评审
- 整理评审议题、待确认问题、关键依赖和风险点
- 帮助拆解页面清单、状态清单和交互边界

## 阶段四：研发跟进
- 将需求拆解为研发任务、子任务和依赖项
- 整理进度摘要和风险清单

## 阶段五：测试验收
- 基于 PRD 生成测试用例与回归范围
- 输出验收清单、上线风险清单

## 阶段六：上线复盘
- 总结目标达成、遗留问题和后续优化点

当信息不足时，先追问关键缺口，不要直接编造结论。`
  },
  {
    id: 'marketResearch',
    name: '市场调研与竞品分析',
    desc: '深度调研、竞品拆解、报告评审',
    instruction: `# 角色
你是一个市场调研与竞品分析协同助手。

## 阶段一：调研课题定义
- 澄清业务背景、核心问题、目标受众、决策用途和时间范围
- 区分行业趋势、竞品分析、用户需求、市场规模、商业模式和增长机会

## 阶段二：资料收集
- 明确信息来源、样本范围和验证方式
- 区分事实、推测与待验证信息

## 阶段三：竞品拆解
- 从定位、用户、功能、定价、渠道和增长策略对比
- 输出结构化竞品矩阵与关键差异

## 阶段四：报告产出
- 结论先行，给出证据、限制和行动建议

## 阶段五：结论评审
- 整理待确认问题和下一步验证计划`
  },
  {
    id: 'contentOperations',
    name: '内容运营工作台',
    desc: '从选题、写稿、审核到发布复盘',
    instruction: `# 角色
你是一个内容运营工作台协同助手。

## 阶段一：选题规划
- 明确内容目标、目标用户、发布平台、内容形式和转化目标
- 结合产品卖点、热点趋势与用户痛点生成选题池

## 阶段二：内容创作
- 给出结构大纲、核心观点和素材需求
- 保持品牌语气一致，避免空泛表达

## 阶段三：审核发布
- 检查事实、合规、敏感信息和平台规则

## 阶段四：数据复盘
- 分析曝光、点击、互动与转化，提炼可复用经验`
  },
  {
    id: 'teamKnowledgeBase',
    name: '团队知识库',
    desc: '持续沉淀 SOP、经验和 FAQ',
    instruction: `# 角色
你是一个团队知识库协同助手。

## 知识库初始化
- 明确目标、使用对象、内容范围、维护负责人和更新机制
- 建议分类结构：团队介绍、业务背景、SOP、技术方案、设计规范、FAQ、会议结论、复盘

## 日常沉淀
- 将零散经验整理为可检索、可执行的条目
- 标注适用范围、更新时间和负责人

## 质量维护
- 定期识别过期、冲突和重复内容
- 给出合并、归档或补充建议`
  },
  {
    id: 'projectDelivery',
    name: '项目交付',
    desc: '管理客户需求、计划、风险和周报',
    instruction: `# 角色
你是一个项目交付协同助手。

## 售前到交付交接
- 整理客户背景、业务诉求、关键联系人、决策链和已承诺事项
- 区分明确需求、销售承诺、内部判断和待验证信息

## 交付计划
- 拆解里程碑、负责人、依赖和验收标准

## 风险与变更
- 持续跟踪范围变更、延期风险和阻塞事项

## 周报与验收
- 输出进展摘要、风险清单和验收材料

涉及排期、资源和上线范围时，提醒找对应负责人确认。`
  },
  {
    id: 'bugTrackingQa',
    name: 'Bug 跟踪/测试验收',
    desc: '持续跟踪 Bug，统一测试用例和验收结论',
    instruction: `# 角色
你是一个 Bug 跟踪与测试验收协同助手。

## 测试准备
- 基于 PRD 或用户故事生成测试用例
- 覆盖正常、边界、异常、权限、兼容性和回归场景

## Bug 流转
- 规范化 Bug 描述：复现步骤、环境、实际结果、期望结果、影响范围
- 帮助判断阻断级别

## 回归验收
- 输出回归范围、验收清单和版本质量总结`
  }
] as const

type ProjectTemplateId = (typeof PROJECT_TEMPLATES)[number]['id']

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}

function dayText(iso: string | null): string {
  if (!iso) return '刚刚'
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return '刚刚'
  const diff = Date.now() - time
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`
  if (diff < 86_400_000) return `${Math.max(1, Math.floor(diff / 3_600_000))} 小时前`
  if (diff < 2_592_000_000) return `${Math.max(1, Math.floor(diff / 86_400_000))} 天前`
  return `${Math.max(1, Math.floor(diff / 2_592_000_000))} 个月前`
}

/**
 * 项目面板。
 *
 * 项目不是文件夹:它把项目指令、技能白名单和归属任务绑定到同一条运行链上。
 * 删除项目只解除任务归属,不会删除用户已经完成的任务。
 */
export function ProjectsPanel({ onClose, onNotify, onOpenTask, onCreateTask, onChanged }: ProjectsPanelProps) {
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [skills, setSkills] = useState<Array<{ name: string; description: string }>>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [working, setWorking] = useState<string | null>(null)
  const [templateId, setTemplateId] = useState<ProjectTemplateId>('custom')
  const [menuId, setMenuId] = useState<string | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await window.openwb.projects.list()
      setProjects(r.projects)
    } catch (err) {
      onNotify('system', `项目列表加载失败: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [onNotify])

  useEffect(() => {
    void refresh()
    void window.openwb.skills
      .list()
      .then((r) => setSkills(r.skills.map((skill) => ({ name: skill.name, description: skill.description }))))
      .catch(() => undefined)
  }, [refresh])

  const openCreate = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setTemplateId('custom')
    setFormOpen(true)
    setMenuId(null)
  }

  const openEdit = (project: ProjectInfo) => {
    setEditingId(project.id)
    setForm({
      name: project.name,
      description: project.description,
      instructions: project.instructions,
      skillNames: [...project.skillNames]
    })
    setTemplateId('custom')
    setFormOpen(true)
    setMenuId(null)
  }

  const save = async () => {
    if (!form.name.trim()) {
      onNotify('system', '请填写项目名称')
      return
    }
    setWorking(editingId ?? 'create')
    try {
      const payload: ProjectInputInfo = {
        name: form.name.trim(),
        description: form.description.trim(),
        instructions: form.instructions.trim(),
        skillNames: form.skillNames
      }
      if (editingId) await window.openwb.projects.update({ id: editingId, ...payload })
      else await window.openwb.projects.create(payload)
      setFormOpen(false)
      setEditingId(null)
      await refresh()
      onChanged()
      onNotify('info', editingId ? '项目已保存' : '项目已创建')
    } catch (err) {
      onNotify('system', `保存失败: ${(err as Error).message}`)
    } finally {
      setWorking(null)
    }
  }

  const patch = async (
    project: ProjectInfo,
    input: Partial<ProjectInputInfo> & { id: string },
    success?: string
  ) => {
    setWorking(project.id)
    try {
      await window.openwb.projects.update(input)
      await refresh()
      onChanged()
      if (success) onNotify('info', success)
    } catch (err) {
      onNotify('system', `更新失败: ${(err as Error).message}`)
    } finally {
      setWorking(null)
    }
  }

  const remove = async (project: ProjectInfo) => {
    setConfirmDeleteId(null)
    setWorking(project.id)
    try {
      await window.openwb.projects.remove(project.id)
      await refresh()
      onChanged()
      onNotify('info', `「${project.name}」已删除`)
    } catch (err) {
      onNotify('system', `删除失败: ${(err as Error).message}`)
    } finally {
      setWorking(null)
    }
  }

  const applyTemplate = (id: ProjectTemplateId) => {
    const template = PROJECT_TEMPLATES.find((item) => item.id === id)
    if (!template) return
    setTemplateId(id)
    setForm((prev) => ({
      ...prev,
      instructions: template.instruction,
      description: id === 'custom' ? '' : prev.description || template.desc
    }))
  }

  const rename = async () => {
    const project = projects.find((item) => item.id === renameId)
    const name = renameValue.trim()
    if (!project || !name) return
    setWorking(project.id)
    try {
      await window.openwb.projects.update({ id: project.id, name })
      setRenameId(null)
      setRenameValue('')
      await refresh()
      onChanged()
      onNotify('info', `已重命名为「${name}」`)
    } catch (err) {
      onNotify('system', `重命名失败: ${(err as Error).message}`)
    } finally {
      setWorking(null)
    }
  }

  const filtered = query.trim()
    ? projects.filter((project) =>
        [project.name, project.description, project.instructions, project.skillNames.join(' ')]
          .join(' ')
          .toLowerCase()
          .includes(query.trim().toLowerCase())
      )
    : projects

  return (
    <section className="owb-sheet owb-sheet--wide owb-projects" role="dialog" aria-modal="true" aria-label="项目">
      <header className="owb-sheet__header">
        <div>
          <h2>项目</h2>
          <p>多人协同，打造超级团队</p>
        </div>
        <div className="owb-sheet__header-actions">
          <button
            className="owb-sheet__primary owb-projects__new"
            onClick={() => (formOpen ? setFormOpen(false) : openCreate())}
            data-testid="project-create"
          >
            <IconPlus size={14} />
            新建项目
          </button>
          <button className="owb-icon-btn" onClick={onClose} aria-label="关闭项目">
            <IconX size={16} />
          </button>
        </div>
      </header>

      <div className="owb-sheet__body">
        {formOpen ? (
          <section className="owb-form" data-testid="project-form">
            <div className="owb-sheet__section">
              <h3>{editingId ? '编辑项目' : '新建项目'}</h3>
              {!editingId ? (
                <p className="owb-card__sub">共享团队上下文，让成员与 AI 协同共创</p>
              ) : null}
            </div>
            <label className="owb-field">
              <span>项目名称</span>
              <input
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="请输入项目名称"
                maxLength={120}
                data-testid="project-name"
              />
            </label>
            {!editingId ? (
              <div className="owb-sheet__section">
                <h3>项目模板</h3>
                <div className="owb-template-grid" data-testid="project-templates">
                  {PROJECT_TEMPLATES.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      className={`owb-template${templateId === template.id ? ' owb-template--on' : ''}`}
                      onClick={() => applyTemplate(template.id)}
                      data-testid={`project-template-${template.id}`}
                      aria-pressed={templateId === template.id}
                    >
                      <span className="owb-template__name">
                        {template.name}
                        {templateId === template.id ? <IconCheck size={12} /> : null}
                      </span>
                      {template.desc ? <span className="owb-template__desc">{template.desc}</span> : null}
                    </button>
                  ))}
                </div>
                <p className="owb-card__sub">切换模版会覆盖当前编辑内容</p>
              </div>
            ) : (
              <label className="owb-field">
                <span>项目简介</span>
                <input
                  value={form.description}
                  onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                  placeholder="一句话说明这个项目要交付什么"
                  maxLength={600}
                />
              </label>
            )}
            <label className="owb-field">
              <span>指令</span>
              <textarea
                value={form.instructions}
                onChange={(e) => setForm((prev) => ({ ...prev, instructions: e.target.value }))}
                placeholder="提供当前项目的背景信息和规范，让 WorkBuddy 的回复更精准、更符合要求。比如：项目目标、团队习惯、风格偏好、输出约束等"
                rows={7}
                maxLength={8000}
                data-testid="project-instructions"
              />
            </label>
            <div className="owb-sheet__section">
              <h3>技能</h3>
              {skills.length === 0 ? (
                <div className="owb-card__sub">当前没有可用技能。</div>
              ) : (
                <div className="owb-chip-row">
                  {skills.map((skill) => (
                    <button
                      key={skill.name}
                      type="button"
                      className={`owb-chip-button${form.skillNames.includes(skill.name) ? ' owb-chip-button--on' : ''}`}
                      aria-pressed={form.skillNames.includes(skill.name)}
                      title={skill.description}
                      onClick={() =>
                        setForm((prev) => ({ ...prev, skillNames: toggle(prev.skillNames, skill.name) }))
                      }
                    >
                      <IconTool size={11} />
                      {skill.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="owb-form__actions">
              <button
                className="owb-sheet__action"
                onClick={() => {
                  setFormOpen(false)
                  setEditingId(null)
                }}
              >
                取消
              </button>
              <button
                className="owb-sheet__primary"
                onClick={() => void save()}
                disabled={working !== null}
                data-testid="project-save"
              >
                {editingId ? '保存' : '确定'}
              </button>
            </div>
          </section>
        ) : (
          <>
            <div className="owb-projects__toolbar">
              <h3 className="owb-projects__section-title">我的项目</h3>
              <div className="owb-sheet__search owb-projects__search">
                <IconSearch size={15} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索项目"
                  aria-label="搜索项目"
                  data-testid="project-search"
                />
              </div>
            </div>

            {loading ? (
              <div className="owb-empty">项目加载中…</div>
            ) : filtered.length === 0 ? (
              <div className="owb-empty owb-projects__empty" data-testid="project-empty">
                <IconFolder size={30} />
                <strong>{projects.length === 0 ? '创建你的第一个项目' : '没有匹配的项目'}</strong>
                <span>
                  {projects.length === 0
                    ? '共享团队上下文，让成员与 AI 协同共创'
                    : '换个关键词试试。'}
                </span>
                {projects.length === 0 ? (
                  <button className="owb-sheet__primary" onClick={openCreate}>
                    <IconPlus size={13} />
                    新建项目
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="owb-project-grid" data-testid="project-grid">
                {filtered.map((project) => (
                  <article
                    key={project.id}
                    className="owb-project-tile"
                    data-testid="project-card"
                    data-project-id={project.id}
                  >
                    <button
                      className="owb-project-tile__main"
                      onClick={() => onCreateTask(project)}
                      aria-label={`打开项目 ${project.name}`}
                    >
                      <span className="owb-project-tile__icon">
                        <IconFolder size={18} />
                      </span>
                      <span className="owb-project-tile__body">
                        <span className="owb-project-tile__title-row">
                          <span className="owb-project-tile__title">{project.name}</span>
                          {project.pinnedAt ? (
                            <span className="owb-project-tile__badge">已置顶</span>
                          ) : null}
                        </span>
                        <span className="owb-project-tile__meta">
                          <span>添加于 {dayText(project.createdAt)}</span>
                          <span className="owb-project-tile__dot" />
                          <span>{project.stats.taskCount} 个任务</span>
                        </span>
                        {project.description ? (
                          <span className="owb-project-tile__desc">{project.description}</span>
                        ) : null}
                        <span className="owb-project-tile__members">
                          <IconUsers size={12} />
                          {project.skillNames.length > 0
                            ? `${project.skillNames.length} 项技能`
                            : '项目上下文已就绪'}
                        </span>
                      </span>
                    </button>
                    <div className="owb-project-tile__more">
                      <button
                        className="owb-icon-btn"
                        aria-label={`更多操作 ${project.name}`}
                        aria-haspopup="menu"
                        aria-expanded={menuId === project.id}
                        onClick={() => setMenuId((prev) => (prev === project.id ? null : project.id))}
                        data-testid="project-more"
                      >
                        <span className="owb-project-tile__ellipsis">···</span>
                      </button>
                      {menuId === project.id ? (
                        <div className="owb-menu owb-project-menu" role="menu" data-testid="project-menu">
                          <button
                            role="menuitem"
                            onClick={() => {
                              setRenameId(project.id)
                              setRenameValue(project.name)
                              setMenuId(null)
                            }}
                          >
                            重命名
                          </button>
                          <button
                            role="menuitem"
                            onClick={() => {
                              setMenuId(null)
                              void patch(
                                project,
                                { id: project.id, pinned: !project.pinnedAt },
                                project.pinnedAt
                                  ? `已取消置顶「${project.name}」`
                                  : `已置顶「${project.name}」`
                              )
                            }}
                          >
                            {project.pinnedAt ? '取消置顶' : '置顶'}
                          </button>
                          <button
                            role="menuitem"
                            className="owb-menu__danger"
                            onClick={() => {
                              setConfirmDeleteId(project.id)
                              setMenuId(null)
                            }}
                          >
                            删除
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {renameId ? (
        <div className="owb-modal-backdrop" role="presentation" onClick={() => setRenameId(null)}>
          <div
            className="owb-modal owb-project-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="重命名项目"
            onClick={(event) => event.stopPropagation()}
          >
            <h3>重命名项目</h3>
            <p className="owb-card__sub">
              原名称：{projects.find((item) => item.id === renameId)?.name ?? ''}
            </p>
            <input
              className="owb-project-dialog__input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder="输入新的项目名称"
              maxLength={120}
              autoFocus
              data-testid="project-rename-input"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void rename()
                if (e.key === 'Escape') setRenameId(null)
              }}
            />
            <div className="owb-project-dialog__actions">
              <button className="owb-sheet__action" onClick={() => setRenameId(null)}>
                取消
              </button>
              <button
                className="owb-sheet__primary"
                onClick={() => void rename()}
                disabled={!renameValue.trim() || working !== null}
                data-testid="project-rename-save"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmDeleteId ? (
        <div className="owb-modal-backdrop" role="presentation" onClick={() => setConfirmDeleteId(null)}>
          <div
            className="owb-modal owb-project-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="删除项目"
            onClick={(event) => event.stopPropagation()}
          >
            <h3>删除项目</h3>
            <p className="owb-card__sub">
              确定要删除此项目吗？删除后项目将被永久删除，包括项目内所有任务及产物，且不可恢复。
            </p>
            <div className="owb-project-dialog__actions">
              <button className="owb-sheet__action" onClick={() => setConfirmDeleteId(null)}>
                取消
              </button>
              <button
                className="owb-sheet__primary owb-project-dialog__danger"
                onClick={() => {
                  const project = projects.find((item) => item.id === confirmDeleteId)
                  if (project) void remove(project)
                }}
                disabled={working !== null}
                data-testid="project-delete-confirm"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {menuId ? (
        <button
          className="owb-menu-scrim"
          aria-label="关闭菜单"
          onClick={() => setMenuId(null)}
        />
      ) : null}
    </section>
  )
}

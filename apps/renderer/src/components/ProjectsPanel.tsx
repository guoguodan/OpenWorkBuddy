import { useCallback, useEffect, useState } from 'react'
import {
  IconCheck,
  IconFolder,
  IconPin,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTool,
  IconTrash,
  IconX
} from './Icons'

interface ProjectTaskInfo {
  id: string
  title: string
  updatedAt: string
  colleagueId: string | null
  pinnedAt: string | null
}

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

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}

function dayText(iso: string | null): string {
  if (!iso) return '暂无任务'
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return '暂无任务'
  return new Date(time).toLocaleDateString('zh-CN')
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
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [tasks, setTasks] = useState<Record<string, ProjectTaskInfo[]>>({})

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
    setFormOpen(true)
  }

  const openEdit = (project: ProjectInfo) => {
    setEditingId(project.id)
    setForm({
      name: project.name,
      description: project.description,
      instructions: project.instructions,
      skillNames: [...project.skillNames]
    })
    setFormOpen(true)
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
    if (!window.confirm(`删除项目「${project.name}」?项目里的任务会保留，但不再归属该项目。`)) return
    setWorking(project.id)
    try {
      await window.openwb.projects.remove(project.id)
      if (expandedId === project.id) setExpandedId(null)
      await refresh()
      onChanged()
      onNotify('info', '项目已删除，任务已保留')
    } catch (err) {
      onNotify('system', `删除失败: ${(err as Error).message}`)
    } finally {
      setWorking(null)
    }
  }

  const toggleTasks = async (project: ProjectInfo) => {
    if (expandedId === project.id) {
      setExpandedId(null)
      return
    }
    setExpandedId(project.id)
    try {
      const r = await window.openwb.projects.tasks(project.id)
      setTasks((prev) => ({ ...prev, [project.id]: r.tasks }))
    } catch (err) {
      onNotify('system', `项目任务加载失败: ${(err as Error).message}`)
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
    <section className="owb-sheet owb-sheet--wide" role="dialog" aria-modal="true" aria-label="项目">
      <header className="owb-sheet__header">
        <div>
          <h2>
            项目 <span className="owb-beta">BETA</span>
          </h2>
          <p>把目标、项目指令与技能约束放在一起，让同一项目的任务共享上下文</p>
        </div>
        <div className="owb-sheet__header-actions">
          <button
            className="owb-sheet__primary"
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
              <p className="owb-card__sub">项目指令会进入每轮任务的系统提示词；技能白名单会收窄本轮可用能力。</p>
            </div>
            <label className="owb-field">
              <span>项目名称</span>
              <input
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="例如：企业级 AI 工作台"
                maxLength={120}
                data-testid="project-name"
              />
            </label>
            <label className="owb-field">
              <span>项目简介</span>
              <input
                value={form.description}
                onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="一句话说明这个项目要交付什么"
                maxLength={600}
              />
            </label>
            <label className="owb-field">
              <span>项目指令</span>
              <textarea
                value={form.instructions}
                onChange={(e) => setForm((prev) => ({ ...prev, instructions: e.target.value }))}
                placeholder="例如：所有方案先对照竞品，再给出取舍；结论必须带依据。"
                rows={4}
                maxLength={8000}
              />
            </label>
            <div className="owb-sheet__section">
              <h3>技能约束</h3>
              {skills.length === 0 ? (
                <div className="owb-card__sub">当前没有可用技能。技能加入工作区后可在这里设置项目白名单。</div>
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
              <p className="owb-card__sub">选择后，项目内任务只能使用这些技能；同时指定助理时取两者交集。</p>
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
                {editingId ? '保存' : '创建'}
              </button>
            </div>
          </section>
        ) : (
          <>
            <div className="owb-sheet__search">
              <IconSearch size={15} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索项目名称、简介或技能"
                aria-label="搜索项目"
                data-testid="project-search"
              />
            </div>

            {loading ? (
              <div className="owb-empty">加载中…</div>
            ) : filtered.length === 0 ? (
              <div className="owb-empty" data-testid="project-empty">
                <IconFolder size={30} />
                <strong>{projects.length === 0 ? '还没有项目' : '没有匹配的项目'}</strong>
                <span>{projects.length === 0 ? '新建项目，把相关任务与约束组织在一起。' : '换个关键词试试。'}</span>
              </div>
            ) : (
              <div className="owb-card-list">
                {filtered.map((project) => (
                  <article
                    key={project.id}
                    className="owb-card owb-project-card"
                    data-testid="project-card"
                    data-project-id={project.id}
                  >
                    <div className="owb-card__head">
                      <div className="owb-card__title owb-card__title--colleague">
                        <span className="owb-card__icon">
                          <IconFolder size={17} />
                        </span>
                        <span>
                          {project.name}
                          {project.pinnedAt ? (
                            <span className="owb-status owb-status--pinned">
                              <IconPin size={10} /> 置顶
                            </span>
                          ) : null}
                          <span className="owb-status">{project.stats.taskCount} 个任务</span>
                        </span>
                      </div>
                      <div className="owb-card__actions">
                        <button
                          className="owb-icon-btn"
                          onClick={() =>
                            void patch(
                              project,
                              { id: project.id, pinned: !project.pinnedAt },
                              project.pinnedAt ? '已取消置顶项目' : '已置顶项目'
                            )
                          }
                          disabled={working !== null}
                          aria-label={project.pinnedAt ? `取消置顶 ${project.name}` : `置顶 ${project.name}`}
                        >
                          <IconPin size={14} />
                        </button>
                        <button
                          className="owb-icon-btn"
                          onClick={() => openEdit(project)}
                          disabled={working !== null}
                          aria-label={`编辑项目 ${project.name}`}
                        >
                          编辑
                        </button>
                        <button
                          className="owb-icon-btn owb-icon-btn--danger"
                          onClick={() => void remove(project)}
                          disabled={working !== null}
                          aria-label={`删除项目 ${project.name}`}
                        >
                          <IconTrash size={14} />
                        </button>
                      </div>
                    </div>
                    {project.description ? <p className="owb-card__text">{project.description}</p> : null}
                    {project.instructions ? (
                      <div className="owb-card__sub">项目指令：{project.instructions}</div>
                    ) : null}
                    {project.skillNames.length > 0 ? (
                      <div className="owb-chip-row">
                        {project.skillNames.map((name) => (
                          <span key={name} className="owb-chip" data-testid="project-skill">
                            <IconTool size={11} />
                            {name}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="owb-card__sub">技能：沿用模式默认能力</div>
                    )}
                    <div className="owb-card__sub owb-colleague-meta">
                      <span>最近活动 {dayText(project.stats.lastActiveAt)}</span>
                      <span>创建于 {dayText(project.createdAt)}</span>
                    </div>
                    <div className="owb-card__actions owb-project-card__actions">
                      <button
                        className="owb-sheet__action"
                        onClick={() => void toggleTasks(project)}
                        data-testid="project-toggle-tasks"
                      >
                        {expandedId === project.id ? '收起任务' : '查看任务'}
                      </button>
                      <button
                        className="owb-sheet__primary"
                        onClick={() => onCreateTask(project)}
                        disabled={working !== null}
                        data-testid="project-new-task"
                      >
                        <IconPlus size={13} />
                        在项目中新建任务
                      </button>
                    </div>
                    {expandedId === project.id ? (
                      <div className="owb-project-tasks" data-testid="project-tasks">
                        {(tasks[project.id] ?? []).length === 0 ? (
                          <div className="owb-card__sub">这个项目还没有任务。</div>
                        ) : (
                          (tasks[project.id] ?? []).map((task) => (
                            <button
                              key={task.id}
                              className="owb-project-task"
                              onClick={() => onOpenTask(task.id)}
                              data-testid="project-task"
                              data-conversation-id={task.id}
                            >
                              <span>{task.title}</span>
                              <span>{dayText(task.updatedAt)}</span>
                            </button>
                          ))
                        )}
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            )}

            <button className="owb-sheet__action owb-project-refresh" onClick={() => void refresh()}>
              <IconRefresh size={13} />
              刷新
            </button>
          </>
        )}
      </div>
    </section>
  )
}

import { useEffect, useState } from 'react'
import {
  IconBriefcase,
  IconCheck,
  IconClock,
  IconPause,
  IconPin,
  IconPlay,
  IconRefresh,
  IconTrash,
  IconUsers,
  IconX
} from '../Icons'
import {
  ColleagueAvatar,
  colleagueState,
  formatDateTime,
  stateLabel,
  usageText,
  visibilityName
} from './shared'

type TaskRecord = Awaited<ReturnType<Window['openwb']['colleagues']['tasks']>>['tasks'][number]

interface ColleagueDetailProps {
  colleague: ColleagueInfo
  working: boolean
  onClose: () => void
  onEdit: () => void
  onChat: () => void
  onOpenTask: (id: string) => void
  onTogglePin: () => void
  onTogglePause: () => void
  onDelete: () => void
  onNotify: (kind: 'system' | 'info', text: string) => void
  onTaskRemoved: () => void
}

const SOURCE_LABEL: Record<TaskRecord['source'], string> = {
  personal: '个人委派',
  channel: '频道任务',
  project: '项目任务'
}

const STATUS_LABEL: Record<TaskRecord['status'], string> = {
  inProgress: '进行中',
  idle: '空闲',
  completed: '已完成',
  failed: '异常'
}

/**
 * 助理档案详情。
 *
 * 任务列表走 colleagues.tasks 的真实会话聚合;删除会话同样走 conversation.delete,
 * 因此这里不会造出"界面上消失了但运行时还能继续跑"的孤立任务。
 */
export function ColleagueDetail({
  colleague,
  working,
  onClose,
  onEdit,
  onChat,
  onOpenTask,
  onTogglePin,
  onTogglePause,
  onDelete,
  onNotify,
  onTaskRemoved
}: ColleagueDetailProps) {
  const [tab, setTab] = useState<'home' | 'tasks'>('home')
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [deleteTask, setDeleteTask] = useState<TaskRecord | null>(null)

  const loadTasks = async () => {
    try {
      const result = await window.openwb.colleagues.tasks(colleague.id)
      setTasks(result.tasks)
    } catch (err) {
      onNotify('system', `任务列表加载失败: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setLoading(true)
    void loadTasks()
    // colleague.id 变化时才重新取任务;同一助理的保存由父级刷新 stats。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colleague.id])

  const removeTask = async () => {
    if (!deleteTask) return
    try {
      await window.openwb.conversation.remove(deleteTask.id)
      setDeleteTask(null)
      await loadTasks()
      onTaskRemoved()
      onNotify('info', '会话已从对话任务中删除')
    } catch (err) {
      onNotify('system', `删除会话失败: ${(err as Error).message}`)
    }
  }

  const state = colleagueState(colleague)
  const paused = colleague.status === 'paused'

  return (
    <div className="owb-collab-detail-overlay" role="presentation" onClick={onClose}>
      <section
        className="owb-collab-detail"
        role="dialog"
        aria-modal="true"
        aria-label={`${colleague.name} 助理档案`}
        onClick={(event) => event.stopPropagation()}
      >
        <aside className="owb-collab-detail__nav">
          <header>
            <span>助理档案</span>
            <button className="owb-icon-btn" onClick={onClose} aria-label="关闭助理档案">
              <IconX size={15} />
            </button>
          </header>
          <div className="owb-collab-detail__identity">
            <ColleagueAvatar item={colleague} size={52} />
            <strong>{colleague.name}</strong>
            <span>{colleague.title || '助理'}</span>
            <i className={`owb-collab-state owb-collab-state--${state}`}>{stateLabel(state)}</i>
          </div>
          <nav>
            <button className={tab === 'home' ? 'is-on' : ''} onClick={() => setTab('home')}>
              首页
            </button>
            <button className={tab === 'tasks' ? 'is-on' : ''} onClick={() => setTab('tasks')}>
              对话任务
              <span>{tasks.length}</span>
            </button>
          </nav>
          <div className="owb-collab-detail__nav-actions">
            <button onClick={onChat} disabled={paused || working}>
              发起对话
            </button>
            <button onClick={onEdit} disabled={working}>
              编辑档案
            </button>
            <button onClick={onTogglePin} disabled={working}>
              <IconPin size={13} />
              {colleague.pinnedAt ? '取消置顶' : '置顶'}
            </button>
            <button onClick={onTogglePause} disabled={working}>
              {paused ? <IconPlay size={13} /> : <IconPause size={13} />}
              {paused ? '恢复助理' : '暂停助理'}
            </button>
            <button className="is-danger" onClick={onDelete} disabled={working}>
              <IconTrash size={13} />
              删除助理
            </button>
          </div>
        </aside>

        <div className="owb-collab-detail__main">
          {tab === 'home' ? (
            <>
              <header className="owb-collab-detail__heading">
                <div>
                  <h2>首页</h2>
                  <p>{colleague.description || '还没有填写助理简介。'}</p>
                </div>
                <button className="owb-collab-chat-btn" onClick={onChat} disabled={paused || working} data-testid="colleague-detail-chat">
                  对话
                </button>
              </header>

              <section className="owb-collab-detail__section">
                <h3>任务概览</h3>
                <div className="owb-collab-metrics">
                  <div>
                    <span>进行中</span>
                    <strong>{tasks.filter((task) => task.status === 'inProgress').length}</strong>
                  </div>
                  <div>
                    <span>已完成</span>
                    <strong>{colleague.stats.completedTasks}</strong>
                  </div>
                  <div>
                    <span>异常</span>
                    <strong>{colleague.stats.failedTasks}</strong>
                  </div>
                  <div>
                    <span>会话总数</span>
                    <strong>{colleague.stats.conversationCount}</strong>
                  </div>
                </div>
              </section>

              <div className="owb-collab-detail__grid">
                <section className="owb-collab-detail__card">
                  <h3>状态</h3>
                  <dl>
                    <div>
                      <dt>当前状态</dt>
                      <dd>{stateLabel(state)}</dd>
                    </div>
                    <div>
                      <dt>可见范围</dt>
                      <dd>{visibilityName(colleague.visibility)}</dd>
                    </div>
                    <div>
                      <dt>长期记忆</dt>
                      <dd data-testid="colleague-detail-memory">{colleague.memoryEnabled ? '已开启' : '已关闭'}</dd>
                    </div>
                    <div>
                      <dt>累计用量</dt>
                      <dd>{usageText(colleague.stats.tokenUsage)}</dd>
                    </div>
                  </dl>
                </section>

                <section className="owb-collab-detail__card">
                  <h3>最近活跃</h3>
                  <ul className="owb-collab-activity">
                    <li>
                      <IconClock size={14} />
                      <span>
                        最近活动
                        <small>{formatDateTime(colleague.stats.lastActiveAt ?? colleague.updatedAt)}</small>
                      </span>
                    </li>
                    <li>
                      <IconBriefcase size={14} />
                      <span>
                        已完成任务
                        <small>{colleague.stats.completedTasks} 项</small>
                      </span>
                    </li>
                    <li>
                      <IconRefresh size={14} />
                      <span>
                        最近更新
                        <small>{formatDateTime(colleague.updatedAt)}</small>
                      </span>
                    </li>
                  </ul>
                </section>
              </div>

              <section className="owb-collab-detail__section">
                <h3>能力配置</h3>
                <div className="owb-collab-capabilities">
                  <div>
                    <span>技能</span>
                    <strong>{colleague.skillNames.length > 0 ? colleague.skillNames.join('、') : '未绑定（全部可见）'}</strong>
                  </div>
                  <div>
                    <span>连接器</span>
                    <strong>{colleague.connectorNames.length > 0 ? colleague.connectorNames.join('、') : '未绑定'}</strong>
                  </div>
                  <div>
                    <span>频道</span>
                    <strong>{colleague.channelIds.length > 0 ? `${colleague.channelIds.length} 个频道` : '未绑定'}</strong>
                  </div>
                </div>
              </section>
            </>
          ) : (
            <>
              <header className="owb-collab-detail__heading">
                <div>
                  <h2>对话任务</h2>
                  <p>这里展示委派给 {colleague.name} 的任务执行情况。</p>
                </div>
                <button className="owb-collab-chat-btn" onClick={onChat} disabled={paused || working}>
                  新建任务
                </button>
              </header>
              {loading ? (
                <div className="owb-collab-empty">加载中…</div>
              ) : tasks.length === 0 ? (
                <div className="owb-collab-empty">
                  <IconUsers size={26} />
                  <strong>还没有对话任务</strong>
                  <span>发起一次对话后，任务会出现在这里。</span>
                </div>
              ) : (
                <div className="owb-collab-table-wrap">
                  <table className="owb-collab-table">
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>名称</th>
                        <th>来源</th>
                        <th>状态</th>
                        <th>创建时间</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tasks.map((task) => (
                        <tr key={task.id}>
                          <td>
                            <code>{task.id.slice(-6)}</code>
                          </td>
                          <td>
                            <button className="owb-collab-table__title" onClick={() => onOpenTask(task.id)}>
                              {task.title || '未命名对话'}
                            </button>
                          </td>
                          <td>{SOURCE_LABEL[task.source]}</td>
                          <td>
                            <span className={`owb-collab-task-state owb-collab-task-state--${task.status}`}>
                              {STATUS_LABEL[task.status]}
                            </span>
                          </td>
                          <td>{formatDateTime(task.createdAt)}</td>
                          <td>
                            <div className="owb-collab-table__actions">
                              <button onClick={() => onOpenTask(task.id)}>打开</button>
                              <button onClick={() => setDeleteTask(task)} aria-label={`删除会话 ${task.title}`}>
                                <IconTrash size={13} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {deleteTask ? (
        <div
          className="owb-modal-backdrop owb-collab-confirm-layer"
          role="presentation"
          onClick={(event) => {
            event.stopPropagation()
            setDeleteTask(null)
          }}
        >
          <div
            className="owb-modal owb-project-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="删除会话"
            onClick={(event) => event.stopPropagation()}
          >
            <h3>删除会话</h3>
            <p className="owb-card__sub">确定从对话任务中删除「{deleteTask.title || '未命名对话'}」吗？</p>
            <p className="owb-card__sub">删除后该会话不再出现在对话任务列表中。</p>
            <div className="owb-project-dialog__actions">
              <button className="owb-sheet__action" onClick={() => setDeleteTask(null)}>
                取消
              </button>
              <button
                className="owb-sheet__primary owb-project-dialog__danger"
                onClick={() => void removeTask()}
                data-testid="colleague-task-delete-confirm"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

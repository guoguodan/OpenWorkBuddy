import { useCallback, useEffect, useState } from 'react'
import { IconCalendar, IconClock, IconPause, IconPlay, IconPlus, IconTrash, IconX } from './Icons'

interface AutomationPanelProps {
  onClose: () => void
  onNotify: (kind: 'system' | 'info', text: string) => void
}

const WEEKDAYS = [
  { value: 'MO', label: '一' },
  { value: 'TU', label: '二' },
  { value: 'WE', label: '三' },
  { value: 'TH', label: '四' },
  { value: 'FR', label: '五' },
  { value: 'SA', label: '六' },
  { value: 'SU', label: '日' }
]

function scheduleText(item: AutomationInfo): string {
  if (item.scheduleType === 'once') {
    if (!item.scheduledAt) return '单次执行 · 未设置时间'
    const at = new Date(item.scheduledAt)
    const when = Number.isNaN(at.getTime()) ? item.scheduledAt : at.toLocaleString('zh-CN')
    return `单次 · ${when}`
  }
  const rule = item.rrule ?? ''
  const freq = /FREQ=DAILY/i.test(rule)
    ? '每天'
    : /FREQ=WEEKLY/i.test(rule)
      ? '每周'
      : /FREQ=MONTHLY/i.test(rule)
        ? '每月'
        : rule || '重复'
  const time = /BYHOUR=(\d+)/i.exec(rule)?.[1]
  const minute = /BYMINUTE=(\d+)/i.exec(rule)?.[1]
  const clock = time ? ` ${time.padStart(2, '0')}:${(minute ?? '0').padStart(2, '0')}` : ''
  return `${freq}${clock}`
}

function toRrule(freq: 'DAILY' | 'WEEKLY', days: string[], hour: number, minute: number): string {
  const parts = [`FREQ=${freq}`, `BYHOUR=${hour}`, `BYMINUTE=${minute}`]
  if (freq === 'WEEKLY' && days.length > 0) parts.push(`BYDAY=${days.join(',')}`)
  return parts.join(';')
}

/**
 * 定时任务面板。
 *
 * 表单只暴露真实支持的三类:单次、每天、每周。保存后立刻回到列表,
 * 是否启用与下次运行时间都显示在卡片上,避免"建了但不知道会不会跑"。
 */
export function AutomationPanel({ onClose, onNotify }: AutomationPanelProps) {
  const [items, setItems] = useState<AutomationInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [freq, setFreq] = useState<'ONCE' | 'DAILY' | 'WEEKLY'>('DAILY')
  const [days, setDays] = useState<string[]>(['MO', 'TU', 'WE', 'TH', 'FR'])
  const [hour, setHour] = useState(9)
  const [minute, setMinute] = useState(0)
  const [scheduledAt, setScheduledAt] = useState('')

  const refresh = useCallback(async () => {
    try {
      const r = await window.openwb.automation.list()
      setItems(r.automations)
    } catch (err) {
      onNotify('system', `定时任务加载失败: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [onNotify])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const create = async () => {
    if (!name.trim() || !prompt.trim()) {
      onNotify('system', '请填写任务名称与执行指令')
      return
    }
    if (freq === 'ONCE' && !scheduledAt) {
      onNotify('system', '单次任务需要选择执行时间')
      return
    }
    setWorking('create')
    try {
      await window.openwb.automation.create({
        name: name.trim(),
        prompt: prompt.trim(),
        scheduleType: freq === 'ONCE' ? 'once' : 'rrule',
        ...(freq === 'ONCE'
          ? { scheduledAt: new Date(scheduledAt).toISOString() }
          : {
              rrule: toRrule(freq, days, hour, minute),
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
            }),
        modeId: 'craft'
      })
      setName('')
      setPrompt('')
      setCreating(false)
      await refresh()
      onNotify('info', '定时任务已创建')
    } catch (err) {
      onNotify('system', `创建失败: ${(err as Error).message}`)
    } finally {
      setWorking(null)
    }
  }

  const toggle = async (item: AutomationInfo) => {
    setWorking(item.id)
    try {
      await window.openwb.automation.toggle({ id: item.id, enabled: !item.enabled })
      await refresh()
    } catch (err) {
      onNotify('system', `切换失败: ${(err as Error).message}`)
    } finally {
      setWorking(null)
    }
  }

  const remove = async (item: AutomationInfo) => {
    if (!window.confirm(`删除定时任务「${item.name}」?`)) return
    setWorking(item.id)
    try {
      await window.openwb.automation.remove(item.id)
      await refresh()
    } catch (err) {
      onNotify('system', `删除失败: ${(err as Error).message}`)
    } finally {
      setWorking(null)
    }
  }

  return (
    <section className="owb-sheet owb-sheet--wide" role="dialog" aria-modal="true" aria-label="定时任务">
      <header className="owb-sheet__header">
        <div>
          <h2>定时任务</h2>
          <p>让 Buddy 按计划自动执行，结果会出现在任务列表</p>
        </div>
        <div className="owb-sheet__header-actions">
          <button className="owb-sheet__primary" onClick={() => setCreating((v) => !v)}>
            <IconPlus size={14} />
            新建定时任务
          </button>
          <button className="owb-icon-btn" onClick={onClose} aria-label="关闭定时任务">
            <IconX size={16} />
          </button>
        </div>
      </header>

      <div className="owb-sheet__body">
        {creating ? (
          <section className="owb-form">
            <label className="owb-field">
              <span>任务名称</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：每日行业早报"
                maxLength={80}
              />
            </label>
            <label className="owb-field">
              <span>执行指令</span>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="告诉 Buddy 每次要做什么，例如：汇总今天 AI 行业的重要变化并输出简报"
                rows={3}
                maxLength={4000}
              />
            </label>
            <div className="owb-field">
              <span>执行频率</span>
              <div className="owb-segmented" role="radiogroup" aria-label="执行频率">
                {[
                  { id: 'ONCE' as const, label: '单次' },
                  { id: 'DAILY' as const, label: '每天' },
                  { id: 'WEEKLY' as const, label: '每周' }
                ].map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={freq === item.id}
                    className={`owb-segmented__item${freq === item.id ? ' owb-segmented__item--on' : ''}`}
                    onClick={() => setFreq(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            {freq === 'ONCE' ? (
              <label className="owb-field">
                <span>执行时间</span>
                <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
              </label>
            ) : (
              <>
                {freq === 'WEEKLY' ? (
                  <div className="owb-field">
                    <span>星期</span>
                    <div className="owb-weekdays">
                      {WEEKDAYS.map((day) => (
                        <button
                          key={day.value}
                          type="button"
                          aria-pressed={days.includes(day.value)}
                          className={`owb-weekday${days.includes(day.value) ? ' owb-weekday--on' : ''}`}
                          onClick={() =>
                            setDays((list) =>
                              list.includes(day.value) ? list.filter((x) => x !== day.value) : [...list, day.value]
                            )
                          }
                        >
                          {day.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="owb-field">
                  <span>执行时间</span>
                  <div className="owb-time">
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={hour}
                      onChange={(e) => setHour(Math.min(23, Math.max(0, Number(e.target.value))))}
                      aria-label="小时"
                    />
                    <span>:</span>
                    <input
                      type="number"
                      min={0}
                      max={59}
                      value={minute}
                      onChange={(e) => setMinute(Math.min(59, Math.max(0, Number(e.target.value))))}
                      aria-label="分钟"
                    />
                  </div>
                </div>
              </>
            )}
            <div className="owb-form__actions">
              <button className="owb-sheet__action" onClick={() => setCreating(false)} disabled={working !== null}>
                取消
              </button>
              <button className="owb-sheet__primary" onClick={() => void create()} disabled={working !== null}>
                {working === 'create' ? '创建中…' : '创建'}
              </button>
            </div>
          </section>
        ) : null}

        {loading ? (
          <div className="owb-empty">加载中…</div>
        ) : items.length === 0 ? (
          <div className="owb-empty">
            <IconCalendar size={30} />
            <strong>还没有定时任务</strong>
            <span>创建后，Buddy 会按计划自动开始一轮任务。</span>
          </div>
        ) : (
          <div className="owb-card-list">
            {items.map((item) => (
              <article key={item.id} className={`owb-card${item.enabled ? '' : ' owb-card--off'}`}>
                <div className="owb-card__head">
                  <div className="owb-card__title">
                    <IconClock size={16} />
                    <span>{item.name}</span>
                  </div>
                  <span className={`owb-badge${item.enabled ? ' owb-badge--on' : ''}`}>
                    {item.enabled ? '已启用' : '已暂停'}
                  </span>
                </div>
                <div className="owb-card__meta">{scheduleText(item)}</div>
                <p className="owb-card__text">{item.prompt}</p>
                <div className="owb-card__sub">
                  {item.nextRunAt
                    ? `下次运行：${new Date(item.nextRunAt).toLocaleString('zh-CN')}`
                    : '暂无下次运行时间'}
                  {item.lastStatus ? ` · 上次：${item.lastStatus}` : ''}
                </div>
                <div className="owb-card__actions">
                  <button className="owb-sheet__action" onClick={() => void toggle(item)} disabled={working !== null}>
                    {item.enabled ? <IconPause size={13} /> : <IconPlay size={13} />}
                    {item.enabled ? '暂停' : '启用'}
                  </button>
                  <button
                    className="owb-sheet__action owb-sheet__action--danger"
                    onClick={() => void remove(item)}
                    disabled={working !== null}
                  >
                    <IconTrash size={13} />
                    删除
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

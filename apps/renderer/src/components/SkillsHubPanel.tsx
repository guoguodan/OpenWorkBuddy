import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconBriefcase,
  IconGrid,
  IconLoader,
  IconPin,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSparkle,
  IconTool,
  IconX
} from './Icons'

export interface HubSkill {
  name: string
  description: string
  scope: string
  enabled: boolean
  requires?: string[]
  triggers?: string[]
  priority?: number
  scripts?: string[]
  missingDependencies?: string[]
  disabledDependencies?: string[]
}

export interface SkillConflict {
  trigger: string
  skills: string[]
  winner: string | null
  reason: string
}

type HubTab = 'experts' | 'skills' | 'connectors'
type SkillTab = 'market' | 'installed'
type MarketTab = 'recommend' | 'suite' | 'knot' | 'enterprise'
type ConnectorTab = 'official' | 'enterprise'

interface SkillsHubPanelProps {
  initialTab?: HubTab
  onClose: () => void
  onNotify: (kind: 'system' | 'info', text: string) => void
  onSkillsChanged: (skills: HubSkill[]) => void
  onUseExpert: (expert: { id: string; name: string }) => void
}

const STATE_LABEL: Record<PluginSnapshotInfo['state'], string> = {
  unloaded: '未启动',
  starting: '连接中...',
  ready: '已连接',
  reconnecting: '连接中...',
  disabled: '未连接',
  crashed: '连接失败'
}

const SCOPES: Array<{ id: string; label: string }> = [
  { id: 'project', label: '项目技能' },
  { id: 'user', label: '用户技能' }
]

function scopeLabel(scope: string): string {
  return SCOPES.find((item) => item.id === scope)?.label ?? '内置技能'
}

function stateTone(state: PluginSnapshotInfo['state']): string {
  if (state === 'ready') return 'owb-hub__dot--ok'
  if (state === 'starting' || state === 'reconnecting') return 'owb-hub__dot--busy'
  if (state === 'crashed') return 'owb-hub__dot--danger'
  return 'owb-hub__dot--idle'
}

function matches(text: string, query: string): boolean {
  if (!query) return true
  return text.toLowerCase().includes(query.toLowerCase())
}

/**
 * 专家·技能·连接器工作台。
 *
 * 页签与分组对齐真实产品;每张卡片的操作都对应真实能力:
 * 技能开关影响 daemon 的技能索引,连接器开关影响 MCP 进程,专家来自插件清单。
 */
export function SkillsHubPanel({
  initialTab = 'skills',
  onClose,
  onNotify,
  onSkillsChanged,
  onUseExpert
}: SkillsHubPanelProps) {
  const [tab, setTab] = useState<HubTab>(initialTab)
  const [skillTab, setSkillTab] = useState<SkillTab>('installed')
  const [marketTab, setMarketTab] = useState<MarketTab>('recommend')
  const [connectorTab, setConnectorTab] = useState<ConnectorTab>('official')
  const [query, setQuery] = useState('')
  const [skills, setSkills] = useState<HubSkill[]>([])
  const [skillConflicts, setSkillConflicts] = useState<SkillConflict[]>([])
  const [skillIssues, setSkillIssues] = useState<Array<{ path: string; reason: string }>>([])
  const [plugins, setPlugins] = useState<PluginSnapshotInfo[]>([])
  const [pinned, setPinned] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ kind: 'skill' | 'connector' | 'expert'; name: string } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<{ name: string; label: string } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    try {
      const [skillResult, pluginResult, settingsResult] = await Promise.all([
        window.openwb.skills.list(),
        window.openwb.plugins.list(),
        window.openwb.settings.get()
      ])
      const next = skillResult.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        scope: skill.scope,
        enabled: skill.enabled !== false,
        ...(skill.requires ? { requires: skill.requires } : {}),
        ...(skill.triggers ? { triggers: skill.triggers } : {}),
        ...(skill.priority !== undefined ? { priority: skill.priority } : {}),
        ...(skill.scripts ? { scripts: skill.scripts } : {}),
        ...(skill.missingDependencies ? { missingDependencies: skill.missingDependencies } : {}),
        ...(skill.disabledDependencies ? { disabledDependencies: skill.disabledDependencies } : {})
      }))
      setSkills(next)
      setSkillConflicts(skillResult.conflicts ?? [])
      setSkillIssues(skillResult.issues ?? [])
      onSkillsChanged(next)
      setPlugins(pluginResult.plugins)
      setPinned(settingsResult.settings.pinnedSkills ?? [])
    } catch (err) {
      onNotify('system', `工作台加载失败: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [onNotify, onSkillsChanged])

  useEffect(() => {
    void refresh()
    return window.openwb.conversation.onEvent((raw: unknown) => {
      const event = raw as { type?: string }
      if (event.type === 'plugin.status') void refresh()
    })
  }, [refresh])

  useEffect(() => {
    setQuery('')
    if (tab === 'skills') searchRef.current?.focus()
  }, [tab])

  const run = async (key: string, job: () => Promise<void>) => {
    setWorking(key)
    try {
      await job()
    } catch (err) {
      onNotify('system', (err as Error).message)
    } finally {
      setWorking(null)
      await refresh()
    }
  }

  const toggleSkill = (skill: HubSkill) =>
    run(`skill-${skill.name}`, async () => {
      const result = await window.openwb.skills.setEnabled({ name: skill.name, enabled: !skill.enabled })
      const next = result.skills.map((item) => ({
        name: item.name,
        description: item.description,
        scope: item.scope,
        enabled: item.enabled !== false,
        ...(item.requires ? { requires: item.requires } : {}),
        ...(item.triggers ? { triggers: item.triggers } : {}),
        ...(item.priority !== undefined ? { priority: item.priority } : {}),
        ...(item.scripts ? { scripts: item.scripts } : {}),
        ...(item.missingDependencies ? { missingDependencies: item.missingDependencies } : {}),
        ...(item.disabledDependencies ? { disabledDependencies: item.disabledDependencies } : {})
      }))
      setSkills(next)
      onSkillsChanged(next)
      onNotify('info', skill.enabled ? `已关闭 ${skill.name} 的自动触发` : `已为 ${skill.name} 开启自动触发`)
    })

  const pinSkill = (skill: HubSkill) =>
    run(`pin-${skill.name}`, async () => {
      const isPinned = pinned.includes(skill.name)
      await window.openwb.skills.pin({ name: skill.name, pinned: !isPinned })
      onNotify('info', isPinned ? `已取消置顶 ${skill.name}` : `已置顶 ${skill.name}`)
    })

  const importSkill = () =>
    run('import', async () => {
      const picked = await window.openwb.skills.pickDir()
      if (!picked.path) return
      const result = await window.openwb.skills.importDirectory(picked.path)
      onNotify('info', `已导入技能 ${result.imported}`)
      setSkillTab('installed')
    })

  const removeSkill = (skill: HubSkill) =>
    run(`remove-${skill.name}`, async () => {
      await window.openwb.skills.uninstall(skill.name)
      setConfirmRemove(null)
      onNotify('info', `已卸载技能 ${skill.name}`)
    })

  const togglePlugin = (plugin: PluginSnapshotInfo) =>
    run(`plugin-${plugin.name}`, async () => {
      if (!plugin.enabled && plugin.permissions.includes('shell')) {
        const ok = window.confirm(`${plugin.displayName} 申请 shell 权限:可执行本机任意命令。\n\n确认启用吗?`)
        if (!ok) return
        await window.openwb.plugins.setEnabled({ name: plugin.name, enabled: true, confirmShell: true })
        return
      }
      await window.openwb.plugins.setEnabled({ name: plugin.name, enabled: !plugin.enabled })
    })

  const probePlugin = (plugin: PluginSnapshotInfo) =>
    run(`probe-${plugin.name}`, async () => {
      const result = await window.openwb.plugins.probe(plugin.name)
      onNotify(
        result.ok ? 'info' : 'system',
        result.ok
          ? `${plugin.displayName} 连接正常,工具 ${result.tools} 个`
          : `${plugin.displayName} 连接失败: ${result.error ?? '未知错误'}`
      )
    })

  const retryPlugin = (plugin: PluginSnapshotInfo) =>
    run(`retry-${plugin.name}`, async () => {
      await window.openwb.plugins.retry(plugin.name)
      onNotify('info', `已重试 ${plugin.displayName}`)
    })

  const installPlugin = () =>
    run('install', async () => {
      const picked = await window.openwb.plugins.pickDir()
      if (!picked.path) return
      if (!window.confirm('如果该连接器声明了 shell 权限,它可以执行本机命令。\n\n继续安装吗?')) return
      const result = await window.openwb.plugins.install({ sourceDir: picked.path, confirmShell: true })
      if (result.plugin) onNotify('info', `已安装 ${result.plugin.displayName}`)
    })

  const removePlugin = (plugin: PluginSnapshotInfo) =>
    run(`uninstall-${plugin.name}`, async () => {
      await window.openwb.plugins.uninstall(plugin.name)
      setConfirmRemove(null)
      onNotify('info', `已卸载 ${plugin.displayName}`)
    })

  const experts = useMemo(
    () => plugins.filter((plugin) => plugin.kind === 'expert').sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [plugins]
  )
  const connectors = useMemo(
    () => plugins.filter((plugin) => plugin.kind === 'connector').sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [plugins]
  )
  const installedSkills = useMemo(() => {
    const order = new Map(pinned.map((name, index) => [name, index]))
    return skills
      .filter((skill) => matches(`${skill.name} ${skill.description}`, query))
      .sort((a, b) => {
        const ai = order.get(a.name)
        const bi = order.get(b.name)
        if (ai !== undefined && bi !== undefined) return ai - bi
        if (ai !== undefined) return -1
        if (bi !== undefined) return 1
        return a.name.localeCompare(b.name)
      })
  }, [skills, pinned, query])
  const visibleConnectors = useMemo(
    () => connectors.filter((plugin) => matches(`${plugin.displayName} ${plugin.name}`, query)),
    [connectors, query]
  )
  const visibleExperts = useMemo(
    () => experts.filter((plugin) => matches(`${plugin.displayName} ${plugin.name}`, query)),
    [experts, query]
  )
  const searchPlaceholder =
    tab === 'skills' ? '搜索技能' : tab === 'connectors' ? '搜索连接器' : '搜索专家'
  const detailPlugin =
    detail?.kind === 'connector' || detail?.kind === 'expert'
      ? plugins.find((plugin) => plugin.name === detail.name) ?? null
      : null
  const detailSkill = detail?.kind === 'skill' ? skills.find((skill) => skill.name === detail.name) ?? null : null

  return (
    <section className="owb-hub" role="dialog" aria-modal="true" aria-label="专家·技能·连接器">
      <header className="owb-hub__header">
        <div>
          <h2>专家·技能·连接器</h2>
          <p>配置专家、技能与外部服务,让 AI 更专业地完成任务</p>
        </div>
        <button className="owb-icon-btn" onClick={onClose} aria-label="关闭">
          <IconX size={16} />
        </button>
      </header>

      <div className="owb-hub__toolbar">
        <div className="owb-hub__tabs" role="tablist" aria-label="工作台分类">
          {([
            ['experts', '专家'],
            ['skills', '技能'],
            ['connectors', '连接器']
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`owb-hub__tab${tab === id ? ' owb-hub__tab--on' : ''}`}
              data-testid={`hub-tab-${id}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="owb-hub__search">
          <IconSearch size={15} />
          <input
            ref={searchRef}
            value={query}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button type="button" aria-label="清空搜索" onClick={() => setQuery('')}>
              <IconX size={13} />
            </button>
          ) : null}
        </label>
      </div>

      <div className="owb-hub__body">
        {loading ? (
          <div className="owb-hub__empty">加载中…</div>
        ) : tab === 'skills' ? (
          <>
            <div className="owb-hub__subtabs" role="tablist" aria-label="技能分类">
              {([
                ['market', '技能市场'],
                ['installed', '已安装']
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={skillTab === id}
                  className={`owb-hub__subtab${skillTab === id ? ' owb-hub__subtab--on' : ''}`}
                  onClick={() => setSkillTab(id)}
                >
                  {label}
                </button>
              ))}
              <button className="owb-hub__action owb-hub__action--push" onClick={() => void importSkill()} disabled={working !== null}>
                {working === 'import' ? <IconLoader size={12} /> : <IconPlus size={12} />}
                导入技能
              </button>
            </div>

            {skillTab === 'market' ? (
              <>
                <div className="owb-hub__chips" role="tablist" aria-label="技能市场分类">
                  {([
                    ['recommend', '推荐'],
                    ['suite', '套件'],
                    ['knot', 'Knot'],
                    ['enterprise', '企业 Skill']
                  ] as const).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={marketTab === id}
                      className={`owb-hub__chip${marketTab === id ? ' owb-hub__chip--on' : ''}`}
                      onClick={() => setMarketTab(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="owb-hub__empty">
                  <IconGrid size={28} />
                  <strong>{marketTab === 'enterprise' ? '当前企业暂无可用的自建 Skill' : '市场内容暂不可用'}</strong>
                  <span>本地版本不访问远端市场;已安装技能可在「已安装」中管理</span>
                </div>
              </>
            ) : installedSkills.length === 0 ? (
              <div className="owb-hub__empty">
                <IconTool size={28} />
                <strong>{query ? '没有找到匹配的技能' : '还没有安装任何技能'}</strong>
                <span>{query ? '换个关键词试试' : '上传本地技能文件夹,或通过 AI 对话快速创建一个专属技能'}</span>
              </div>
            ) : (
              <>
                {skillConflicts.length > 0 || skillIssues.length > 0 ? (
                  <div className="owb-hub__diagnostics" data-testid="skill-diagnostics">
                    {skillConflicts.map((conflict) => (
                      <p key={`conflict-${conflict.trigger}`} className="owb-hub__diagnostic">
                        <strong>触发域冲突「{conflict.trigger}」</strong>
                        <span>
                          {conflict.reason}。候选:{conflict.skills.join(' / ')}
                          {conflict.winner
                            ? `;当前自动路由到 ${conflict.winner}`
                            : ';请关闭其中一个技能或为其设置不同的 priority'}
                        </span>
                      </p>
                    ))}
                    {skillIssues
                      .filter((issue) => !issue.reason.includes('不存在或不可读'))
                      .map((issue, index) => (
                        <p key={`issue-${issue.path}-${index}`} className="owb-hub__diagnostic owb-hub__diagnostic--warn">
                          <strong>{issue.path}</strong>
                          <span>{issue.reason}</span>
                        </p>
                      ))}
                  </div>
                ) : null}
                <div className="owb-hub__grid">
                {installedSkills.map((skill) => (
                  <article
                    key={skill.name}
                    className={`owb-hub__card${skill.enabled ? '' : ' owb-hub__card--off'}`}
                    data-testid={`skill-card-${skill.name}`}
                  >
                    <div className="owb-hub__card-main">
                      <span className="owb-hub__icon" aria-hidden="true">
                        {pinned.includes(skill.name) ? <IconPin size={18} /> : <IconTool size={18} />}
                      </span>
                      <div>
                        <div className="owb-hub__name-row">
                          <span className="owb-hub__name">{skill.name}</span>
                          <span className="owb-hub__badge">{scopeLabel(skill.scope)}</span>
                          {skill.triggers?.length ? (
                            <span className="owb-hub__badge">{`触发域 ${skill.triggers.join(', ')}`}</span>
                          ) : null}
                        </div>
                        <p className="owb-hub__desc">{skill.description || '暂无描述'}</p>
                        {(skill.missingDependencies?.length ?? 0) > 0 ? (
                          <p className="owb-hub__desc owb-hub__desc--warn">
                            缺少依赖: {skill.missingDependencies!.join(', ')};安装后再加载
                          </p>
                        ) : null}
                        {(skill.disabledDependencies?.length ?? 0) > 0 ? (
                          <p className="owb-hub__desc owb-hub__desc--warn">
                            依赖已关闭: {skill.disabledDependencies!.join(', ')}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <div className="owb-hub__card-foot">
                      <span className={`owb-hub__dot ${skill.enabled ? 'owb-hub__dot--ok' : 'owb-hub__dot--idle'}`} />
                      <span className="owb-hub__status">{skill.enabled ? '自动触发已开启' : '自动触发已关闭'}</span>
                      <button className="owb-hub__link" onClick={() => setDetail({ kind: 'skill', name: skill.name })}>
                        详情
                      </button>
                      <button
                        className="owb-hub__link"
                        onClick={() => void pinSkill(skill)}
                        disabled={working !== null}
                      >
                        {working === `pin-${skill.name}` ? '处理中…' : pinned.includes(skill.name) ? '取消置顶' : '置顶'}
                      </button>
                      {skill.scope === 'user' ? (
                        <button
                          className="owb-hub__link owb-hub__link--danger"
                          onClick={() => setConfirmRemove({ name: skill.name, label: '技能' })}
                          disabled={working !== null}
                        >
                          卸载
                        </button>
                      ) : null}
                      <button
                        className={`owb-hub__switch${skill.enabled ? ' owb-hub__switch--on' : ''}`}
                        role="switch"
                        aria-checked={skill.enabled}
                        aria-label={`${skill.enabled ? '关闭' : '开启'} ${skill.name} 自动触发`}
                        disabled={working !== null}
                        onClick={() => void toggleSkill(skill)}
                      >
                        <span />
                      </button>
                    </div>
                  </article>
                ))}
                </div>
              </>
            )}
          </>
        ) : tab === 'connectors' ? (
          <>
            <div className="owb-hub__subtabs" role="tablist" aria-label="连接器分类">
              {([
                ['official', '官方内置'],
                ['enterprise', '企业连接器']
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={connectorTab === id}
                  className={`owb-hub__subtab${connectorTab === id ? ' owb-hub__subtab--on' : ''}`}
                  onClick={() => setConnectorTab(id)}
                >
                  {label}
                </button>
              ))}
              <button className="owb-hub__action owb-hub__action--push" onClick={() => void installPlugin()} disabled={working !== null}>
                {working === 'install' ? <IconLoader size={12} /> : <IconPlus size={12} />}
                安装插件
              </button>
              <button className="owb-hub__icon-btn" onClick={() => void refresh()} disabled={working !== null} aria-label="刷新">
                <IconRefresh size={14} />
              </button>
            </div>

            {connectorTab === 'enterprise' ? (
              <div className="owb-hub__empty">
                <IconBriefcase size={28} />
                <strong>当前企业暂无可用的连接器</strong>
                <span>企业连接器由管理员统一配置</span>
              </div>
            ) : visibleConnectors.length === 0 ? (
              <div className="owb-hub__empty">
                <IconTool size={28} />
                <strong>{query ? '未找到匹配的连接器,换个关键词试试' : '还没有连接器'}</strong>
                <span>{query ? '' : '连接外部服务,扩展 AI 能力'}</span>
              </div>
            ) : (
              <>
                <ConnectorGroup
                  id="installed"
                  title="已安装"
                  plugins={visibleConnectors.filter((plugin) => plugin.enabled)}
                  working={working}
                  onToggle={(plugin) => void togglePlugin(plugin)}
                  onProbe={(plugin) => void probePlugin(plugin)}
                  onRetry={(plugin) => void retryPlugin(plugin)}
                  onDetail={(plugin) => setDetail({ kind: 'connector', name: plugin.name })}
                />
                <ConnectorGroup
                  id="available"
                  title="可用"
                  plugins={visibleConnectors.filter((plugin) => !plugin.enabled)}
                  working={working}
                  onToggle={(plugin) => void togglePlugin(plugin)}
                  onProbe={(plugin) => void probePlugin(plugin)}
                  onRetry={(plugin) => void retryPlugin(plugin)}
                  onDetail={(plugin) => setDetail({ kind: 'connector', name: plugin.name })}
                  empty={query ? '没有匹配的连接器' : '当前没有其他可用连接器'}
                />
              </>
            )}
          </>
        ) : visibleExperts.length === 0 ? (
          <div className="owb-hub__empty">
            <IconSparkle size={28} />
            <strong>{query ? '没有找到匹配的专家' : '还没有安装专家'}</strong>
            <span>专家以插件清单提供,安装后可在任务中调用其知识</span>
          </div>
        ) : (
          <div className="owb-hub__grid">
            {visibleExperts.map((plugin) => (
              <article key={plugin.name} className="owb-hub__card" data-testid={`expert-card-${plugin.name}`}>
                <div className="owb-hub__card-main">
                  <span className="owb-hub__icon" aria-hidden="true">
                    <IconSparkle size={18} />
                  </span>
                  <div>
                    <div className="owb-hub__name-row">
                      <span className="owb-hub__name">{plugin.displayName}</span>
                      {plugin.team?.length ? (
                        <span className="owb-hub__badge" data-testid={`expert-team-badge-${plugin.name}`}>
                          {`团队 · ${plugin.team.length} 人`}
                        </span>
                      ) : null}
                      <span className={`owb-hub__dot ${stateTone(plugin.state)}`} />
                    </div>
                    <p className="owb-hub__desc">{plugin.description || '专业领域专家'}</p>
                  </div>
                </div>
                <div className="owb-hub__card-foot">
                  <span className="owb-hub__badge">专家</span>
                  <span className="owb-hub__status">{STATE_LABEL[plugin.state]}</span>
                  <button className="owb-hub__link" onClick={() => setDetail({ kind: 'expert', name: plugin.name })}>
                    详情
                  </button>
                  <button className="owb-hub__link" onClick={() => void togglePlugin(plugin)} disabled={working !== null}>
                    {plugin.enabled ? '关闭' : '启用'}
                  </button>
                  <button
                    className="owb-hub__action owb-hub__action--primary"
                    disabled={!plugin.enabled || working !== null}
                    title={plugin.enabled ? '新建任务并绑定该专家' : '请先启用该专家'}
                    data-testid={`use-expert-${plugin.name}`}
                    onClick={() => onUseExpert({ id: plugin.name, name: plugin.displayName })}
                  >
                    在任务中使用
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {detail ? (
        <div className="owb-hub__overlay" role="presentation" onClick={() => setDetail(null)}>
          <aside className="owb-hub__detail" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <h3>{detailSkill?.name ?? detailPlugin?.displayName ?? detail.name}</h3>
                <p>{detailSkill ? scopeLabel(detailSkill.scope) : detailPlugin?.kind === 'expert' ? '专家' : '连接器'}</p>
              </div>
              <button className="owb-icon-btn" onClick={() => setDetail(null)} aria-label="关闭详情">
                <IconX size={16} />
              </button>
            </header>
            <div className="owb-hub__detail-body">
              <p>{detailSkill?.description ?? detailPlugin?.description ?? '暂无描述'}</p>
              {detailSkill ? (
                <>
                  <div className="owb-hub__kv">
                    <span>标识</span>
                    <code>{detailSkill.name}</code>
                  </div>
                  <div className="owb-hub__kv">
                    <span>自动触发</span>
                    <strong>{detailSkill.enabled ? '已开启' : '已关闭'}</strong>
                  </div>
                  <div className="owb-hub__kv">
                    <span>来源</span>
                    <strong>{scopeLabel(detailSkill.scope)}</strong>
                  </div>
                </>
              ) : null}
              {detailPlugin ? (
                <>
                  <div className="owb-hub__kv">
                    <span>版本</span>
                    <strong>v{detailPlugin.version}</strong>
                  </div>
                  <div className="owb-hub__kv">
                    <span>状态</span>
                    <strong>{STATE_LABEL[detailPlugin.state]}</strong>
                  </div>
                  {detailPlugin.team?.length ? (
                    <div className="owb-hub__kv" data-testid="expert-team-members">
                      <span>团队</span>
                      <strong>
                        {detailPlugin.team
                          .map((member) => {
                            const name =
                              plugins.find((item) => item.name === member.ref)?.displayName ?? member.ref
                            return member.role ? `${name}(${member.role})` : name
                          })
                          .join('、')}
                      </strong>
                    </div>
                  ) : null}
                  {detailPlugin.permissions.length > 0 ? (
                    <div className="owb-hub__kv">
                      <span>权限</span>
                      <strong>{detailPlugin.permissions.join(', ')}</strong>
                    </div>
                  ) : null}
                  {detailPlugin.tools.length > 0 ? (
                    <div className="owb-hub__tools">
                      <span>工具</span>
                      {detailPlugin.tools.map((tool) => (
                        <div key={tool.name}>
                          <code>{tool.name}</code>
                          <p>{tool.description}</p>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {detailPlugin.lastError ? <div className="owb-hub__error">{detailPlugin.lastError}</div> : null}
                </>
              ) : null}
            </div>
            <footer>
              {detailSkill?.scope === 'user' ? (
                <button
                  className="owb-hub__action owb-hub__action--danger"
                  onClick={() => {
                    setConfirmRemove({ name: detailSkill.name, label: '技能' })
                    setDetail(null)
                  }}
                >
                  卸载
                </button>
              ) : null}
              {detailPlugin?.kind === 'connector' ? (
                <>
                  <button className="owb-hub__action" onClick={() => void probePlugin(detailPlugin)}>
                    测试连接
                  </button>
                  <button
                    className="owb-hub__action owb-hub__action--danger"
                    onClick={() => {
                      setConfirmRemove({ name: detailPlugin.name, label: detailPlugin.displayName })
                      setDetail(null)
                    }}
                  >
                    卸载
                  </button>
                </>
              ) : null}
              {detailPlugin?.kind === 'expert' ? (
                <button
                  className="owb-hub__action owb-hub__action--primary"
                  disabled={!detailPlugin.enabled}
                  data-testid="use-expert-detail"
                  onClick={() => {
                    const plugin = detailPlugin
                    setDetail(null)
                    onUseExpert({ id: plugin.name, name: plugin.displayName })
                  }}
                >
                  在任务中使用
                </button>
              ) : null}
              <button className="owb-hub__action owb-hub__action--primary" onClick={() => setDetail(null)}>
                完成
              </button>
            </footer>
          </aside>
        </div>
      ) : null}

      {confirmRemove ? (
        <div className="owb-hub__overlay" role="presentation" onClick={() => setConfirmRemove(null)}>
          <div className="owb-hub__confirm" role="alertdialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <h3>卸载{confirmRemove.label}?</h3>
            <p>此操作会移除已安装的文件;已完成的任务与历史记录不会受影响。</p>
            <div>
              <button className="owb-hub__action" onClick={() => setConfirmRemove(null)}>取消</button>
              <button
                className="owb-hub__action owb-hub__action--danger"
                onClick={() => {
                  const skill = skills.find((item) => item.name === confirmRemove.name)
                  const plugin = plugins.find((item) => item.name === confirmRemove.name)
                  if (skill) void removeSkill(skill)
                  else if (plugin) void removePlugin(plugin)
                }}
              >
                卸载
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function ConnectorCard({
  plugin,
  working,
  onToggle,
  onProbe,
  onRetry,
  onDetail
}: {
  plugin: PluginSnapshotInfo
  working: string | null
  onToggle: () => void
  onProbe: () => void
  onRetry: () => void
  onDetail: () => void
}) {
  return (
    <article className="owb-hub__card" data-testid={`connector-card-${plugin.name}`}>
      <div className="owb-hub__card-main">
        <span className="owb-hub__icon" aria-hidden="true">
          {plugin.displayName.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <div className="owb-hub__name-row">
            <span className="owb-hub__name">{plugin.displayName}</span>
            <span className={`owb-hub__dot ${stateTone(plugin.state)}`} />
          </div>
          <p className="owb-hub__desc">
            {plugin.description || (plugin.tools.length > 0 ? `${plugin.tools.length} 个工具` : '连接外部服务,扩展 AI 能力')}
          </p>
        </div>
      </div>
      <div className="owb-hub__card-foot">
        <span className="owb-hub__status">{STATE_LABEL[plugin.state]}</span>
        <button className="owb-hub__link" onClick={onDetail}>详情</button>
        {plugin.state === 'crashed' || plugin.state === 'disabled' ? (
          <button className="owb-hub__link" onClick={onRetry} disabled={working !== null}>重试</button>
        ) : (
          <button className="owb-hub__link" onClick={onProbe} disabled={working !== null}>测试连接</button>
        )}
        <button className="owb-hub__action" onClick={onToggle} disabled={working !== null}>
          {working === `plugin-${plugin.name}` ? '处理中…' : plugin.enabled ? '断开' : '连接'}
        </button>
      </div>
    </article>
  )
}

function ConnectorGroup({
  id,
  title,
  plugins,
  working,
  empty,
  onToggle,
  onProbe,
  onRetry,
  onDetail
}: {
  id: string
  title: string
  plugins: PluginSnapshotInfo[]
  working: string | null
  empty?: string
  onToggle: (plugin: PluginSnapshotInfo) => void
  onProbe: (plugin: PluginSnapshotInfo) => void
  onRetry: (plugin: PluginSnapshotInfo) => void
  onDetail: (plugin: PluginSnapshotInfo) => void
}) {
  if (plugins.length === 0 && !empty) return null
  return (
    <section className="owb-hub__section" data-testid={`connector-group-${id}`}>
      <h3>{title}</h3>
      {plugins.length === 0 ? (
        <p className="owb-hub__section-empty">{empty}</p>
      ) : (
        <div className="owb-hub__grid">
          {plugins.map((plugin) => (
            <ConnectorCard
              key={plugin.name}
              plugin={plugin}
              working={working}
              onToggle={() => onToggle(plugin)}
              onProbe={() => onProbe(plugin)}
              onRetry={() => onRetry(plugin)}
              onDetail={() => onDetail(plugin)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

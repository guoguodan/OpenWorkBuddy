import { useCallback, useEffect, useState } from 'react'
import { IconCheck, IconLoader, IconPlus, IconRefresh, IconTool, IconX } from './Icons'

/**
 * 连接器页(IMPLEMENTATION §6)。
 *
 * 设计要点:权限在安装前就要看得见,而不是装完再提示。
 * shell 权限单独用红色强调,并且启用时必须再点一次确认。
 */

interface ConnectorsPanelProps {
  onClose: () => void
  onNotify: (kind: 'system' | 'info', text: string) => void
}

const STATE_LABEL: Record<PluginSnapshotInfo['state'], string> = {
  unloaded: '未启动',
  starting: '启动中',
  ready: '已就绪',
  reconnecting: '重连中',
  disabled: '已禁用',
  crashed: '已崩溃'
}

function stateTone(state: PluginSnapshotInfo['state']): string {
  if (state === 'ready') return 'owb-plugin__state--ok'
  if (state === 'reconnecting' || state === 'starting') return 'owb-plugin__state--busy'
  if (state === 'crashed' || state === 'disabled') return 'owb-plugin__state--off'
  return 'owb-plugin__state--idle'
}

export function ConnectorsPanel({ onClose, onNotify }: ConnectorsPanelProps) {
  const [plugins, setPlugins] = useState<PluginSnapshotInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await window.openwb.plugins.list()
      setPlugins(r.plugins)
    } catch (err) {
      onNotify('system', `连接器列表加载失败: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [onNotify])

  useEffect(() => {
    void refresh()
    // plugin.status 由 daemon 主动推送,重连/崩溃时列表要跟着变
    return window.openwb.conversation.onEvent((raw: unknown) => {
      const e = raw as { type?: string }
      if (e.type === 'plugin.status') void refresh()
    })
  }, [refresh])

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

  const install = () =>
    run('install', async () => {
      const picked = await window.openwb.plugins.pickDir()
      if (!picked.path) return
      let confirmShell = false
      const shellWarning = window.confirm(
        '注意:如果该插件声明了 shell 权限,它可以执行本机命令。\n\n继续安装吗?(安装后仍默认禁用,需要再单独开启)'
      )
      if (!shellWarning) return
      confirmShell = true
      const r = await window.openwb.plugins.install({ sourceDir: picked.path, confirmShell })
      const p = r.plugin
      if (p) {
        onNotify(
          'info',
          p.state === 'ready'
            ? `已安装 ${p.displayName},工具 ${p.tools.length} 个`
            : `已安装 ${p.displayName}(当前${STATE_LABEL[p.state]})`
        )
      }
    })

  const toggle = (p: PluginSnapshotInfo) =>
    run(`toggle-${p.name}`, async () => {
      if (!p.enabled && p.permissions.includes('shell')) {
        const ok = window.confirm(
          `${p.displayName} 申请 shell 权限:可执行本机任意命令。\n\n确认启用吗?`
        )
        if (!ok) return
        await window.openwb.plugins.setEnabled({ name: p.name, enabled: true, confirmShell: true })
        return
      }
      await window.openwb.plugins.setEnabled({ name: p.name, enabled: !p.enabled })
    })

  const probe = (p: PluginSnapshotInfo) =>
    run(`probe-${p.name}`, async () => {
      const r = await window.openwb.plugins.probe(p.name)
      onNotify(r.ok ? 'info' : 'system', r.ok ? `${p.displayName} 连接正常,工具 ${r.tools} 个` : `${p.displayName} 连接失败: ${r.error ?? '未知错误'}`)
    })

  const retry = (p: PluginSnapshotInfo) =>
    run(`retry-${p.name}`, async () => {
      await window.openwb.plugins.retry(p.name)
      onNotify('info', `已重试 ${p.displayName}`)
    })

  const uninstall = (p: PluginSnapshotInfo) =>
    run(`remove-${p.name}`, async () => {
      if (!window.confirm(`卸载 ${p.displayName}?该插件的工具会立刻不可用。`)) return
      await window.openwb.plugins.uninstall(p.name)
      onNotify('info', `已卸载 ${p.displayName}`)
    })

  return (
    <div className="owb-infopanel" role="dialog" aria-label="模型与连接器">
      <div className="owb-infopanel__header">
        <div className="owb-infopanel__title">
          <IconTool size={16} />
          <span>连接器 ({plugins.length})</span>
        </div>
        <button className="owb-icon-btn" onClick={onClose} aria-label="关闭面板">
          <IconX size={16} />
        </button>
      </div>

      <div className="owb-infopanel__body">
        <div className="owb-connector__toolbar">
          <button
            className="owb-infopanel__action owb-infopanel__action--primary"
            onClick={() => void install()}
            disabled={working !== null}
          >
            {working === 'install' ? <IconLoader size={12} /> : <IconPlus size={12} />}
            安装插件
          </button>
          <button className="owb-infopanel__action" onClick={() => void refresh()} disabled={working !== null}>
            <IconRefresh size={12} />
            刷新
          </button>
        </div>

        {loading ? (
          <div className="owb-infopanel__empty">加载中…</div>
        ) : plugins.length === 0 ? (
          <div className="owb-infopanel__empty">
            还没有安装插件。插件目录需要包含 <code>plugin.json</code>,安装后会出现在这里。
          </div>
        ) : (
          plugins.map((p) => (
            <div key={p.name} className="owb-infopanel__card owb-plugin">
              <div className="owb-infopanel__card-head">
                <span className="owb-infopanel__name">{p.displayName}</span>
                <span className={`owb-plugin__state ${stateTone(p.state)}`}>
                  {working === `probe-${p.name}` ? '探测中…' : STATE_LABEL[p.state]}
                </span>
              </div>

              <div className="owb-plugin__meta">
                <span className="owb-plugin__mono">{p.name}</span>
                <span>v{p.version}</span>
                <span>{p.kind === 'expert' ? '专家' : '连接器'}</span>
                {p.tools.length > 0 ? <span>{p.tools.length} 个工具</span> : null}
              </div>

              {p.permissions.length > 0 ? (
                <div className="owb-plugin__perms">
                  {p.permissions.map((perm) => (
                    <span
                      key={perm}
                      className={`owb-plugin__perm${perm === 'shell' ? ' owb-plugin__perm--danger' : ''}`}
                    >
                      {perm}
                    </span>
                  ))}
                </div>
              ) : null}

              {!p.verifiedPublisher ? (
                <div className="owb-plugin__warn">未验证发布者,请确认来源可信</div>
              ) : null}
              {p.warnings
                .filter((w) => !w.includes('未验证发布者'))
                .map((w) => (
                  <div key={w} className="owb-plugin__warn">
                    {w}
                  </div>
                ))}
              {p.lastError ? <div className="owb-plugin__error">{p.lastError}</div> : null}

              {p.tools.length > 0 ? (
                <div className="owb-plugin__tools">
                  {p.tools.map((t) => (
                    <div key={t.name} className="owb-plugin__tool">
                      <span className="owb-plugin__mono">{t.name}</span>
                      {t.highCredit ? <span className="owb-plugin__tag">需审批</span> : null}
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="owb-plugin__actions">
                <button
                  className="owb-infopanel__action"
                  onClick={() => void toggle(p)}
                  disabled={working !== null}
                >
                  {working === `toggle-${p.name}` ? <IconLoader size={12} /> : p.enabled ? <IconX size={12} /> : <IconCheck size={12} />}
                  {p.enabled ? '禁用' : '启用'}
                </button>
                <button className="owb-infopanel__action" onClick={() => void probe(p)} disabled={working !== null}>
                  测试连接
                </button>
                {p.state === 'crashed' || p.state === 'disabled' || p.state === 'reconnecting' ? (
                  <button className="owb-infopanel__action" onClick={() => void retry(p)} disabled={working !== null}>
                    重试
                  </button>
                ) : null}
                <button className="owb-infopanel__action" onClick={() => void uninstall(p)} disabled={working !== null}>
                  卸载
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

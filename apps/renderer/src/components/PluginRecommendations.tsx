import { IconSparkle, IconTool, IconX } from './Icons'

/**
 * 任务匹配推荐(WM-PLUGIN-04)。
 *
 * 卡片只做两件事:说明"为什么推荐",以及提供一次直达动作。
 * 推荐本身来自 daemon 的本地规则,已连接的连接器与当前专家不会出现在这里。
 */

interface PluginRecommendationsProps {
  items: PluginRecommendationInfo[]
  busy: boolean
  onUseConnector: (item: PluginRecommendationInfo) => void
  onUseExpert: (item: PluginRecommendationInfo) => void
  onDismiss: (name: string) => void
}

export function PluginRecommendations({
  items,
  busy,
  onUseConnector,
  onUseExpert,
  onDismiss
}: PluginRecommendationsProps) {
  if (items.length === 0) return null
  return (
    <div className="owb-recommend" data-testid="plugin-recommendations" aria-label="任务匹配推荐">
      <div className="owb-recommend__head">
        <IconSparkle size={13} />
        <span>与当前任务匹配</span>
        <span className="owb-recommend__count">{items.length}</span>
      </div>
      <div className="owb-recommend__list">
        {items.map((item) => (
          <article
            key={item.name}
            className="owb-recommend__card"
            data-testid={`plugin-recommend-${item.name}`}
            data-kind={item.kind}
          >
            <div className="owb-recommend__icon" aria-hidden="true">
              {item.kind === 'connector' ? <IconTool size={15} /> : <IconSparkle size={15} />}
            </div>
            <div className="owb-recommend__body">
              <div className="owb-recommend__title-row">
                <strong className="owb-recommend__title">{item.displayName}</strong>
                <span className={`owb-recommend__badge owb-recommend__badge--${item.kind}`}>
                  {item.kind === 'connector' ? '连接器' : '专家'}
                </span>
              </div>
              <p className="owb-recommend__reason">{item.reason}</p>
              {item.kind === 'connector' && item.permissions.includes('shell') ? (
                <p className="owb-recommend__warn">该连接器申请 shell 权限,启用前会再次确认。</p>
              ) : null}
            </div>
            <div className="owb-recommend__actions">
              <button
                type="button"
                className="owb-recommend__use"
                data-testid={`plugin-recommend-use-${item.name}`}
                disabled={busy}
                onClick={() => (item.kind === 'connector' ? onUseConnector(item) : onUseExpert(item))}
              >
                {item.kind === 'connector' ? '连接' : '启用专家'}
              </button>
              <button
                type="button"
                className="owb-recommend__dismiss"
                aria-label={`不再推荐 ${item.displayName}`}
                data-testid={`plugin-recommend-dismiss-${item.name}`}
                onClick={() => onDismiss(item.name)}
              >
                <IconX size={12} />
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}

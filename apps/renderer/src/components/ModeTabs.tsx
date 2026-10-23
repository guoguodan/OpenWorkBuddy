import type { ComponentType } from 'react'
import { IconChat, IconCheck, IconFolder, IconSparkle, IconTool } from './Icons'

export interface ModeInfo {
  id: string
  displayName: string
  description: string
}

type ModeIcon = ComponentType<{ size?: number; className?: string }>

const MODE_ICONS: Record<string, ModeIcon> = {
  craft: IconTool,
  plan: IconFolder,
  ask: IconChat,
  expert: IconSparkle,
  quick: IconCheck
}

interface ModeTabsProps {
  modes: ModeInfo[]
  mode: string
  busy: boolean
  variant: 'scene' | 'compact'
  onSelect: (id: string) => void
}

export function ModeTabs({ modes, mode, busy, variant, onSelect }: ModeTabsProps) {
  if (variant === 'scene') {
    return (
      <div className="owb-scene-tabs" role="tablist" aria-label="工作模式">
        {modes.map((m) => {
          const Icon = MODE_ICONS[m.id] ?? IconSparkle
          return (
            <button
              key={m.id}
              type="button"
              role="tab"
              data-mode-id={m.id}
              aria-selected={mode === m.id}
              title={m.description}
              disabled={busy}
              onClick={() => onSelect(m.id)}
              className={`owb-scene-tab${mode === m.id ? ' owb-scene-tab--active' : ''}`}
            >
              <Icon size={16} className="owb-scene-tab__icon" />
              {m.displayName}
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <div className="owb-mode-pills" role="tablist" aria-label="工作模式">
      {modes.map((m) => {
        const Icon = MODE_ICONS[m.id] ?? IconSparkle
        return (
          <button
            key={m.id}
            type="button"
            role="tab"
            data-mode-id={m.id}
            aria-selected={mode === m.id}
            title={m.description}
            disabled={busy}
            onClick={() => onSelect(m.id)}
            className={`owb-mode-pill${mode === m.id ? ' owb-mode-pill--active' : ''}`}
          >
            <Icon size={14} />
            {m.displayName}
          </button>
        )
      })}
    </div>
  )
}
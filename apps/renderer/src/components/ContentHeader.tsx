import { IconChevron, IconFolder } from './Icons'

interface ContentHeaderProps {
  title: string
  modeLabel: string
  workspaceLabel: string
  workspacePath: string
  busy: boolean
}

export function ContentHeader({ title, modeLabel, workspaceLabel, workspacePath, busy }: ContentHeaderProps) {
  return (
    <div className="owb-content-header">
      <div className="owb-breadcrumb" title={`${workspacePath || workspaceLabel} / ${modeLabel} / ${title}`}>
        <IconFolder size={17} className="owb-breadcrumb__icon" />
        <span className="owb-breadcrumb__crumb">{workspaceLabel}</span>
        <span className="owb-breadcrumb__sep">/</span>
        <span className="owb-breadcrumb__crumb">{modeLabel}</span>
        <span className="owb-breadcrumb__sep">/</span>
        <span className="owb-breadcrumb__current">{title}</span>
      </div>
      <div className="owb-content-header__right">
        {busy ? (
          <span className="owb-content-header__running">
            <span className="owb-content-header__dot" />
            执行中
          </span>
        ) : null}
        <IconChevron size={16} className="owb-content-header__more" />
      </div>
    </div>
  )
}
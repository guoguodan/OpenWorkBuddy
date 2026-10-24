type IconProps = { size?: number; className?: string }

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
})

export function IconPlus({ size = 18, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M12 5v14M5 12h14" /></svg>
}

export function IconSearch({ size = 18, className }: IconProps) {
  return <svg {...base(size)} className={className}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" /></svg>
}

export function IconSidebar({ size = 18, className }: IconProps) {
  return <svg {...base(size)} className={className}><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9 4v16" /></svg>
}

export function IconChat({ size = 18, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M21 11.5a7.5 7.5 0 0 1-10.9 6.7L4 20l1.8-5.1A7.5 7.5 0 1 1 21 11.5Z" /></svg>
}

export function IconSparkle({ size = 18, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M12 3.5l1.9 4.6 4.6 1.9-4.6 1.9L12 16.5l-1.9-4.6L5.5 10l4.6-1.9L12 3.5Z" /><path d="M18.5 15.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8.8-1.9Z" /></svg>
}

export function IconCheck({ size = 16, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="m4.5 12.5 5 5 10-11" /></svg>
}

export function IconX({ size = 16, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M6 6l12 12M18 6 6 18" /></svg>
}

export function IconSend({ size = 16, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M12 19V5" /><path d="m5.5 11.5 6.5-6.5 6.5 6.5" /></svg>
}

export function IconStop({ size = 16, className }: IconProps) {
  return <svg {...base(size)} className={className}><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" /></svg>
}

export function IconTrash({ size = 14, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M4 7h16M9 7V5h6v2M6.5 7l.8 12h9.4l.8-12" /></svg>
}

export function IconBrain({ size = 16, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M9.5 4.5A3 3 0 0 0 6.5 7.5a3 3 0 0 0-1 5.8V15a3 3 0 0 0 4 2.8V19" /><path d="M14.5 4.5a3 3 0 0 1 3 3 3 3 0 0 1 1 5.8V15a3 3 0 0 1-4 2.8V19" /><path d="M12 5v13" /></svg>
}

export function IconTool({ size = 14, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M14.5 6.5a3.5 3.5 0 0 0 4.6 4.6l-8 8-4.2 1.2 1.2-4.2 8-8Z" /><path d="M5 5l2.5 2.5" /></svg>
}

export function IconLoader({ size = 14, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M12 3a9 9 0 1 0 9 9" /></svg>
}

export function IconRefresh({ size = 14, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M20 12a8 8 0 1 1-2.6-5.9" /><path d="M20 4v4.5h-4.5" /></svg>
}

export function IconChevron({ size = 14, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="m6 9.5 6 6 6-6" /></svg>
}

export function IconPin({ size = 14, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M9.5 3.5h5l-.7 5 3.2 3.1v1.4h-5.5v6l-1 1.5-1-1.5v-6H3.9v-1.4l3.2-3.1-.7-5Z" /></svg>
}

export function IconClock({ size = 18, className }: IconProps) {
  return <svg {...base(size)} className={className}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 1.8" /></svg>
}

export function IconGrid({ size = 18, className }: IconProps) {
  return <svg {...base(size)} className={className}><rect x="4" y="4" width="6.5" height="6.5" rx="1.6" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6" /></svg>
}

export function IconModel({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 3.5 20 8v8l-8 4.5L4 16V8l8-4.5Z" />
      <path d="M4 8l8 4.5L20 8M12 12.5V20.5" />
    </svg>
  )
}

export function IconBell({ size = 18, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M18 16H6l1.4-2.2V9.8A4.6 4.6 0 0 1 12 5.2a4.6 4.6 0 0 1 4.6 4.6v4L18 16Z" /><path d="M10 19a2 2 0 0 0 4 0" /></svg>
}

export function IconMail({ size = 18, className }: IconProps) {
  return <svg {...base(size)} className={className}><rect x="3.5" y="5.5" width="17" height="13" rx="2.4" /><path d="m4.5 7.5 7.5 5 7.5-5" /></svg>
}

export function IconBook({ size = 18, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M4.5 5.5A2 2 0 0 1 6.5 3.5H19v15H6.5a2 2 0 0 0-2 2Z" /><path d="M4.5 18.5V5.5" /></svg>
}

export function IconBulb({ size = 18, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M9 17.5a5.5 5.5 0 1 1 6 0v1.8H9Z" /><path d="M10 21.5h4" /></svg>
}

export function IconMic({ size = 18, className }: IconProps) {
  return <svg {...base(size)} className={className}><rect x="9.2" y="3.5" width="5.6" height="10" rx="2.8" /><path d="M5.8 11.5a6.2 6.2 0 0 0 12.4 0" /><path d="M12 17.7v2.8" /></svg>
}

export function IconArrowUp({ size = 16, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M12 19.5V5" /><path d="m5.5 11.5 6.5-6.5 6.5 6.5" /></svg>
}

export function IconArrowUpRight({ size = 16, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M7 17 17 7" /><path d="M8.5 7H17v8.5" /></svg>
}

export function IconFilter({ size = 18, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M4 6.5h16M7 12h10M10 17.5h4" /></svg>
}

export function IconBriefcase({ size = 18, className }: IconProps) {
  return <svg {...base(size)} className={className}><rect x="3.5" y="7.5" width="17" height="12" rx="2.2" /><path d="M9 7.5V5.8A1.8 1.8 0 0 1 10.8 4h2.4A1.8 1.8 0 0 1 15 5.8v1.7M3.5 12.5h17" /></svg>
}

export function IconCode({ size = 18, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4" /></svg>
}

export function IconPalette({ size = 18, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M12 3.8a8.2 8.2 0 1 0 0 16.4c1.4 0 2.2-.9 2.2-2 0-1-.8-1.7-.8-2.7 0-1.1.9-1.9 2-1.9h1.6a3 3 0 0 0 3-3A8.2 8.2 0 0 0 12 3.8Z" /><circle cx="8" cy="10" r="1.1" /><circle cx="12" cy="7.5" r="1.1" /><circle cx="15.8" cy="10" r="1.1" /></svg>
}

export function IconRobot({ size = 18, className }: IconProps) {
  return <svg {...base(size)} className={className}><rect x="4" y="7.5" width="16" height="11" rx="3.2" /><path d="M12 4v3.5M9 12.5v1.6M15 12.5v1.6M8.5 18.5 7.5 21M15.5 18.5l1 2.5" /></svg>
}

export function IconMonitor({ size = 18, className }: IconProps) {
  return <svg {...base(size)} className={className}><rect x="3.5" y="4.5" width="17" height="12" rx="2.2" /><path d="M9 20h6M12 16.5V20" /></svg>
}

export function IconAt({ size = 18, className }: IconProps) {
  return <svg {...base(size)} className={className}><circle cx="12" cy="12" r="3.6" /><path d="M15.6 12v1.4a2.4 2.4 0 0 0 4.4 1.3A9 9 0 1 0 17 19.4" /></svg>
}

export function IconPlay({ size = 16, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M8 5.5 18 12 8 18.5Z" /></svg>
}

export function IconPause({ size = 16, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M9 5.5v13M15 5.5v13" /></svg>
}

export function IconCalendar({ size = 18, className }: IconProps) {
  return <svg {...base(size)} className={className}><rect x="3.8" y="5.5" width="16.4" height="14" rx="2.4" /><path d="M8 3.5v4M16 3.5v4M3.8 10h16.4" /></svg>
}

export function IconUsers({ size = 18, className }: IconProps) {
  return <svg {...base(size)} className={className}><circle cx="9" cy="8.5" r="3.2" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M15.5 5.6a3 3 0 0 1 0 5.8M17.5 19a5 5 0 0 0-1.7-3.7" /></svg>
}

export function IconFolder({ size = 18, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.2l1.8 2.2h8A2 2 0 0 1 20.5 9.7v7.3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" /></svg>
}

export function IconFile({ size = 18, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5Z" /><path d="M14 3.5V8.5h5" /></svg>
}

export function IconImage({ size = 18, className }: IconProps) {
  return <svg {...base(size)} className={className}><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="9.5" r="1.6" /><path d="m4.5 17 4.8-4.8 3.4 3.4 2.4-2.4 4.4 4.4" /></svg>
}

export function IconLink({ size = 18, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 1 0-5.7-5.7l-1.4 1.4" /><path d="M14 10.5a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 1 0 5.7 5.7l1.4-1.4" /></svg>
}

export function IconCopy({ size = 14, className }: IconProps) {
  return <svg {...base(size)} className={className}><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5" /></svg>
}

export function IconThumbUp({ size = 14, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M7.5 10.5 11 4.2a1.6 1.6 0 0 1 1.6-1.2c.9 0 1.6.7 1.6 1.6v4.6h4.2a2 2 0 0 1 2 2.4l-1.2 6.2a2 2 0 0 1-2 1.6H7.5" /><rect x="3.5" y="10.5" width="4" height="9" rx="1.4" /></svg>
}

export function IconThumbDown({ size = 14, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M7.5 13.5 11 19.8a1.6 1.6 0 0 0 1.6 1.2c.9 0 1.6-.7 1.6-1.6v-4.6h4.2a2 2 0 0 0 2-2.4l-1.2-6.2a2 2 0 0 0-2-1.6H7.5" /><rect x="3.5" y="4.5" width="4" height="9" rx="1.4" /></svg>
}

export function IconMoon({ size = 16, className }: IconProps) {
  return <svg {...base(size)} className={className}><path d="M20 13.5A8 8 0 0 1 10.5 4a8 8 0 1 0 9.5 9.5Z" /></svg>
}

export function IconSun({ size = 16, className }: IconProps) {
  return <svg {...base(size)} className={className}><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" /></svg>
}

export function IconWindowMin({ size = 12 }: IconProps) {
  return <svg {...base(size)} className="owb-win-icon"><path d="M4 12h16" /></svg>
}

export function IconWindowMax({ size = 12 }: IconProps) {
  return <svg {...base(size)} className="owb-win-icon"><rect x="4.5" y="4.5" width="15" height="15" rx="1.5" /></svg>
}

export function IconWindowClose({ size = 12 }: IconProps) {
  return <svg {...base(size)} className="owb-win-icon"><path d="M5 5l14 14M19 5 5 19" /></svg>
}

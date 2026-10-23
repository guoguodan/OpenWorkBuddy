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

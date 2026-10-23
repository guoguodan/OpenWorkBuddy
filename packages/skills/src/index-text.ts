import type { SkillIndexEntry } from './skills.js'

/**
 * 注入模型的技能目录:只有 name + description。
 * 正文必须由模型显式调用 load_skill 才加载,否则技能一多就会挤爆上下文。
 */
export function renderSkillIndex(entries: SkillIndexEntry[]): string {
  if (entries.length === 0) return ''

  const lines = entries.map((e) => `- ${e.name}: ${e.description}`)
  return [
    '# 可用技能',
    '',
    '以下技能按需加载。只有当任务确实属于某个技能的范围时,才调用 load_skill(name) 获取完整说明;',
    '不要在不确定时批量加载。技能只能收窄工具权限,不会授予新权限。',
    '',
    ...lines
  ].join('\n')
}
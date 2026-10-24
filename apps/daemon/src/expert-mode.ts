/**
 * 专家模式的编排规则(WM-MODE-07)。
 *
 * 两条约束:
 *   1. 一个会话同一时间只允许一个专家或一个专家团队;
 *   2. 团队只引用已安装专家,成员的专业准则在运行时合并,不复制成第二份提示词。
 *
 * 这里保持纯函数:冲突判定与提示词拼装都不读写磁盘、不调模型,
 * 这样界面提示与 daemon 拒绝能共用同一套措辞,测试也不必启动插件进程。
 */

export interface ExpertMemberInfo {
  /** 插件清单里的 name,用于回溯安装来源 */
  id: string
  /** 用户可见名称 */
  name: string
  /** 团队内分工说明;成员未声明时为空 */
  role: string | null
  /** 成员自己的专业准则,合并进本轮 system */
  instructions: string
}

export interface ExpertInfo {
  id: string
  name: string
  description: string
  instructions: string
  /** 普通专家为空数组;专家团队为按清单顺序解析出的成员 */
  team: ExpertMemberInfo[]
}

export class ExpertConflictError extends Error {
  readonly code = 'EXPERT_CONFLICT'

  constructor(
    readonly current: { id: string; name: string },
    readonly requested: { id: string; name: string }
  ) {
    super(
      `当前会话正在进行专家「${current.name}」协作,不能再启用「${requested.name}」。` +
        '请先退出当前专家,或新建一个任务;一个会话只允许一个专家或专家团队。'
    )
    this.name = 'ExpertConflictError'
  }
}

/**
 * 互斥校验。
 *
 * 只有"同一会话已经绑定 A,本轮又要求 B"才算冲突;重复指定 A 是幂等的,
 * 界面每次发送都会带上当前专家,不能因此把正常追问拦掉。
 */
export function assertExpertExclusive(
  current: { id: string; name: string } | null,
  requested: { id: string; name: string } | null
): void {
  if (!current || !requested) return
  if (current.id === requested.id) return
  throw new ExpertConflictError(current, requested)
}

/**
 * 拼装本轮专家段落。
 *
 * 普通专家沿用原有措辞;团队额外列出成员分工,让模型知道"谁负责什么",
 * 同时明确只能以一个团队身份回答,不能假装成并列的多个独立会话。
 */
export function buildExpertPrompt(expert: ExpertInfo): string {
  const isTeam = expert.team.length > 0
  const lines = [
    '',
    '# 专家角色',
    isTeam
      ? `你正在以「${expert.name}」专家团队的身份工作,团队成员协同完成本轮任务。`
      : `你正在以「${expert.name}」专家身份工作。`,
    expert.description ? `专长: ${expert.description}` : '',
    expert.instructions ? `必须遵守的专业准则:\n${expert.instructions}` : ''
  ].filter(Boolean)

  if (isTeam) {
    lines.push(
      '## 团队成员',
      '以下是本轮可动用的专业分工。请综合各成员准则作答,明确标注意见来自哪个成员;' +
        '不要虚构未列出的成员,也不要声称拥有未提供的权限。'
    )
    expert.team.forEach((member, index) => {
      lines.push('', `### ${index + 1}. ${member.name}${member.role ? `(${member.role})` : ''}`)
      lines.push(member.instructions ? member.instructions : '该成员未声明额外准则,按其专长范围提供意见。')
    })
  } else {
    lines.push('保持专业边界;不要声称拥有未提供的权限。')
  }

  return `\n${lines.join('\n')}`
}

/** trace 里只记录段落名,不落专家原文 */
export function expertSectionNames(expert: ExpertInfo | null): string[] {
  if (!expert) return []
  return expert.team.length > 0 ? ['expert', 'expert-team'] : ['expert']
}

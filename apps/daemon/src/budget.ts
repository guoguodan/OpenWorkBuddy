/**
 * 单轮 token 预算判定。
 *
 * 这里只做纯函数,便于在没有网关的情况下穷举边界:
 *   - budget=0 表示用户明确不设上限,不是"零预算";
 *   - 输入与输出都计入,因为计费接口两者都会收钱;
 *   - 等于上限也算耗尽,避免出现"刚好卡在线上还能再跑一步"的歧义。
 */

export interface BudgetState {
  limit: number
  used: number
}

export interface BudgetDecision {
  exceeded: boolean
  remaining: number
}

export function evaluateTokenBudget(limit: number, used: number): BudgetDecision {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 0
  const safeUsed = Number.isFinite(used) && used > 0 ? Math.trunc(used) : 0
  if (safeLimit === 0) return { exceeded: false, remaining: Number.POSITIVE_INFINITY }
  const remaining = Math.max(0, safeLimit - safeUsed)
  return { exceeded: safeUsed >= safeLimit, remaining }
}

/** 超限提示必须给出具体数字,否则用户无法判断该调到多少。 */
export function budgetExceededMessage(limit: number, used: number): string {
  return `本轮已达到 ${limit} token 的成本上限(已用 ${used})。为避免继续计费,已停止后续模型调用;已生成的内容与文件都已保留。请在设置中调高上限,或拆成更小的任务后重试。`
}

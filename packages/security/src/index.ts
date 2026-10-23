export {
  classifyPath,
  defaultSystemRoots,
  normalizePathForCompare,
  type PathCategory
} from './paths.js'
export {
  classifyRisk,
  pluginNameFromTool,
  originalToolName,
  riskFromApprovalKind,
  type BuiltinRisk,
  type ManifestToolRisk,
  type RiskAssessment,
  type RiskKind,
  type ToolCallView
} from './risk.js'
export { builtinRisk } from './builtin-risk.js'
export {
  decide,
  evaluate,
  summarizeArgs,
  type ApprovalOutcome,
  type ApprovalRequest,
  type ApprovalScope,
  type Decision,
  type GateContext,
  type GateVerdict,
} from './gate.js'
export type { PersistentGrantStore, SessionGrantStore } from './grants.js'
export {
  InMemorySessionGrants,
  MemoryPersistentGrants,
  approvalExpiry,
  type StoredGrant
} from './grants.js'

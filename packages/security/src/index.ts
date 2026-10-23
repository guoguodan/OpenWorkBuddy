export {
  classifyPath,
  defaultSystemRoots,
  normalizePathForCompare,
  resolveTargetPath,
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
  type ApprovalPlan,
  type ApprovalPlanItem,
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
export {
  MAX_BACKUP_BYTES,
  MAX_BACKUP_ENTRIES,
  MAX_DESTRUCTIVE_BATCH,
  SecurityError,
  backupDestructivePlan,
  destructiveRequestFromTool,
  executeDestructivePlan,
  inspectDestructiveRequest,
  restoreDestructiveBackup,
  type ApprovedPlanItem,
  type BackupManifest,
  type BackupManifestItem,
  type BackupResult,
  type DestructiveExecutionResult,
  type DestructiveInspectOptions,
  type DestructiveKind,
  type DestructiveOperation,
  type DestructivePlan,
  type DestructivePlanItem,
  type DestructiveRequest
} from './destructive.js'
export {
  LinuxTrashAdapter,
  MacTrashAdapter,
  MemoryTrashAdapter,
  WindowsTrashAdapter,
  platformTrashAdapter,
  type TrashAdapter,
  type TrashItem,
  type TrashOutcome
} from './trash.js'

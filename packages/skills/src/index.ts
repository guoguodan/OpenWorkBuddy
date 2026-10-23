export { parseFrontmatter, FrontmatterError } from './frontmatter.js'
export type { ParsedDocument } from './frontmatter.js'
export { SkillFrontmatterSchema, parseAllowedTools } from './schema.js'
export type { SkillFrontmatter } from './schema.js'
export {
  discoverSkills,
  loadSkill,
  narrowTools,
  validateSkillDir,
  scanSkillDir,
  SkillError,
  MAX_SKILL_BYTES
} from './skills.js'
export type {
  SkillScope,
  SkillRoot,
  SkillIndexEntry,
  SkillManifest,
  SkillIssue,
  DiscoverResult
} from './skills.js'
export { renderSkillIndex } from './index-text.js'
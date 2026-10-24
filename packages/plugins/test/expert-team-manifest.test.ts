import { describe, expect, it } from 'vitest'
import { assertManifestCoherent, parseManifest, ManifestError } from '../src/manifest.js'

const base = {
  schemaVersion: 1 as const,
  name: 'deal-team',
  displayName: '并购专家团队',
  version: '1.0.0',
  kind: 'expert' as const,
  instructions: '覆盖法律与财务视角。',
  mcpServers: {},
  permissions: [],
  credentials: [],
  highCreditTools: {}
}

describe('专家团队清单', () => {
  it('accepts a team of installed expert references', () => {
    const manifest = parseManifest({
      ...base,
      team: [
        { ref: 'legal-expert', role: '合规' },
        { ref: 'finance-expert' }
      ]
    })
    expect(manifest.team).toEqual([
      { ref: 'legal-expert', role: '合规' },
      { ref: 'finance-expert' }
    ])
    expect(() => assertManifestCoherent(manifest)).not.toThrow()
  })

  it('rejects a team that references itself', () => {
    const manifest = parseManifest({ ...base, team: [{ ref: 'deal-team' }] })
    expect(() => assertManifestCoherent(manifest)).toThrow(/不能引用自己/)
  })

  it('rejects duplicate members', () => {
    const manifest = parseManifest({
      ...base,
      team: [{ ref: 'legal-expert' }, { ref: 'legal-expert' }]
    })
    expect(() => assertManifestCoherent(manifest)).toThrow(/重复引用/)
  })

  it('rejects a team on a connector', () => {
    const manifest = parseManifest({
      ...base,
      kind: 'connector',
      instructions: undefined,
      mcpServers: { echo: { type: 'stdio', command: 'node' } },
      team: [{ ref: 'legal-expert' }]
    })
    expect(() => assertManifestCoherent(manifest)).toThrow(/connector 插件不能声明专家团队/)
  })

  it('rejects more than 16 members', () => {
    const team = Array.from({ length: 17 }, (_, index) => ({ ref: `expert-${index}` }))
    expect(() => parseManifest({ ...base, team })).toThrow(ManifestError)
  })

  it('rejects an empty team array', () => {
    expect(() => parseManifest({ ...base, team: [] })).toThrow(ManifestError)
  })

  it('rejects unknown member fields', () => {
    expect(() => parseManifest({ ...base, team: [{ ref: 'legal-expert', level: 3 }] })).toThrow(
      ManifestError
    )
  })
})

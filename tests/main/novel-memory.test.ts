import { describe, expect, it } from 'vitest'
import { mergeMemoryContent } from '../../src/main/db/repositories/novel-memory.repo'

describe('novel memory merging', () => {
  it('preserves the full card when applying a chapter delta', () => {
    const existing = '林照，二十七岁。习惯说反话，暗中调查十年前旧案。'
    const delta = '本章变化：开始怀疑师父。'

    expect(mergeMemoryContent(existing, delta)).toContain(existing)
    expect(mergeMemoryContent(existing, delta)).toContain(delta)
  })

  it('does not duplicate an already recorded update', () => {
    expect(mergeMemoryContent('完整设定\n\n新增变化', '新增变化')).toBe('完整设定\n\n新增变化')
  })

  it('deduplicates only complete normalized entries', () => {
    expect(mergeMemoryContent('完整设定\n\n新增   变化', '  新增 变化  ')).toBe('完整设定\n\n新增   变化')
  })

  it('does not drop a state change merely because it is a substring of an old entry', () => {
    expect(mergeMemoryContent('林照没有受伤', '受伤')).toBe('林照没有受伤\n\n受伤')
    expect(mergeMemoryContent('林照不再怀疑师父', '怀疑师父')).toBe('林照不再怀疑师父\n\n怀疑师父')
  })
})

import { describe, expect, it } from 'vitest'
import { computeDiff, diffSummary } from '../../src/renderer/lib/diffEngine'

describe('diffEngine', () => {
  it('summarizes added and removed lines', () => {
    const diff = computeDiff('alpha\nbeta\ngamma', 'alpha\nbeta updated\ngamma\ndelta')

    expect(diffSummary(diff)).toEqual({
      additions: 2,
      deletions: 1
    })
  })
})

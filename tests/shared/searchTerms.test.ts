import { describe, expect, it } from 'vitest'
import { tokenizeSearchText } from '../../src/shared/searchTerms'

describe('search term tokenization', () => {
  it('creates shared Chinese bigrams for natural questions and prose', () => {
    const query = new Set(tokenizeSearchText('林照为什么怀疑师父'))
    const prose = new Set(tokenizeSearchText('林照在雨夜翻出旧信，开始怀疑师父'))
    const overlap = [...query].filter(term => prose.has(term))

    expect(overlap).toEqual(expect.arrayContaining(['林照', '怀疑', '师父']))
  })

  it('keeps latin words as normal tokens', () => {
    expect(tokenizeSearchText('Story Bible v2')).toEqual(['story', 'bible', 'v2'])
  })
})

import { describe, expect, it } from 'vitest'
import {
  CHAPTER_WORDS_MAX,
  CHAPTER_WORDS_MIN,
  chapterCharBudget,
  clampChapterWordTarget
} from '../../src/shared/chapterTarget'

describe('clampChapterWordTarget', () => {
  it('keeps in-range numbers and floors them', () => {
    expect(clampChapterWordTarget(2000)).toBe(2000)
    expect(clampChapterWordTarget(2000.7)).toBe(2000)
  })

  it('clamps to the allowed bounds', () => {
    expect(clampChapterWordTarget(100)).toBe(CHAPTER_WORDS_MIN)
    expect(clampChapterWordTarget(999999)).toBe(CHAPTER_WORDS_MAX)
  })

  it('parses numeric strings', () => {
    expect(clampChapterWordTarget('3500')).toBe(3500)
  })

  it('returns null for empty/invalid/non-positive input', () => {
    expect(clampChapterWordTarget('')).toBeNull()
    expect(clampChapterWordTarget(null)).toBeNull()
    expect(clampChapterWordTarget(undefined)).toBeNull()
    expect(clampChapterWordTarget(0)).toBeNull()
    expect(clampChapterWordTarget(-5)).toBeNull()
    expect(clampChapterWordTarget('abc')).toBeNull()
  })
})

describe('chapterCharBudget', () => {
  it('derives min/max around the target', () => {
    expect(chapterCharBudget(3500)).toEqual({ min: 1575, max: 4725 })
  })

  it('falls back to the default target for invalid input', () => {
    expect(chapterCharBudget(0)).toEqual(chapterCharBudget(3500))
    expect(chapterCharBudget(Number.NaN)).toEqual(chapterCharBudget(3500))
  })
})

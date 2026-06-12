import { describe, expect, it } from 'vitest'
import { parseChapterNumber, resolveTargetChapter } from '../../src/renderer/lib/chapterTarget'
import type { ChapterData } from '../../src/preload/types'

describe('chapterTarget', () => {
  const chapters: ChapterData[] = [
    makeChapter('c1', '第一章 醒来', 0),
    makeChapter('c2', '第二章 退朝', 1),
    makeChapter('c3', '第三章 入局', 2)
  ]

  it('resolves explicit chapter ordinal from the user instruction', () => {
    const target = resolveTargetChapter(chapters, '小漫，根据第二章的细纲完成第二章', 'c1')

    expect(target?.id).toBe('c2')
  })

  it('falls back to the current chapter when no explicit target is present', () => {
    const target = resolveTargetChapter(chapters, '继续写这一章', 'c1')

    expect(target?.id).toBe('c1')
  })

  it('parses chinese chapter numbers', () => {
    expect(parseChapterNumber('二')).toBe(2)
    expect(parseChapterNumber('十二')).toBe(12)
    expect(parseChapterNumber('二十一')).toBe(21)
  })
})

function makeChapter(id: string, title: string, sortOrder: number): ChapterData {
  return {
    id,
    project_id: 'p1',
    parent_id: null,
    title,
    content: `<p>${title}</p>`,
    sort_order: sortOrder,
    word_count: 0,
    status: 'draft',
    created_at: `2026-01-01T00:00:0${sortOrder}.000Z`,
    updated_at: `2026-01-01T00:00:0${sortOrder}.000Z`
  }
}

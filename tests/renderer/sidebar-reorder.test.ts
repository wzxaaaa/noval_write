import { describe, expect, it } from 'vitest'
import type { ChapterData } from '../../src/preload/types'
import { reorderChaptersForDrop } from '../../src/renderer/components/layout/Sidebar'

describe('reorderChaptersForDrop', () => {
  it('moves a chapter after the target and rewrites local sort_order', () => {
    const result = reorderChaptersForDrop(
      [chapter('a', 0), chapter('b', 1), chapter('c', 2)],
      'a',
      'b',
      'after'
    )

    expect(result.map(ch => ch.id)).toEqual(['b', 'a', 'c'])
    expect(result.map(ch => ch.sort_order)).toEqual([0, 1, 2])
  })

  it('moves a chapter before the target and rewrites local sort_order', () => {
    const result = reorderChaptersForDrop(
      [chapter('a', 0), chapter('b', 1), chapter('c', 2)],
      'c',
      'a',
      'before'
    )

    expect(result.map(ch => ch.id)).toEqual(['c', 'a', 'b'])
    expect(result.map(ch => ch.sort_order)).toEqual([0, 1, 2])
  })

  it('keeps a stable order when incoming sort_order values are duplicated', () => {
    const result = reorderChaptersForDrop(
      [chapter('b', 0, '2026-01-02T00:00:00.000Z'), chapter('a', 0, '2026-01-01T00:00:00.000Z'), chapter('c', 0, '2026-01-03T00:00:00.000Z')],
      'c',
      'a',
      'after'
    )

    expect(result.map(ch => ch.id)).toEqual(['a', 'c', 'b'])
    expect(result.map(ch => ch.sort_order)).toEqual([0, 1, 2])
  })
})

function chapter(id: string, sortOrder: number, createdAt = `2026-01-0${sortOrder + 1}T00:00:00.000Z`): ChapterData {
  return {
    id,
    project_id: 'project-1',
    parent_id: null,
    title: id,
    content: '',
    sort_order: sortOrder,
    word_count: 0,
    status: 'draft',
    created_at: createdAt,
    updated_at: createdAt
  }
}

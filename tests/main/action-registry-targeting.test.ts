import { describe, expect, it, vi } from 'vitest'

const fixtures = vi.hoisted(() => ({
  chapters: [
    {
      id: 'chapter-1', project_id: 'project-1', parent_id: null, title: '第一章',
      content: '<p>old one</p>', sort_order: 0, word_count: 2, status: 'draft',
      created_at: '2026-01-01', updated_at: '2026-01-01'
    },
    {
      id: 'chapter-2', project_id: 'project-1', parent_id: null, title: '第二章',
      content: '<p>old two</p>', sort_order: 1, word_count: 2, status: 'draft',
      created_at: '2026-01-02', updated_at: '2026-01-02'
    }
  ]
}))

vi.mock('../../src/main/db/repositories/chapter.repo', () => ({
  chapterRepo: {
    listByProject: () => fixtures.chapters
  }
}))

import { ActionRegistry } from '../../src/main/services/actions/action-registry'

describe('ActionRegistry chapter target binding', () => {
  it('uses a resolved chapter for a later targetless action in the same round', async () => {
    const registry = new ActionRegistry({ projectId: 'project-1', chapterId: 'chapter-1' })

    expect((await registry.execute({ name: 'resolve_chapter', input: { chapterId: 'chapter-2' } })).ok).toBe(true)
    const proposal = await registry.execute({
      name: 'propose_chapter_edit',
      input: { content: 'replacement two' }
    })

    expect(proposal.ok).toBe(true)
    expect(proposal.uiEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'chapter_proposal', chapterId: 'chapter-2' })
    ]))
  })

  it('does not fall back to the current chapter for an unresolved explicit target', async () => {
    const registry = new ActionRegistry({ projectId: 'project-1', chapterId: 'chapter-1' })
    const result = await registry.execute({
      name: 'propose_chapter_edit',
      input: { chapterId: 'missing', content: 'must not touch current chapter' }
    })

    expect(result.ok).toBe(false)
  })

  it('clears the old current target after an explicit resolution failure', async () => {
    const registry = new ActionRegistry({ projectId: 'project-1', chapterId: 'chapter-1' })
    expect((await registry.execute({ name: 'resolve_chapter', input: { chapterId: 'missing' } })).ok).toBe(false)

    const result = await registry.execute({
      name: 'propose_chapter_edit',
      input: { content: 'must not touch the old current chapter' }
    })
    expect(result.ok).toBe(false)
  })

  it('keeps a locked current write target while other chapters are read or selected as references', async () => {
    const registry = new ActionRegistry({ projectId: 'project-1', chapterId: 'chapter-1' })
    registry.lockChapterTarget()

    expect((await registry.execute({ name: 'read_chapter', input: { chapterId: 'chapter-2' } })).ok).toBe(true)
    expect((await registry.execute({ name: 'select_chapter', input: { chapterId: 'chapter-2' } })).ok).toBe(true)
    const proposal = await registry.execute({
      name: 'propose_chapter_edit',
      input: { content: 'replacement for the locked current chapter' }
    })

    expect(proposal.ok).toBe(true)
    expect(proposal.uiEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'chapter_proposal', chapterId: 'chapter-1' })
    ]))
  })
})

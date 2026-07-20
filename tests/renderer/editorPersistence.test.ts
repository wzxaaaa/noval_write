import { describe, expect, it, vi } from 'vitest'
import {
  flushPendingEditorWrites,
  getChapterSaveSnapshot,
  registerPendingWriteFlusher,
  shouldSaveChapterOnSwitch
} from '../../src/renderer/components/editor/editorPersistence'

describe('editor persistence', () => {
  it('does not persist an unaccepted agent proposal when switching chapters', () => {
    expect(shouldSaveChapterOnSwitch({ isDirty: true, agentProposal: true })).toBe(false)
  })

  it('persists ordinary dirty editor content when switching chapters', () => {
    expect(shouldSaveChapterOnSwitch({ isDirty: true, agentProposal: false })).toBe(true)
    expect(shouldSaveChapterOnSwitch({ isDirty: false, agentProposal: false })).toBe(false)
  })

  it('always saves content under the chapter it was loaded from', () => {
    expect(getChapterSaveSnapshot({
      loadedChapterId: 'chapter-a',
      content: 'A draft',
      isDirty: true,
      agentProposal: false
    }, 'chapter-b')).toEqual({ chapterId: 'chapter-a', content: 'A draft' })

    expect(getChapterSaveSnapshot({
      loadedChapterId: 'chapter-a',
      content: 'A draft',
      isDirty: true,
      agentProposal: false
    }, 'chapter-a')).toBeNull()
  })

  it('persists user content when an AI proposal conflicts with newer edits', () => {
    expect(shouldSaveChapterOnSwitch({
      isDirty: true,
      agentProposal: true,
      agentProposalConflict: true
    })).toBe(true)
  })

  it('flushes all registered pending writers', async () => {
    const first = vi.fn(async () => undefined)
    const second = vi.fn(async () => undefined)
    const removeFirst = registerPendingWriteFlusher(first)
    const removeSecond = registerPendingWriteFlusher(second)

    await flushPendingEditorWrites()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)

    removeFirst()
    removeSecond()
  })
})

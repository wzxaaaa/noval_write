import React from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChapterData } from '../../src/preload/types'
import { useEditorStore } from '../../src/renderer/stores/editor.store'
import { useProjectStore } from '../../src/renderer/stores/project.store'

Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
  configurable: true,
  value: vi.fn()
})

const tiptap = vi.hoisted(() => {
  const editor = {
    commands: {
      setContent: vi.fn((content: string) => { tiptap.html = content }),
      focus: vi.fn()
    },
    getHTML: vi.fn(() => tiptap.html),
    isActive: vi.fn(() => false),
    chain: vi.fn(),
    state: {
      selection: { from: 0, to: 0 },
      doc: {
        textBetween: vi.fn(() => ''),
        descendants: vi.fn()
      }
    },
    view: { dispatch: vi.fn() }
  }
  return { editor, html: '' }
})

vi.mock('@tiptap/react', () => ({
  useEditor: () => tiptap.editor,
  EditorContent: () => <div data-testid="editor-content" />
}))

vi.mock('@tiptap/starter-kit', () => ({ default: {} }))
vi.mock('@tiptap/extension-placeholder', () => ({
  default: { configure: () => ({}) }
}))

import { NovelEditor } from '../../src/renderer/components/editor/NovelEditor'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

function chapter(id: string, content: string): ChapterData {
  return {
    id,
    project_id: 'project-1',
    parent_id: null,
    title: id,
    content,
    sort_order: Number(id.slice(-1)) || 0,
    word_count: content.length,
    status: 'draft',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z'
  }
}

function installElectronApi(
  listChapters: () => Promise<ChapterData[]>,
  saveChapter = vi.fn(async (id: string, content: string) => ({ ...chapter(id, content), content }))
) {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      file: {
        listChapters,
        saveChapter,
        renameChapter: vi.fn(async () => undefined),
        createChapter: vi.fn()
      },
      agent: { onChapterUpdate: vi.fn(() => () => {}) }
    }
  })
  return saveChapter
}

describe('NovelEditor persistence ownership', () => {
  beforeEach(() => {
    act(() => useEditorStore.getState().reset())
    useProjectStore.getState().setChapters([])
    tiptap.html = ''
    vi.clearAllMocks()
  })

  afterEach(() => cleanup())

  it('never saves A content under B during overlapping A → B → C loads', async () => {
    const chapters = [chapter('chapter-1', 'A original'), chapter('chapter-2', 'B original'), chapter('chapter-3', 'C original')]
    const delayedBLoad = deferred<ChapterData[]>()
    const listChapters = vi.fn()
      .mockResolvedValueOnce(chapters)
      .mockReturnValueOnce(delayedBLoad.promise)
      .mockResolvedValueOnce(chapters)
    const saveChapter = installElectronApi(listChapters)

    const view = render(
      <NovelEditor chapterId="chapter-1" projectId="project-1" onSelectChapter={vi.fn()} />
    )
    await waitFor(() => expect(useEditorStore.getState().loadedChapterId).toBe('chapter-1'))

    act(() => useEditorStore.getState().setContent('A latest draft'))
    view.rerender(
      <NovelEditor chapterId="chapter-2" projectId="project-1" onSelectChapter={vi.fn()} />
    )
    await waitFor(() => expect(listChapters).toHaveBeenCalledTimes(2))

    view.rerender(
      <NovelEditor chapterId="chapter-3" projectId="project-1" onSelectChapter={vi.fn()} />
    )
    await waitFor(() => expect(useEditorStore.getState().loadedChapterId).toBe('chapter-3'))

    await act(async () => {
      delayedBLoad.resolve(chapters)
      await delayedBLoad.promise
    })

    expect(saveChapter).toHaveBeenCalledWith('chapter-1', 'A latest draft')
    expect(saveChapter.mock.calls.some(([id, content]) => id === 'chapter-2' && content === 'A latest draft')).toBe(false)
    expect(useEditorStore.getState().loadedChapterId).toBe('chapter-3')
  })

  it('restores an unconfirmed proposal when returning to its chapter', async () => {
    const chapterA = chapter('chapter-1', 'old draft')
    const chapterB = chapter('chapter-2', 'B draft')
    const chapters = [chapterA, chapterB]
    const saveChapter = installElectronApi(vi.fn(async () => chapters))

    const view = render(
      <NovelEditor chapterId="chapter-1" projectId="project-1" onSelectChapter={vi.fn()} />
    )
    await waitFor(() => expect(useEditorStore.getState().loadedChapterId).toBe('chapter-1'))

    act(() => useEditorStore.getState().applyAgentContent('AI proposal', 'old draft'))
    chapterA.content = 'AI proposal'
    view.rerender(
      <NovelEditor chapterId="chapter-2" projectId="project-1" onSelectChapter={vi.fn()} />
    )
    await waitFor(() => expect(useEditorStore.getState().loadedChapterId).toBe('chapter-2'))

    view.rerender(
      <NovelEditor chapterId="chapter-1" projectId="project-1" onSelectChapter={vi.fn()} />
    )
    await waitFor(() => expect(useEditorStore.getState().agentProposal).toBe(true))

    expect(useEditorStore.getState()).toMatchObject({
      loadedChapterId: 'chapter-1',
      content: 'AI proposal',
      agentOldContent: 'old draft'
    })
    expect(saveChapter).not.toHaveBeenCalled()
  })
})

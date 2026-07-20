import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAutoSave } from '../../src/renderer/hooks/useAutoSave'
import { useEditorStore } from '../../src/renderer/stores/editor.store'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('useAutoSave', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    act(() => useEditorStore.getState().reset())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('serializes saves and does not let an old completion mark newer content clean', async () => {
    const saves: Array<{ content: string; completion: Deferred<void> }> = []
    const saveFn = vi.fn((_chapterId: string, content: string) => {
      const completion = deferred<void>()
      saves.push({ content, completion })
      return completion.promise
    })

    const hook = renderHook(() => useAutoSave('chapter-1', saveFn, 100))

    act(() => useEditorStore.getState().setContent('first draft'))
    await act(async () => {
      vi.advanceTimersByTime(100)
      await Promise.resolve()
    })
    expect(saveFn).toHaveBeenCalledTimes(1)
    expect(saves[0].content).toBe('first draft')

    act(() => useEditorStore.getState().setContent('newer draft'))
    await act(async () => {
      vi.advanceTimersByTime(100)
      await Promise.resolve()
    })
    expect(saveFn).toHaveBeenCalledTimes(1)

    await act(async () => {
      saves[0].completion.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(saveFn).toHaveBeenCalledTimes(2)
    expect(saves[1].content).toBe('newer draft')
    expect(useEditorStore.getState().isDirty).toBe(true)

    await act(async () => {
      saves[1].completion.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(useEditorStore.getState().isDirty).toBe(false)
    expect(useEditorStore.getState().isSaving).toBe(false)

    hook.unmount()
  })

  it('never auto-saves an unaccepted agent proposal', async () => {
    const saveFn = vi.fn(async () => undefined)
    renderHook(() => useAutoSave('chapter-1', saveFn, 100))

    act(() => {
      useEditorStore.getState().loadChapter('chapter-1', 'Chapter', 'original')
      useEditorStore.getState().applyAgentContent('proposal')
      vi.advanceTimersByTime(1000)
    })
    await act(async () => Promise.resolve())

    expect(saveFn).not.toHaveBeenCalled()
    expect(useEditorStore.getState().agentProposal).toBe(true)
    expect(useEditorStore.getState().isDirty).toBe(true)
  })

  it('flushes dirty content before the debounce timer expires', async () => {
    const saveFn = vi.fn(async () => undefined)
    const { result } = renderHook(() => useAutoSave('chapter-1', saveFn, 1000))

    act(() => useEditorStore.getState().setContent('last keystrokes'))
    await act(async () => result.current.flush())

    expect(saveFn).toHaveBeenCalledTimes(1)
    expect(saveFn).toHaveBeenCalledWith('chapter-1', 'last keystrokes')
    expect(useEditorStore.getState().isDirty).toBe(false)
  })
})

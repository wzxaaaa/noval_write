import { useCallback, useEffect, useRef } from 'react'
import { useEditorStore } from '../stores/editor.store'

interface QueuedSave {
  chapterId: string
  content: string
  save: (id: string, content: string) => Promise<void>
}

export function useAutoSave(
  chapterId: string | null,
  saveFn: (id: string, content: string) => Promise<void>,
  intervalMs: number = 2000
) {
  const { content, isDirty, agentProposal, agentProposalConflict, markSaving } = useEditorStore()
  const timerRef = useRef<ReturnType<typeof setTimeout>>()
  const saveFnRef = useRef(saveFn)
  const currentChapterIdRef = useRef(chapterId)
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const queuedSaveCountRef = useRef(0)

  saveFnRef.current = saveFn
  currentChapterIdRef.current = chapterId

  const saveNow = useCallback((id: string, contentToSave: string): Promise<void> => {
    const request: QueuedSave = {
      chapterId: id,
      content: contentToSave,
      save: saveFnRef.current
    }

    queuedSaveCountRef.current += 1
    if (queuedSaveCountRef.current === 1) {
      markSaving(true)
    }

    const operation = saveChainRef.current
      .catch(() => undefined)
      .then(async () => {
        await request.save(request.chapterId, request.content)

        const state = useEditorStore.getState()
        if (
          currentChapterIdRef.current === request.chapterId &&
          state.content === request.content &&
          state.isDirty &&
          (!state.agentProposal || state.agentProposalConflict)
        ) {
          state.markClean()
        }
      })
      .finally(() => {
        queuedSaveCountRef.current -= 1
        if (queuedSaveCountRef.current === 0) {
          markSaving(false)
        }
      })

    // Keep failures observable to the caller while allowing later saves to run.
    saveChainRef.current = operation.then(() => undefined, () => undefined)
    return operation
  }, [markSaving])

  useEffect(() => {
    if (!chapterId || !isDirty || (agentProposal && !agentProposalConflict)) return

    timerRef.current = setTimeout(() => {
      void saveNow(chapterId, content).catch((err) => {
        console.error('Auto-save failed:', err)
      })
    }, intervalMs)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [content, chapterId, isDirty, agentProposal, agentProposalConflict, intervalMs, saveNow])

  const flush = useCallback(async (): Promise<void> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = undefined
    }

    const state = useEditorStore.getState()
    const id = currentChapterIdRef.current
    if (id && state.isDirty && (!state.agentProposal || state.agentProposalConflict)) {
      await saveNow(id, state.content)
    }
    await saveChainRef.current
  }, [saveNow])

  return { saveNow, flush }
}

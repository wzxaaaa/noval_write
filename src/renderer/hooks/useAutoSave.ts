import { useEffect, useRef } from 'react'
import { useEditorStore } from '../stores/editor.store'

export function useAutoSave(
  chapterId: string | null,
  saveFn: (id: string, content: string) => Promise<void>,
  intervalMs: number = 2000
) {
  const { content, isDirty, agentProposal, markClean, markSaving } = useEditorStore()
  const timerRef = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    if (!chapterId || !isDirty || agentProposal) return

    timerRef.current = setTimeout(async () => {
      markSaving(true)
      try {
        await saveFn(chapterId, content)
        markClean()
      } catch (err) {
        console.error('Auto-save failed:', err)
      } finally {
        markSaving(false)
      }
    }, intervalMs)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [content, chapterId, isDirty, agentProposal, intervalMs, saveFn, markClean, markSaving])
}

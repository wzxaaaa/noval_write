export interface ChapterSwitchState {
  isDirty: boolean
  agentProposal: boolean
  agentProposalConflict?: boolean
}

export function shouldSaveChapterOnSwitch(state: ChapterSwitchState): boolean {
  return state.isDirty && (!state.agentProposal || Boolean(state.agentProposalConflict))
}

export interface OwnedChapterSwitchState extends ChapterSwitchState {
  loadedChapterId: string | null
  content: string
}

export interface ChapterSaveSnapshot {
  chapterId: string
  content: string
}

/**
 * Returns a save request whose chapter id and content come from the same
 * loaded editor snapshot. The selected chapter id is deliberately only used
 * to decide whether a switch is happening.
 */
export function getChapterSaveSnapshot(
  state: OwnedChapterSwitchState,
  selectedChapterId: string | null
): ChapterSaveSnapshot | null {
  if (!state.loadedChapterId || state.loadedChapterId === selectedChapterId) return null
  if (!shouldSaveChapterOnSwitch(state)) return null
  return { chapterId: state.loadedChapterId, content: state.content }
}

type PendingWriteFlusher = () => Promise<void>
const pendingWriteFlushers = new Set<PendingWriteFlusher>()

export function registerPendingWriteFlusher(flusher: PendingWriteFlusher): () => void {
  pendingWriteFlushers.add(flusher)
  return () => pendingWriteFlushers.delete(flusher)
}

export async function flushPendingEditorWrites(): Promise<void> {
  await Promise.all(Array.from(pendingWriteFlushers, flusher => flusher()))
}

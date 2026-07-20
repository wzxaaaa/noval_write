import { create } from 'zustand'
import { countContentChars } from '../../shared/textMetrics'

interface EditorState {
  loadedChapterId: string | null
  content: string
  title: string
  wordCount: number
  selectedText: string
  isDirty: boolean
  isSaving: boolean
  lastSaved: string | null
  // Agent proposal state
  agentOldContent: string | null
  agentProposedContent: string | null
  agentProposal: boolean
  agentProposalConflict: boolean
  setContent: (content: string) => void
  setTitle: (title: string) => void
  setSelectedText: (text: string) => void
  loadChapter: (chapterId: string, title: string, content: string) => void
  markClean: () => void
  markSaving: (saving: boolean) => void
  applyAgentContent: (newContent: string, oldContent?: string, conflict?: boolean) => void
  acceptAgentChange: () => void
  rejectAgentChange: () => void
  reset: () => void
}

export const useEditorStore = create<EditorState>((set, get) => ({
  loadedChapterId: null,
  content: '',
  title: '',
  wordCount: 0,
  selectedText: '',
  isDirty: false,
  isSaving: false,
  lastSaved: null,
  agentOldContent: null,
  agentProposedContent: null,
  agentProposal: false,
  agentProposalConflict: false,
  setContent: (content) => set((state) => ({
    content,
    wordCount: countContentChars(content),
    isDirty: true,
    agentOldContent: state.agentProposal && state.agentProposalConflict
      ? content
      : state.agentOldContent,
    agentProposedContent: state.agentProposal && !state.agentProposalConflict
      ? content
      : state.agentProposedContent
  })),
  setTitle: (title) => set({ title }),
  setSelectedText: (text) => set({ selectedText: text }),
  loadChapter: (chapterId, title, content) => set({
    loadedChapterId: chapterId,
    content,
    title,
    wordCount: countContentChars(content),
    selectedText: '',
    isDirty: false,
    isSaving: false,
    lastSaved: null,
    agentOldContent: null,
    agentProposedContent: null,
    agentProposal: false,
    agentProposalConflict: false
  }),
  markClean: () => set({ isDirty: false, lastSaved: new Date().toISOString() }),
  markSaving: (saving) => set({ isSaving: saving }),
  // 回滚基线优先用调用方传入的 oldContent：流水线"先写库"场景下，编辑器
  // 此刻加载的可能已经是新内容，取 get().content 会导致"拒绝"恢复成新稿。
  applyAgentContent: (newContent, oldContent, conflict = false) => {
    const current = get()
    const content = conflict ? current.content : newContent
    set({
      agentOldContent: conflict ? current.content : (oldContent ?? current.content),
      agentProposedContent: newContent,
      content,
      wordCount: countContentChars(content),
      isDirty: conflict ? current.isDirty : true,
      agentProposal: true,
      agentProposalConflict: conflict
    })
  },
  acceptAgentChange: () => {
    const { agentProposedContent, content } = get()
    const acceptedContent = agentProposedContent ?? content
    set({
      content: acceptedContent,
      wordCount: countContentChars(acceptedContent),
      isDirty: true,
      agentOldContent: null,
      agentProposedContent: null,
      agentProposal: false,
      agentProposalConflict: false
    })
  },
  rejectAgentChange: () => {
    const { agentOldContent } = get()
    if (agentOldContent !== null) {
      set({
        content: agentOldContent,
        wordCount: countContentChars(agentOldContent),
        agentOldContent: null,
        agentProposedContent: null,
        agentProposal: false,
        agentProposalConflict: false,
        isDirty: true
      })
    }
  },
  reset: () => set({ loadedChapterId: null, content: '', title: '', wordCount: 0, selectedText: '', isDirty: false, isSaving: false, lastSaved: null, agentOldContent: null, agentProposedContent: null, agentProposal: false, agentProposalConflict: false })
}))

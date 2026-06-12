import { create } from 'zustand'
import { countContentChars } from '../../shared/textMetrics'

interface EditorState {
  content: string
  title: string
  wordCount: number
  selectedText: string
  isDirty: boolean
  isSaving: boolean
  lastSaved: string | null
  // Agent proposal state
  agentOldContent: string | null
  agentProposal: boolean
  setContent: (content: string) => void
  setTitle: (title: string) => void
  setSelectedText: (text: string) => void
  loadChapter: (title: string, content: string) => void
  markClean: () => void
  markSaving: (saving: boolean) => void
  applyAgentContent: (newContent: string) => void
  acceptAgentChange: () => void
  rejectAgentChange: () => void
  reset: () => void
}

export const useEditorStore = create<EditorState>((set, get) => ({
  content: '',
  title: '',
  wordCount: 0,
  selectedText: '',
  isDirty: false,
  isSaving: false,
  lastSaved: null,
  agentOldContent: null,
  agentProposal: false,
  setContent: (content) => set({
    content,
    wordCount: countContentChars(content),
    isDirty: true
  }),
  setTitle: (title) => set({ title }),
  setSelectedText: (text) => set({ selectedText: text }),
  loadChapter: (title, content) => set({
    content,
    title,
    wordCount: countContentChars(content),
    selectedText: '',
    isDirty: false,
    isSaving: false,
    lastSaved: null,
    agentOldContent: null,
    agentProposal: false
  }),
  markClean: () => set({ isDirty: false, lastSaved: new Date().toISOString() }),
  markSaving: (saving) => set({ isSaving: saving }),
  applyAgentContent: (newContent) => set({
    agentOldContent: get().content,
    content: newContent,
    wordCount: countContentChars(newContent),
    isDirty: true,
    agentProposal: true
  }),
  acceptAgentChange: () => set({
    agentOldContent: null,
    agentProposal: false
  }),
  rejectAgentChange: () => {
    const { agentOldContent } = get()
    if (agentOldContent !== null) {
      set({
        content: agentOldContent,
        wordCount: countContentChars(agentOldContent),
        agentOldContent: null,
        agentProposal: false,
        isDirty: true
      })
    }
  },
  reset: () => set({ content: '', title: '', wordCount: 0, selectedText: '', isDirty: false, isSaving: false, lastSaved: null, agentOldContent: null, agentProposal: false })
}))

import { create } from 'zustand'
import type { ChapterData, ProjectSummary } from '../../preload/types'

interface ProjectState {
  projects: ProjectSummary[]
  chapters: ChapterData[]
  currentProjectId: string | null
  currentChapterId: string | null
  setProjects: (projects: ProjectSummary[]) => void
  setChapters: (chapters: ChapterData[]) => void
  setCurrentProject: (id: string | null) => void
  setCurrentChapter: (id: string | null) => void
  addChapter: (chapter: ChapterData) => void
  removeChapter: (id: string) => void
  updateChapter: (id: string, updates: Partial<ChapterData>) => void
}

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],
  chapters: [],
  currentProjectId: null,
  currentChapterId: null,
  setProjects: (projects) => set({ projects }),
  setChapters: (chapters) => set({ chapters }),
  setCurrentProject: (id) => set({ currentProjectId: id }),
  setCurrentChapter: (id) => set({ currentChapterId: id }),
  addChapter: (chapter) => set((s) => ({
    chapters: [...s.chapters.filter(c => c.id !== chapter.id), chapter]
      .sort((a, b) => a.sort_order - b.sort_order)
  })),
  removeChapter: (id) => set((s) => ({ chapters: s.chapters.filter(c => c.id !== id) })),
  updateChapter: (id, updates) => set((s) => ({
    chapters: s.chapters.map(c => c.id === id ? { ...c, ...updates } : c)
  }))
}))

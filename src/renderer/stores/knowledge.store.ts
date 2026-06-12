import { create } from 'zustand'
import type { KnowledgeDoc, SearchResult } from '../../preload/types'

interface KnowledgeState {
  documents: KnowledgeDoc[]
  searchResults: SearchResult[]
  searchQuery: string
  isSearching: boolean
  setDocuments: (docs: KnowledgeDoc[]) => void
  addDocument: (doc: KnowledgeDoc) => void
  removeDocument: (id: string) => void
  setSearchResults: (results: SearchResult[]) => void
  setSearchQuery: (query: string) => void
  setSearching: (searching: boolean) => void
}

export const useKnowledgeStore = create<KnowledgeState>((set) => ({
  documents: [],
  searchResults: [],
  searchQuery: '',
  isSearching: false,
  setDocuments: (docs) => set({ documents: docs }),
  addDocument: (doc) => set((s) => ({ documents: [...s.documents, doc] })),
  removeDocument: (id) => set((s) => ({
    documents: s.documents.filter(d => d.id !== id)
  })),
  setSearchResults: (results) => set({ searchResults: results }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSearching: (searching) => set({ isSearching: searching })
}))

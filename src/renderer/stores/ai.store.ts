import { create } from 'zustand'
import type { ProviderConfig, ConversationData, MessageData } from '../../preload/types'

interface AIState {
  providers: ProviderConfig[]
  conversations: ConversationData[]
  messages: MessageData[]
  currentConversationId: string | null
  streamingContent: string
  isStreaming: boolean
  setProviders: (providers: ProviderConfig[]) => void
  addProvider: (provider: ProviderConfig) => void
  updateProvider: (id: string, updates: Partial<ProviderConfig>) => void
  removeProvider: (id: string) => void
  setConversations: (conversations: ConversationData[]) => void
  addConversation: (conv: ConversationData) => void
  setCurrentConversation: (id: string | null) => void
  setMessages: (messages: MessageData[]) => void
  addMessage: (message: MessageData) => void
  appendStreamToken: (token: string) => void
  clearStream: () => void
  setStreaming: (streaming: boolean) => void
}

export const useAIStore = create<AIState>((set) => ({
  providers: [],
  conversations: [],
  messages: [],
  currentConversationId: null,
  streamingContent: '',
  isStreaming: false,
  setProviders: (providers) => set({ providers }),
  addProvider: (provider) => set((s) => ({ providers: [...s.providers, provider] })),
  updateProvider: (id, updates) => set((s) => ({
    providers: s.providers.map(p => p.id === id ? { ...p, ...updates } : p)
  })),
  removeProvider: (id) => set((s) => ({
    providers: s.providers.filter(p => p.id !== id)
  })),
  setConversations: (conversations) => set({ conversations }),
  addConversation: (conv) => set((s) => ({ conversations: [conv, ...s.conversations] })),
  setCurrentConversation: (id) => set({ currentConversationId: id }),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) => set((s) => ({ messages: [...s.messages, message] })),
  appendStreamToken: (token) => set((s) => ({ streamingContent: s.streamingContent + token })),
  clearStream: () => set({ streamingContent: '' }),
  setStreaming: (streaming) => set({ isStreaming: streaming })
}))

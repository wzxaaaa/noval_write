import { create } from 'zustand'
import type { ProviderConfig, ConversationData, MessageData } from '../../preload/types'

interface AIState {
  providers: ProviderConfig[]
  conversations: ConversationData[]
  messages: MessageData[]
  currentConversationId: string | null
  streamingContent: string
  streamingThinking: string
  /** 按会话跟踪流式状态：切换会话不打断也不误报其他会话的进行中请求。 */
  streamingConversations: Record<string, boolean>
  setProviders: (providers: ProviderConfig[]) => void
  addProvider: (provider: ProviderConfig) => void
  updateProvider: (id: string, updates: Partial<ProviderConfig>) => void
  removeProvider: (id: string) => void
  setConversations: (conversations: ConversationData[]) => void
  addConversation: (conv: ConversationData) => void
  removeConversation: (id: string) => void
  setCurrentConversation: (id: string | null) => void
  setMessages: (messages: MessageData[]) => void
  addMessage: (message: MessageData) => void
  appendStreamToken: (token: string) => void
  appendStreamThinking: (thinking: string) => void
  clearStream: () => void
  setConversationStreaming: (conversationId: string, streaming: boolean) => void
}

export function isConversationStreaming(
  streamingConversations: Record<string, boolean>,
  conversationId: string | null
): boolean {
  return !!(conversationId && streamingConversations[conversationId])
}

export function applyProviderUpdate(
  providers: ProviderConfig[],
  id: string,
  updates: Partial<ProviderConfig>
): ProviderConfig[] {
  const makesDefault = updates.is_default === 1 || (updates.is_default as unknown) === true
  return providers.map(provider => {
    if (provider.id === id) return { ...provider, ...updates }
    if (makesDefault && provider.is_default !== 0) return { ...provider, is_default: 0 }
    return provider
  })
}

export function appendProvider(providers: ProviderConfig[], provider: ProviderConfig): ProviderConfig[] {
  const existing = provider.is_default === 1
    ? providers.map(item => item.is_default === 0 ? item : { ...item, is_default: 0 })
    : providers
  return [...existing, provider]
}

export const useAIStore = create<AIState>((set) => ({
  providers: [],
  conversations: [],
  messages: [],
  currentConversationId: null,
  streamingContent: '',
  streamingThinking: '',
  streamingConversations: {},
  setProviders: (providers) => set({ providers }),
  addProvider: (provider) => set((s) => ({ providers: appendProvider(s.providers, provider) })),
  updateProvider: (id, updates) => set((s) => ({
    providers: applyProviderUpdate(s.providers, id, updates)
  })),
  removeProvider: (id) => set((s) => ({
    providers: s.providers.filter(p => p.id !== id)
  })),
  setConversations: (conversations) => set({ conversations }),
  addConversation: (conv) => set((s) => ({ conversations: [conv, ...s.conversations] })),
  removeConversation: (id) => set((s) => ({
    conversations: s.conversations.filter(conv => conv.id !== id),
    currentConversationId: s.currentConversationId === id ? null : s.currentConversationId,
    messages: s.currentConversationId === id ? [] : s.messages
  })),
  setCurrentConversation: (id) => set({ currentConversationId: id }),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) => set((s) => ({ messages: [...s.messages, message] })),
  appendStreamToken: (token) => set((s) => ({ streamingContent: s.streamingContent + token })),
  appendStreamThinking: (thinking) => set((s) => ({ streamingThinking: s.streamingThinking + thinking })),
  clearStream: () => set({ streamingContent: '', streamingThinking: '' }),
  setConversationStreaming: (conversationId, streaming) => set((s) => {
    const next = { ...s.streamingConversations }
    if (streaming) next[conversationId] = true
    else delete next[conversationId]
    return { streamingConversations: next }
  })
}))

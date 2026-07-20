import { useEffect } from 'react'
import { useAIStore } from '../stores/ai.store'
import type { AppPanel } from '../../shared/appActions'

interface AppAgentSendContext {
  projectId: string
  chapterId?: string | null
  currentPanel?: AppPanel | null
}

const activeSendRequests = new Map<string, symbol>()

export function useAIStream() {
  const { clearStream, setConversationStreaming, addMessage } = useAIStore()

  useEffect(() => {
    const unsubscribe = window.electronAPI.ai.onToken((data) => {
      const { currentConversationId, appendStreamToken } = useAIStore.getState()
      if (data.conversationId === currentConversationId) {
        appendStreamToken(data.token)
      }
    })

    const unsubscribeThinking = window.electronAPI.ai.onThinking((data) => {
      const { currentConversationId, appendStreamThinking } = useAIStore.getState()
      if (data.conversationId === currentConversationId) {
        appendStreamThinking(data.thinking)
      }
    })

    return () => {
      unsubscribe()
      unsubscribeThinking()
    }
  }, [])

  const sendMessage = async (
    conversationId: string,
    providerConfigId: string,
    content: string,
    aiParams?: Record<string, unknown>,
    appAgentContext?: AppAgentSendContext
  ) => {
    // 流式状态由这里单一管理（按会话），调用方不要再另行维护
    const requestId = Symbol(conversationId)
    activeSendRequests.set(conversationId, requestId)
    clearStream()
    setConversationStreaming(conversationId, true)
    const previousMessages = useAIStore.getState().messages.map(({ role, content }) => ({ role, content }))
    const latestPreviousMessage = previousMessages[previousMessages.length - 1]
    const isRetryOfUnansweredMessage = latestPreviousMessage?.role === 'user' &&
      latestPreviousMessage.content === content
    const outgoingMessages = isRetryOfUnansweredMessage
      ? previousMessages
      : [...previousMessages, { role: 'user' as const, content }]

    if (!isRetryOfUnansweredMessage) {
      addMessage({
        id: `temp-${Date.now()}`,
        conversation_id: conversationId,
        role: 'user',
        content,
        token_count: null,
        agent_id: null,
        metadata: '{}',
        created_at: new Date().toISOString()
      })
    }

    try {
      if (appAgentContext) {
        return await window.electronAPI.appAgent.sendMessage({
          conversationId,
          providerConfigId,
          projectId: appAgentContext.projectId,
          chapterId: appAgentContext.chapterId,
          currentPanel: appAgentContext.currentPanel,
          messages: outgoingMessages,
          userMessage: content,
          aiParams
        })
      }

      return await window.electronAPI.ai.sendMessage({
        conversationId,
        providerConfigId,
        messages: outgoingMessages,
        userMessage: content,
        aiParams
      })
    } finally {
      if (activeSendRequests.get(conversationId) === requestId) {
        activeSendRequests.delete(conversationId)
        setConversationStreaming(conversationId, false)
      }
    }
  }

  return { sendMessage }
}

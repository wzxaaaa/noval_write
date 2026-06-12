import { useEffect } from 'react'
import { useAIStore } from '../stores/ai.store'
import type { AppPanel } from '../../shared/appActions'

interface AppAgentSendContext {
  projectId: string
  chapterId?: string | null
  currentPanel?: AppPanel | null
}

export function useAIStream() {
  const { clearStream, setStreaming, addMessage } = useAIStore()

  useEffect(() => {
    const unsubscribe = window.electronAPI.ai.onToken((data) => {
      const { currentConversationId, appendStreamToken } = useAIStore.getState()
      if (data.conversationId === currentConversationId) {
        appendStreamToken(data.token)
      }
    })

    return unsubscribe
  }, [])

  const sendMessage = async (
    conversationId: string,
    providerConfigId: string,
    content: string,
    aiParams?: Record<string, unknown>,
    appAgentContext?: AppAgentSendContext
  ) => {
    clearStream()
    setStreaming(true)
    const previousMessages = useAIStore.getState().messages.map(({ role, content }) => ({ role, content }))

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

    try {
      if (appAgentContext) {
        return await window.electronAPI.appAgent.sendMessage({
          conversationId,
          providerConfigId,
          projectId: appAgentContext.projectId,
          chapterId: appAgentContext.chapterId,
          currentPanel: appAgentContext.currentPanel,
          messages: [
            ...previousMessages,
            { role: 'user' as const, content }
          ],
          aiParams
        })
      }

      return await window.electronAPI.ai.sendMessage({
        conversationId,
        providerConfigId,
        messages: [
          ...previousMessages,
          { role: 'user' as const, content }
        ],
        aiParams
      })
    } finally {
      setStreaming(false)
    }
  }

  return { sendMessage }
}

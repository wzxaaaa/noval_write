import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageData } from '../../src/preload/types'
import { useAIStream } from '../../src/renderer/hooks/useAIStream'
import { isConversationStreaming, useAIStore } from '../../src/renderer/stores/ai.store'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function userMessage(content: string): MessageData {
  return {
    id: 'persisted-user',
    conversation_id: 'conversation-1',
    role: 'user',
    content,
    token_count: null,
    agent_id: null,
    metadata: '{}',
    created_at: '2026-01-01T00:00:00.000Z'
  }
}

describe('useAIStream request ownership', () => {
  beforeEach(() => {
    useAIStore.setState({
      messages: [],
      currentConversationId: 'conversation-1',
      streamingContent: '',
      streamingThinking: '',
      streamingConversations: {}
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('reuses an unanswered user turn when retrying instead of appending it again', async () => {
    const sendMessage = vi.fn(async () => ({
      conversationId: 'conversation-1',
      content: 'reply',
      actionResults: []
    }))
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        ai: {
          onToken: vi.fn(() => () => {}),
          onThinking: vi.fn(() => () => {})
        },
        appAgent: { sendMessage }
      }
    })
    useAIStore.getState().setMessages([userMessage('same request')])
    const view = renderHook(() => useAIStream())

    await act(async () => {
      await view.result.current.sendMessage(
        'conversation-1',
        'provider-1',
        'same request',
        undefined,
        { projectId: 'project-1' }
      )
    })

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      userMessage: 'same request',
      messages: [{ role: 'user', content: 'same request' }]
    }))
    expect(useAIStore.getState().messages).toHaveLength(1)
  })

  it('does not let an older request clear the replacement request streaming state', async () => {
    const first = deferred<{ conversationId: string; content: string; actionResults: [] }>()
    const second = deferred<{ conversationId: string; content: string; actionResults: [] }>()
    const sendMessage = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        ai: {
          onToken: vi.fn(() => () => {}),
          onThinking: vi.fn(() => () => {})
        },
        appAgent: { sendMessage }
      }
    })
    const view = renderHook(() => useAIStream())
    let firstRequest!: Promise<unknown>
    let secondRequest!: Promise<unknown>

    act(() => {
      firstRequest = view.result.current.sendMessage(
        'conversation-1', 'provider-1', 'first', undefined, { projectId: 'project-1' }
      )
      secondRequest = view.result.current.sendMessage(
        'conversation-1', 'provider-1', 'second', undefined, { projectId: 'project-1' }
      )
    })
    expect(isConversationStreaming(useAIStore.getState().streamingConversations, 'conversation-1')).toBe(true)

    await act(async () => {
      first.resolve({ conversationId: 'conversation-1', content: 'old', actionResults: [] })
      await firstRequest
    })
    expect(isConversationStreaming(useAIStore.getState().streamingConversations, 'conversation-1')).toBe(true)

    await act(async () => {
      second.resolve({ conversationId: 'conversation-1', content: 'new', actionResults: [] })
      await secondRequest
    })
    expect(isConversationStreaming(useAIStore.getState().streamingConversations, 'conversation-1')).toBe(false)
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import type { ProviderConfig } from '../../src/preload/types'
import { appendProvider, applyProviderUpdate, useAIStore } from '../../src/renderer/stores/ai.store'

function provider(id: string, isDefault: number): ProviderConfig {
  return {
    id,
    name: id,
    provider: 'openai',
    api_key: 'key',
    base_url: null,
    model: `${id}-model`,
    parameters: '{}',
    is_default: isDefault,
    created_at: '2026-01-01 00:00:00'
  }
}

beforeEach(() => {
  useAIStore.setState({ providers: [] })
})

describe('AI provider default state', () => {
  it('clears the previous default in the same store update when another provider becomes default', () => {
    useAIStore.setState({ providers: [provider('old', 1), provider('next', 0)] })

    useAIStore.getState().updateProvider('next', { is_default: 1 })

    const providers = useAIStore.getState().providers
    expect(providers.find(item => item.id === 'old')?.is_default).toBe(0)
    expect(providers.find(item => item.id === 'next')?.is_default).toBe(1)
    expect(providers.filter(item => item.is_default === 1)).toHaveLength(1)
  })

  it('clears the previous default when a newly-created default provider is appended', () => {
    useAIStore.setState({ providers: [provider('old', 1)] })

    useAIStore.getState().addProvider(provider('new', 1))

    expect(useAIStore.getState().providers.map(item => [item.id, item.is_default])).toEqual([
      ['old', 0],
      ['new', 1]
    ])
  })

  it('keeps helper updates immutable so default selection cannot observe an intermediate dual-default list', () => {
    const original = [provider('old', 1), provider('next', 0)]
    const updated = applyProviderUpdate(original, 'next', { is_default: 1 })
    const appended = appendProvider(original, provider('third', 1))

    expect(original.map(item => item.is_default)).toEqual([1, 0])
    expect(updated.map(item => item.is_default)).toEqual([0, 1])
    expect(appended.map(item => item.is_default)).toEqual([0, 0, 1])
  })
})

describe('per-conversation streaming state', () => {
  it('互不干扰地按会话开关', async () => {
    const { useAIStore, isConversationStreaming } = await import('../../src/renderer/stores/ai.store')
    const { setConversationStreaming } = useAIStore.getState()

    setConversationStreaming('conv-a', true)
    setConversationStreaming('conv-b', true)
    setConversationStreaming('conv-b', false)

    const map = useAIStore.getState().streamingConversations
    expect(isConversationStreaming(map, 'conv-a')).toBe(true)
    expect(isConversationStreaming(map, 'conv-b')).toBe(false)
    expect(isConversationStreaming(map, null)).toBe(false)

    setConversationStreaming('conv-a', false)
    expect(useAIStore.getState().streamingConversations).toEqual({})
  })
})

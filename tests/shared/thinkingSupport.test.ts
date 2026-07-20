import { describe, expect, it } from 'vitest'
import { getThinkingCapability } from '../../src/shared/thinkingSupport'

describe('getThinkingCapability', () => {
  it('marks modern Claude models as adjustable', () => {
    expect(getThinkingCapability('anthropic', 'claude-opus-4-8')).toMatchObject({ adjustable: true, kind: 'anthropic' })
    expect(getThinkingCapability('anthropic', 'claude-sonnet-5')).toMatchObject({ adjustable: true, kind: 'anthropic' })
    expect(getThinkingCapability('anthropic', 'claude-3-7-sonnet-20250219')).toMatchObject({ adjustable: true, kind: 'anthropic' })
    expect(getThinkingCapability('anthropic', 'claude-fable-5')).toMatchObject({ adjustable: true, kind: 'anthropic' })
  })

  it('marks legacy Claude models as fixed default', () => {
    expect(getThinkingCapability('anthropic', 'claude-3-5-sonnet-20241022').adjustable).toBe(false)
    expect(getThinkingCapability('anthropic', 'claude-instant-1.2').adjustable).toBe(false)
    expect(getThinkingCapability('anthropic', 'claude-2.1').adjustable).toBe(false)
  })

  it('marks OpenAI reasoning models as adjustable', () => {
    expect(getThinkingCapability('openai', 'o3-mini')).toMatchObject({ adjustable: true, kind: 'openai' })
    expect(getThinkingCapability('openai', 'o1')).toMatchObject({ adjustable: true, kind: 'openai' })
    expect(getThinkingCapability('openai', 'gpt-5')).toMatchObject({ adjustable: true, kind: 'openai' })
    expect(getThinkingCapability('openai', 'gpt-4o').adjustable).toBe(false)
  })

  it('detects compat capability by model name, not provider type', () => {
    // 中转站上的思考型模型：可调节，参数走 openai 风格 reasoning_effort。
    expect(getThinkingCapability('openai-compat', 'deepseek-v4-pro')).toMatchObject({ adjustable: true, kind: 'openai' })
    expect(getThinkingCapability('openai-compat', 'claude-opus-4-8')).toMatchObject({ adjustable: true, kind: 'openai' })
    expect(getThinkingCapability('openai-compat', 'deepseek-reasoner')).toMatchObject({ adjustable: true, kind: 'openai' })
    expect(getThinkingCapability('openai-compat', 'gpt-5-turbo')).toMatchObject({ adjustable: true, kind: 'openai' })
    expect(getThinkingCapability('openai-compat', 'qwq-32b')).toMatchObject({ adjustable: true, kind: 'openai' })
  })

  it('keeps unknown compat models fixed at default', () => {
    const plain = getThinkingCapability('openai-compat', 'llama-3.1-8b-instruct')
    expect(plain.adjustable).toBe(false)
    expect(plain.mayEmitThinking).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { mergeAnthropicSystemMessages } from '../../src/main/services/ai-adapter/anthropic.adapter'

describe('Anthropic adapter system context', () => {
  it('preserves every system message in order', () => {
    expect(mergeAnthropicSystemMessages([
      { role: 'system', content: 'application rules' },
      { role: 'system', content: 'runtime project and chapter context' },
      { role: 'user', content: 'hello' }
    ])).toBe('application rules\n\nruntime project and chapter context')
  })
})

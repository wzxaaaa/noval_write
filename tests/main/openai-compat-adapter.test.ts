import { describe, expect, it } from 'vitest'
import {
  extractOpenAIMessageText,
  extractOpenAIStreamDeltaText
} from '../../src/main/services/ai-adapter/openai.adapter'
import {
  isKimiCompatibleConfig,
  normalizeKimiCompletionParams
} from '../../src/main/services/ai-adapter/openai-compat.adapter'

describe('openai compatible adapter provider quirks', () => {
  it('detects Kimi compatible configs by Moonshot/Kimi base URL or model name', () => {
    expect(isKimiCompatibleConfig('https://api.moonshot.cn/v1', 'moonshot-v1-8k')).toBe(true)
    expect(isKimiCompatibleConfig('https://api.kimi.com/v1', 'kimi-k2.6')).toBe(true)
    expect(isKimiCompatibleConfig(null, 'kimi-k2.5')).toBe(true)
    expect(isKimiCompatibleConfig('http://localhost:11434/v1', 'qwen3')).toBe(false)
  })

  it('clamps Kimi temperature to the documented 0..1 range', () => {
    expect(normalizeKimiCompletionParams({ temperature: 1.8 }, 'moonshot-v1-8k').temperature).toBe(1)
    expect(normalizeKimiCompletionParams({ temperature: -0.2 }, 'moonshot-v1-8k').temperature).toBe(0)
    expect(normalizeKimiCompletionParams({ temperature: 0.72 }, 'moonshot-v1-8k').temperature).toBe(0.72)
  })

  it('omits temperature for Kimi K2 fixed-temperature models', () => {
    expect(normalizeKimiCompletionParams({ temperature: 0.82, topP: 0.92, top_p: 0.92, frequencyPenalty: 0.2, presencePenalty: 0.3, maxTokens: 8192 }, 'kimi-k2.6')).toEqual({
      maxTokens: 8192
    })
    expect(normalizeKimiCompletionParams({ temperature: 1, topP: 0.9 }, 'kimi-k2.5-preview')).toEqual({})
  })

  it('extracts OpenAI-compatible content arrays and stream deltas', () => {
    expect(extractOpenAIMessageText({
      content: [
        { type: 'text', text: '第一段' },
        { type: 'text', text: '第二段' }
      ]
    })).toBe('第一段第二段')

    expect(extractOpenAIStreamDeltaText({
      content: [{ type: 'text', text: '增量' }]
    })).toBe('增量')
  })

  it('preserves OpenAI-compatible tool calls when content is empty', () => {
    const text = extractOpenAIMessageText({
      content: null,
      tool_calls: [
        {
          type: 'function',
          function: {
            name: 'read_outline',
            arguments: '{"type":"detailed"}'
          }
        }
      ]
    })

    expect(JSON.parse(text)).toEqual({
      tool_calls: [
        {
          type: 'function',
          function: {
            name: 'read_outline',
            arguments: '{"type":"detailed"}'
          }
        }
      ]
    })
  })
})

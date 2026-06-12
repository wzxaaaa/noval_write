import { describe, expect, it } from 'vitest'
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
    expect(normalizeKimiCompletionParams({ temperature: 0.82, maxTokens: 8192 }, 'kimi-k2.6')).toEqual({
      maxTokens: 8192
    })
    expect(normalizeKimiCompletionParams({ temperature: 1, topP: 0.9 }, 'kimi-k2.5-preview')).toEqual({
      topP: 0.9
    })
  })
})

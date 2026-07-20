import Anthropic from '@anthropic-ai/sdk'
import { BaseAIAdapter } from './base.adapter'
import type { AIChatMessage, AIStreamCallbacks, AIParams } from './types'
import type { ProviderConfigRow } from '../../db/repositories/provider-config.repo'

export class AnthropicAdapter extends BaseAIAdapter {
  readonly provider = 'anthropic'
  readonly model: string
  private client: Anthropic

  constructor(config: ProviderConfigRow) {
    super(config)
    this.model = config.model
    this.client = new Anthropic({ apiKey: config.api_key })
  }

  async chat(messages: AIChatMessage[], params?: AIParams): Promise<{ content: string; usage: { inputTokens: number; outputTokens: number } }> {
    const merged = this.mergeParams(params)
    const systemPrompt = mergeAnthropicSystemMessages(messages)
    const chatMsgs = messages.filter(m => m.role !== 'system')

    const resp = await this.client.messages.create({
      model: this.model,
      system: systemPrompt || undefined,
      messages: chatMsgs.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content
      })),
      stop_sequences: merged.stopSequences,
      ...buildAnthropicSamplingParams(merged)
    } as any, { signal: merged.signal } as any)

    const text = resp.content.map(c => (c.type === 'text' ? c.text : '')).join('')
    return {
      content: text,
      usage: {
        inputTokens: resp.usage.input_tokens,
        outputTokens: resp.usage.output_tokens
      }
    }
  }

  async chatStream(messages: AIChatMessage[], callbacks: AIStreamCallbacks, params?: AIParams): Promise<void> {
    try {
      const merged = this.mergeParams(params)
      const systemPrompt = mergeAnthropicSystemMessages(messages)
      const chatMsgs = messages.filter(m => m.role !== 'system')

      const stream = this.client.messages.stream({
        model: this.model,
        system: systemPrompt || undefined,
        messages: chatMsgs.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content
        })),
        ...buildAnthropicSamplingParams(merged)
      } as any, { signal: merged.signal } as any)

      let fullText = ''

      stream.on('text', (text) => {
        fullText += text
        callbacks.onToken(text)
      })

      // 扩展思考的增量走原始流事件（SDK 类型未覆盖 thinking_delta，故用宽松读取）。
      stream.on('streamEvent', (event: unknown) => {
        const record = event as { type?: string; delta?: { type?: string; thinking?: unknown } } | null
        if (record?.type === 'content_block_delta' && record.delta?.type === 'thinking_delta' && typeof record.delta.thinking === 'string') {
          callbacks.onThinking(record.delta.thinking)
        }
      })

      const final = await stream.finalMessage()
      callbacks.onComplete(fullText, {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens
      })
    } catch (err) {
      callbacks.onError(err instanceof Error ? err : new Error(String(err)))
    }
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.client.messages.create({
        model: this.model,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }]
      })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
}

/**
 * 由 thinkingEffort 生成 Anthropic 扩展思考与采样参数。
 * 启用思考时：temperature/top_p/top_k 必须省略，max_tokens 必须大于思考预算。
 */
const ANTHROPIC_THINKING_BUDGETS: Record<string, number> = {
  low: 4096,
  medium: 8192,
  high: 16384,
  max: 24576
}

export function buildAnthropicSamplingParams(params: {
  thinkingEffort?: 'default' | 'low' | 'medium' | 'high' | 'max'
  temperature?: number
  topP?: number
  topK?: number
  maxTokens?: number
}): Record<string, unknown> {
  const budget = params.thinkingEffort && params.thinkingEffort !== 'default'
    ? ANTHROPIC_THINKING_BUDGETS[params.thinkingEffort] ?? null
    : null
  if (budget === null) {
    return {
      temperature: params.temperature,
      top_p: params.topP,
      top_k: params.topK,
      max_tokens: params.maxTokens ?? 4096
    }
  }
  return {
    thinking: { type: 'enabled', budget_tokens: budget },
    max_tokens: Math.max(params.maxTokens ?? 4096, budget + 4096)
  }
}

export function mergeAnthropicSystemMessages(messages: AIChatMessage[]): string {
  return messages
    .filter(message => message.role === 'system' && message.content.trim())
    .map(message => message.content.trim())
    .join('\n\n')
}

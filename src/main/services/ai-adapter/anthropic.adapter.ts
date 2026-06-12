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
    const systemMsg = messages.find(m => m.role === 'system')
    const chatMsgs = messages.filter(m => m.role !== 'system')

    const resp = await this.client.messages.create({
      model: this.model,
      system: systemMsg?.content,
      messages: chatMsgs.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content
      })),
      temperature: merged.temperature,
      top_p: merged.topP,
      max_tokens: merged.maxTokens ?? 4096,
      top_k: merged.topK,
      stop_sequences: merged.stopSequences
    })

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
      const systemMsg = messages.find(m => m.role === 'system')
      const chatMsgs = messages.filter(m => m.role !== 'system')

      const stream = this.client.messages.stream({
        model: this.model,
        system: systemMsg?.content,
        messages: chatMsgs.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content
        })),
        temperature: merged.temperature,
        top_p: merged.topP,
        max_tokens: merged.maxTokens ?? 4096,
        top_k: merged.topK
      })

      let fullText = ''

      stream.on('text', (text) => {
        fullText += text
        callbacks.onToken(text)
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

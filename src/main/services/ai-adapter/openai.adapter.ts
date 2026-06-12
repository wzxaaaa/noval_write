import OpenAI, { type ClientOptions } from 'openai'
import { BaseAIAdapter } from './base.adapter'
import type { AIChatMessage, AIStreamCallbacks, AIParams } from './types'
import type { ProviderConfigRow } from '../../db/repositories/provider-config.repo'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class OpenAIAdapter extends BaseAIAdapter {
  readonly provider: string
  readonly model: string
  protected client: OpenAI

  constructor(config: ProviderConfigRow, options: ClientOptions & { provider?: string } = {}) {
    super(config)
    const { provider = 'openai', ...clientOptions } = options
    this.provider = provider
    this.model = config.model
    this.client = new OpenAI({ apiKey: config.api_key, ...clientOptions })
  }

  async chat(messages: AIChatMessage[], params?: AIParams): Promise<{ content: string; usage: { inputTokens: number; outputTokens: number } }> {
    const merged = this.normalizeCompletionParams(this.mergeParams(params))
    const resp = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      temperature: merged.temperature,
      top_p: merged.topP,
      max_tokens: merged.maxTokens,
      frequency_penalty: merged.frequencyPenalty,
      presence_penalty: merged.presencePenalty,
      stop: merged.stopSequences,
      ...this.buildCompatBody(merged)
    } as any)

    return {
      content: resp.choices[0]?.message?.content ?? '',
      usage: {
        inputTokens: resp.usage?.prompt_tokens ?? 0,
        outputTokens: resp.usage?.completion_tokens ?? 0
      }
    }
  }

  async chatStream(messages: AIChatMessage[], callbacks: AIStreamCallbacks, params?: AIParams): Promise<void> {
    try {
      const merged = this.normalizeCompletionParams(this.mergeParams(params))
      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        temperature: merged.temperature,
        top_p: merged.topP,
        max_tokens: merged.maxTokens,
        frequency_penalty: merged.frequencyPenalty,
        presence_penalty: merged.presencePenalty,
        stop: merged.stopSequences,
        stream: true,
        ...this.buildCompatBody(merged)
      } as any)

      let fullText = ''
      for await (const chunk of stream as any) {
        const delta = chunk.choices[0]?.delta?.content
        if (delta) {
          fullText += delta
          callbacks.onToken(delta)
        }
      }
      callbacks.onComplete(fullText, {
        inputTokens: 0,
        outputTokens: 0
      })
    } catch (err) {
      callbacks.onError(err instanceof Error ? err : new Error(String(err)))
    }
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.client.chat.completions.create({
        model: this.model,
        max_tokens: 5,
        messages: [{ role: 'user', content: 'ping' }]
      })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  private buildCompatBody(params: AIParams): Record<string, unknown> {
    if (this.provider !== 'openai-compat') {
      return {}
    }

    const body: Record<string, unknown> = isRecord(params.extraBody) ? { ...params.extraBody } : {}
    const contextTokens = this.getContextTokens(params)

    if (contextTokens) {
      const options = isRecord(body.options) ? { ...body.options } : {}
      options.num_ctx ??= contextTokens
      body.options = options
      body.context_length ??= contextTokens
      body.num_ctx ??= contextTokens
    }

    return body
  }

  protected normalizeCompletionParams(params: AIParams): AIParams {
    return params
  }
}

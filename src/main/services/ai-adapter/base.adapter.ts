import type { AIAdapter, AIChatMessage, AIStreamCallbacks, AIParams } from './types'
import type { ProviderConfigRow } from '../../db/repositories/provider-config.repo'

export abstract class BaseAIAdapter implements AIAdapter {
  abstract readonly provider: string
  abstract readonly model: string

  constructor(protected config: ProviderConfigRow) {}

  abstract chat(messages: AIChatMessage[], params?: AIParams): Promise<{ content: string; usage: { inputTokens: number; outputTokens: number } }>
  abstract chatStream(messages: AIChatMessage[], callbacks: AIStreamCallbacks, params?: AIParams): Promise<void>
  abstract testConnection(): Promise<{ ok: boolean; error?: string }>

  protected mergeParams(override?: AIParams): AIParams {
    const defaults: AIParams = JSON.parse(this.config.parameters || '{}')
    return this.normalizeParams({ ...defaults, ...override })
  }

  protected getContextTokens(params: AIParams): number | undefined {
    const explicitTokens = params.contextTokens ?? params.numCtx
    if (typeof explicitTokens === 'number' && explicitTokens > 0) {
      return Math.floor(explicitTokens)
    }

    if (typeof params.contextBytes === 'number' && params.contextBytes > 0) {
      return Math.floor(params.contextBytes / 4)
    }

    return undefined
  }

  private normalizeParams(params: AIParams): AIParams {
    const normalized: AIParams = { ...params }

    normalized.topP ??= params.top_p
    normalized.maxTokens ??= params.max_tokens
    normalized.topK ??= params.top_k
    normalized.frequencyPenalty ??= params.frequency_penalty
    normalized.presencePenalty ??= params.presence_penalty
    normalized.contextBytes ??= params.context_bytes
    normalized.contextTokens ??= params.context_tokens
    normalized.numCtx ??= params.num_ctx
    normalized.extraBody ??= params.extra_body

    if (!normalized.stopSequences) {
      if (Array.isArray(params.stop_sequences)) {
        normalized.stopSequences = params.stop_sequences
      } else if (Array.isArray(params.stop)) {
        normalized.stopSequences = params.stop
      } else if (typeof params.stop === 'string') {
        normalized.stopSequences = [params.stop]
      }
    }

    return normalized
  }
}

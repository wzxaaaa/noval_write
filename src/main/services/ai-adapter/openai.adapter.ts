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
      ...this.buildReasoningParams(merged),
      ...this.buildCompatBody(merged)
    } as any, { signal: merged.signal } as any)

    const message = resp.choices[0]?.message as unknown
    return {
      content: extractOpenAIMessageText(message),
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
        ...this.buildReasoningParams(merged),
        ...this.buildCompatBody(merged)
      } as any, { signal: merged.signal } as any)

      let fullText = ''
      for await (const chunk of stream as any) {
        const thinkingDelta = extractOpenAIStreamDeltaThinking(chunk.choices[0]?.delta)
        if (thinkingDelta) callbacks.onThinking(thinkingDelta)
        const delta = extractOpenAIStreamDeltaText(chunk.choices[0]?.delta)
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

  /**
   * 思考努力参数：OpenAI 官方与 openai-compat 通道（中转站/one-api/new-api 系）
   * 均使用 reasoning_effort，中转站会为 claude 等模型自动换算成 thinking budget。
   * 仅在用户显式选择高/最大时发送，默认档不发送任何参数。
   */
  private buildReasoningParams(params: AIParams): Record<string, unknown> {
    const effort = params.thinkingEffort
    if (effort === 'low' || effort === 'medium' || effort === 'high') {
      return { reasoning_effort: effort }
    }
    if (effort === 'max') return { reasoning_effort: 'high' }
    return {}
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

export function extractOpenAIMessageText(message: unknown): string {
  if (!isRecord(message)) return ''

  const content = extractContentText(message.content)
  if (content) return content

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return JSON.stringify({ tool_calls: message.tool_calls })
  }

  if (isRecord(message.function_call)) {
    return JSON.stringify({ function_call: message.function_call })
  }

  return ''
}

export function extractOpenAIStreamDeltaText(delta: unknown): string {
  if (!isRecord(delta)) return ''
  return extractContentText(delta.content)
}

/** DeepSeek-R1/QwQ 等模型在流式 delta 中通过 reasoning_content/reasoning 输出思考。 */
export function extractOpenAIStreamDeltaThinking(delta: unknown): string {
  if (!isRecord(delta)) return ''
  const value = delta.reasoning_content ?? delta.reasoning
  return typeof value === 'string' ? value : ''
}

function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part
      if (!isRecord(part)) return ''
      return readString(part, ['text', 'content', 'input_text', 'output_text']) || ''
    }).join('')
  }
  if (isRecord(content)) {
    return readString(content, ['text', 'content', 'input_text', 'output_text']) || ''
  }
  return ''
}

function readString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return ''
}

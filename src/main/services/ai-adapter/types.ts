export interface AIParams {
  temperature?: number
  topP?: number
  top_p?: number
  maxTokens?: number
  max_tokens?: number
  topK?: number
  top_k?: number
  frequencyPenalty?: number
  frequency_penalty?: number
  presencePenalty?: number
  presence_penalty?: number
  stopSequences?: string[]
  stop_sequences?: string[]
  stop?: string[] | string
  contextBytes?: number
  context_bytes?: number
  contextTokens?: number
  context_tokens?: number
  numCtx?: number
  num_ctx?: number
  firstTokenTimeoutMs?: number
  first_token_timeout_ms?: number
  streamIdleTimeoutMs?: number
  stream_idle_timeout_ms?: number
  streamTotalTimeoutMs?: number
  stream_total_timeout_ms?: number
  extraBody?: Record<string, unknown>
  extra_body?: Record<string, unknown>
  thinkingEffort?: 'default' | 'low' | 'medium' | 'high' | 'max'
  thinking_effort?: 'default' | 'low' | 'medium' | 'high' | 'max'
  signal?: AbortSignal
}

export interface AIChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AIStreamCallbacks {
  onToken: (token: string) => void
  onThinking: (thinking: string) => void
  onComplete: (fullText: string, usage: Usage) => void
  onError: (error: Error) => void
}

export interface Usage {
  inputTokens: number
  outputTokens: number
}

export interface AIAdapter {
  readonly provider: string
  readonly model: string
  chat(messages: AIChatMessage[], params?: AIParams): Promise<{ content: string; usage: Usage }>
  chatStream(messages: AIChatMessage[], callbacks: AIStreamCallbacks, params?: AIParams): Promise<void>
  testConnection(): Promise<{ ok: boolean; error?: string }>
}

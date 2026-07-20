export type ThinkingEffort = 'default' | 'low' | 'medium' | 'high' | 'max'

export const THINKING_EFFORT_LABELS: Record<ThinkingEffort, string> = {
  default: '默认',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max'
}

/** 按能力返回可选档位；openai 风格没有比 high 更高的档，不提供 Max。 */
export function getEffortOptions(kind: ThinkingCapability['kind']): ThinkingEffort[] {
  if (kind === 'anthropic') return ['default', 'low', 'medium', 'high', 'max']
  if (kind === 'openai') return ['default', 'low', 'medium', 'high']
  return ['default']
}

export interface ThinkingCapability {
  /** 是否允许用户调节思考努力程度；false 时 UI 固定为「默认」。 */
  adjustable: boolean
  /** 参数映射方式：anthropic = thinking budget；openai = reasoning_effort。 */
  kind: 'anthropic' | 'openai' | null
  /** 模型是否可能输出思考内容（即使不可调，如 deepseek-reasoner）。 */
  mayEmitThinking: boolean
}

/**
 * 按 provider + 模型名判断思考(推理)能力。API 无法直接查询能力，
 * 因此使用已知模型系列的启发式匹配；未知模型一律视为不支持调节。
 */
export function getThinkingCapability(provider: string, model: string): ThinkingCapability {
  const normalizedModel = (model || '').trim().toLowerCase()

  if (provider === 'anthropic') {
    const isClaude = /claude/.test(normalizedModel)
    // 扩展思考自 claude-3-7 起支持；3.5/3.0/2.x 及 instant 不支持。
    const unsupported = /claude-?(instant|2|3[.-]?[05]?($|-(haiku|sonnet|opus)))/.test(normalizedModel)
    const supported = isClaude && !unsupported && /(3[.-]7|[-.](4|5)|opus|sonnet|haiku|fable)/.test(normalizedModel)
    return { adjustable: supported, kind: supported ? 'anthropic' : null, mayEmitThinking: supported }
  }

  if (provider === 'openai') {
    // o 系列与 gpt-5 系列支持 reasoning_effort。
    const supported = /^o\d/.test(normalizedModel) || /gpt-5/.test(normalizedModel)
    return { adjustable: supported, kind: supported ? 'openai' : null, mayEmitThinking: supported }
  }

  // openai-compat（中转站/Ollama/vLLM 等）：provider 类型不代表模型能力，按模型名判断。
  // 中转站（one-api/new-api 系）普遍接受 reasoning_effort，并会为 claude 等模型自动换算，
  // 因此已知的思考型模型系列（claude 3.7/4/5、gpt-5/o 系、deepseek v3+/R 系、QwQ/Qwen3、
  // GLM 4.5+、Kimi、Grok 等）视为可调节，参数走 openai 风格。
  const compatAdjustable = /(claude.*(3[.-]7|[-.][45])|claude-?(opus|sonnet|haiku|fable)|gpt-5|^o\d|deepseek-?v[3-9]|deepseek-?r|reasoner|qwq|qwen-?3|glm-?4[.-]?[5-9]|kimi|minimax|grok)/.test(normalizedModel)
  if (compatAdjustable) {
    return { adjustable: true, kind: 'openai', mayEmitThinking: true }
  }
  const emitsThinking = /([-_.]r1($|[-_])|thinking)/.test(normalizedModel)
  return { adjustable: false, kind: null, mayEmitThinking: emitsThinking }
}

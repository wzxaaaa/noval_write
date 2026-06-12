import type { AIChatMessage } from '../ai-adapter/types'
import { estimateTokenCount } from '../../../shared/textMetrics'

export const DEFAULT_CONTEXT_TOKEN_LIMIT = 900_000

export interface ContextStats {
  totalTokens: number
  limit: number
  ratio: number
  lastTokens: number
  compressed: boolean
}

export class AgentContextManager {
  private totalTokens = 0
  private compressedSummaries: string[] = []

  constructor(private limit = DEFAULT_CONTEXT_TOKEN_LIMIT) {}

  record(text: string): ContextStats {
    const lastTokens = estimateTokenCount(text)
    this.totalTokens += lastTokens
    return this.stats(lastTokens, false)
  }

  shouldCompress(): boolean {
    return this.totalTokens >= this.limit
  }

  compress(messages: AIChatMessage[]): { messages: AIChatMessage[]; stats: ContextStats } {
    if (!this.shouldCompress() || messages.length <= 6) {
      return { messages, stats: this.stats(0, false) }
    }

    const recent = messages.slice(-6)
    const older = messages.slice(0, -6)
    const summary = this.buildSummary(older)
    this.compressedSummaries.push(summary)

    const compressedMessages: AIChatMessage[] = [
      {
        role: 'user',
        content: `[CONTEXT_COMPRESSED]\n以下是自动压缩后的历史上下文摘要，请继续保持人物、设定、伏笔和章节衔接一致：\n${this.compressedSummaries.slice(-3).join('\n\n')}`
      },
      ...recent
    ]

    this.totalTokens = compressedMessages.reduce((sum, message) => sum + estimateTokenCount(message.content), 0)
    return { messages: compressedMessages, stats: this.stats(0, true) }
  }

  getStats(): ContextStats {
    return this.stats(0, false)
  }

  private buildSummary(messages: AIChatMessage[]): string {
    const text = messages
      .map(message => `${message.role}: ${message.content}`)
      .join('\n\n')
      .replace(/\[\s*TOOL\s*:[\s\S]*?\[\s*\/\s*TOOL\s*\]/gi, '[工具调用已压缩]')
      .slice(-12000)

    return `压缩时间: ${new Date().toISOString()}\n保留要点:\n${text}`
  }

  private stats(lastTokens: number, compressed: boolean): ContextStats {
    return {
      totalTokens: this.totalTokens,
      limit: this.limit,
      ratio: this.totalTokens / this.limit,
      lastTokens,
      compressed
    }
  }
}

import type { AIChatMessage } from '../ai-adapter/types'

export interface BusMessage {
  fromAgentId: string
  toAgentId: string | null // null = broadcast
  role: 'assistant' | 'system'
  content: string
  timestamp: string
}

export class MessageBus {
  private messages: BusMessage[] = []
  private queues: Map<string, AIChatMessage[]> = new Map()

  broadcast(message: AIChatMessage): void {
    for (const [agentId] of this.queues) {
      this.queues.get(agentId)!.push({ ...message })
    }
  }

  sendFrom(agentId: string, message: AIChatMessage): void {
    // Parse [TO:agent-id] directives
    const directives = this.parseDirectives(message.content)
    this.messages.push({
      fromAgentId: agentId,
      toAgentId: null,
      role: 'assistant',
      content: message.content,
      timestamp: new Date().toISOString()
    })

    if (directives.length === 0) {
      // If no directives, broadcast to all other agents
      for (const [otherId] of this.queues) {
        if (otherId !== agentId) {
          this.queues.get(otherId)!.push({ ...message })
        }
      }
    } else {
      // Route to specified agents
      for (const { toAgentId, content } of directives) {
        const queue = this.queues.get(toAgentId)
        if (queue) {
          queue.push({ role: 'assistant', content })
        }
      }
    }
  }

  private parseDirectives(content: string): { toAgentId: string; content: string }[] {
    const pattern = /\[TO:(.*?)\]\s*([\s\S]*?)(?=\[TO:|$)/g
    const directives: { toAgentId: string; content: string }[] = []
    let match
    while ((match = pattern.exec(content)) !== null) {
      directives.push({ toAgentId: match[1].trim(), content: match[2].trim() })
    }
    return directives
  }

  getMessagesFor(agentId: string): AIChatMessage[] {
    if (!this.queues.has(agentId)) {
      this.queues.set(agentId, [])
    }
    return [...this.queues.get(agentId)!]
  }

  clearQueue(agentId: string): void {
    this.queues.set(agentId, [])
  }

  getAllMessages(): BusMessage[] {
    return [...this.messages]
  }

  reset(): void {
    this.messages = []
    this.queues.clear()
  }
}

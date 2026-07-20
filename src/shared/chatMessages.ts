/**
 * 对话消息清洗。
 *
 * 各家 API 对消息序列有硬性要求，违反就直接 400：
 * - 任何消息的 content 不能为空（Anthropic：`message at position N must not be empty`）
 * - user / assistant 必须交替出现，不能连续同角色
 * - 首条非 system 消息必须是 user
 *
 * 历史记录一旦混进一条空 assistant 消息，之后每次请求都会带上它、每次都失败，
 * 对话就永久卡死。所以发请求前统一过一遍这里，既修复历史脏数据，也兜住新写入。
 */

export interface ChatMessageLike {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export function sanitizeChatMessages<T extends ChatMessageLike>(messages: T[]): T[] {
  if (!Array.isArray(messages)) return []

  // 1. 丢掉内容为空的消息（空 assistant 是 400 的头号来源）
  const nonEmpty = messages.filter(
    message => message && typeof message.content === 'string' && message.content.trim() !== ''
  )

  // system 消息不参与交替校验，原样保留在前面
  const systems = nonEmpty.filter(message => message.role === 'system')
  const dialogue = nonEmpty.filter(message => message.role !== 'system')

  // 2. 首条对话消息必须是 user——丢掉开头多余的 assistant
  let start = 0
  while (start < dialogue.length && dialogue[start].role !== 'user') start++
  const trimmed = dialogue.slice(start)

  // 3. 合并连续同角色消息，保证 user / assistant 严格交替
  const merged: T[] = []
  for (const message of trimmed) {
    const last = merged[merged.length - 1]
    if (last && last.role === message.role) {
      merged[merged.length - 1] = {
        ...last,
        content: `${last.content}\n\n${message.content}`
      }
      continue
    }
    merged.push(message)
  }

  return [...systems, ...merged]
}

/**
 * 落库前把助手输出规整成非空文本。
 * 返回 null 表示这次没有产出、不应该写进历史。
 */
export function normalizeAssistantContent(content: string | null | undefined): string | null {
  if (typeof content !== 'string') return null
  const trimmed = content.trim()
  return trimmed === '' ? null : content
}

/** 与 textMetrics.estimateTokenCount 同口径的粗略估算：中日韩字符按 1 token，其余约 4 字符 1 token。 */
function roughTokenCount(text: string): number {
  const cjk = text.match(/[㐀-鿿぀-ヿ가-힯]/g)?.length ?? 0
  return cjk + Math.ceil((text.length - cjk) / 4)
}

/**
 * 按 token 预算裁剪对话历史：system 消息全保留，其余从最新往回收，
 * 超出预算的旧消息整条丢弃。最后一条消息（通常是本次用户指令）永远保留。
 *
 * 小漫的对话历史由渲染层整段传入且此前从不裁剪，长对话最终会撑爆
 * 上下文窗口，每次请求都 400/超限，对话永久卡死。
 */
export function trimChatHistoryByBudget<T extends ChatMessageLike>(
  messages: T[],
  maxTokens = 60_000
): T[] {
  if (!Array.isArray(messages) || messages.length === 0) return []

  const systems = messages.filter(message => message.role === 'system')
  const dialogue = messages.filter(message => message.role !== 'system')
  if (dialogue.length === 0) return [...systems]

  let budget = maxTokens - systems.reduce((sum, message) => sum + roughTokenCount(message.content), 0)
  const kept: T[] = []
  for (let index = dialogue.length - 1; index >= 0; index--) {
    const cost = roughTokenCount(dialogue[index].content)
    if (kept.length > 0 && cost > budget) break
    kept.unshift(dialogue[index])
    budget -= cost
  }

  return [...systems, ...kept]
}

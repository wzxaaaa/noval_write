import type { AgentConfigRow } from '../../db/repositories/agent-config.repo'
import type { AIChatMessage } from '../ai-adapter/types'
import { createAdapterById } from '../ai-adapter/adapter-factory'
import type { ToolRegistry } from './tool-registry'
import { assessAgentOutput, inspectTextDegeneration, type QualityAssessment } from './quality-monitor'
import { estimateTokenCount } from '../../../shared/textMetrics'
import type { AppUIEffect } from '../../../shared/appActions'

const MAX_CONTEXT_TOKENS = 900000
const MAX_SINGLE_MESSAGE_CHARS = 150000
const MAX_TOOL_ROUNDS = 5
const FIRST_TOKEN_TIMEOUT_MS = 90_000
const STREAM_IDLE_TIMEOUT_MS = 120_000
const STREAM_TOTAL_TIMEOUT_MS = 12 * 60_000

export interface AgentRunResult {
  agentId: string
  content: string
  toolCalls: ToolCall[]
  quality: QualityAssessment
}

export interface ToolCall {
  tool: string
  input: string
  output: string
  ok?: boolean
  data?: unknown
  uiEffects?: AppUIEffect[]
}

export class AgentRuntime {
  constructor(private toolRegistry: ToolRegistry) {}

  async execute(
    agent: AgentConfigRow,
    messages: AIChatMessage[],
    onToken?: (token: string) => void,
    onThinking?: (thinking: string) => void
  ): Promise<AgentRunResult> {
    const tools = parseTools(agent.tools, agent.name)
    const params = parseParams(agent.parameters, agent.name)
    const watchdogTimeouts = getWatchdogTimeouts(params)

    const systemMessage: AIChatMessage = {
      role: 'system',
      content: this.buildSystemPrompt(agent, tools)
    }

    let allMessages = [systemMessage, ...messages]
    allMessages = this.trimMessages(allMessages)

    const adapter = createAdapterById(agent.model)
    const toolCalls: ToolCall[] = []
    const assistantContents: string[] = []

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let roundContent = ''
      let streamActive = true
      await streamWithWatchdog(
        () => adapter.chatStream(allMessages, {
          onToken: (token) => {
            if (!streamActive) return
            roundContent += token
            onToken?.(token)
          },
          onThinking: (thinking) => {
            if (!streamActive) return
            onThinking?.(thinking)
          },
          onComplete: () => {},
          onError: (err) => { throw err }
        }, params),
        {
          getOutputLength: () => roundContent.length,
          getOutputText: () => roundContent,
          onStaleOutput: () => {
            onThinking?.('[运行保护] 当前 Agent 长时间没有继续输出，已中断本次调用。')
          },
          getAbortReason: () => {
            const degeneration = inspectTextDegeneration(roundContent)
            return degeneration.ok ? null : `Agent 输出重复退化：${degeneration.reason}`
          },
          ...watchdogTimeouts
        }
      ).finally(() => {
        streamActive = false
      })

      assistantContents.push(roundContent)
      const roundToolCalls = parseAgentToolCalls(roundContent)
      if (roundToolCalls.length === 0) break

      const executedThisRound: ToolCall[] = []
      for (const call of roundToolCalls) {
        onThinking?.(`[工具调用] 正在执行 ${call.tool}`)
        const result = await this.toolRegistry.execute(call.tool, call.input)
        const executed = {
          tool: call.tool,
          input: call.input,
          output: result.message,
          ok: result.ok,
          data: result.data,
          uiEffects: result.uiEffects
        }
        toolCalls.push(executed)
        executedThisRound.push(executed)
        onThinking?.(`[工具结果] ${call.tool} ${result.ok ? '完成' : '失败'}：${truncateText(result.message, 240)}`)
        if (shouldAbortAgentRun(result.data)) {
          throw new Error(result.message)
        }
      }

      allMessages = this.trimMessages([
        ...allMessages,
        { role: 'assistant', content: roundContent },
        {
          role: 'user',
          content: `工具执行结果如下。请基于真实结果继续，不要假设失败的工具已经完成；如果任务完成，请输出最终给用户看的结果。\n${formatToolResults(executedThisRound)}`
        }
      ])
    }

    const fullContent = cleanToolSyntax(assistantContents.join('\n\n')).trim()

    return {
      agentId: agent.id,
      content: fullContent,
      toolCalls,
      quality: assessAgentOutput(fullContent, toolCalls)
    }
  }

  private trimMessages(messages: AIChatMessage[]): AIChatMessage[] {
    const systemMsgs = messages.filter(m => m.role === 'system')
    const bodyMsgs = messages.filter(m => m.role !== 'system')

    let totalTokens = messages.reduce((sum, m) => sum + estimateTokenCount(m.content), 0)

    if (totalTokens <= MAX_CONTEXT_TOKENS) {
      return messages
    }

    const trimmed: AIChatMessage[] = []

    for (let i = bodyMsgs.length - 1; i >= 0; i--) {
      const tokenCount = estimateTokenCount(bodyMsgs[i].content)
      if (bodyMsgs[i].content.length > MAX_SINGLE_MESSAGE_CHARS) {
        const head = bodyMsgs[i].content.slice(0, MAX_SINGLE_MESSAGE_CHARS)
        const tail = bodyMsgs[i].content.slice(-3000)
        trimmed.unshift({
          role: bodyMsgs[i].role,
          content: head + `\n\n⚠ [消息过长已截断，原始长度${bodyMsgs[i].content.length}字符]\n\n` + tail
        })
        totalTokens -= tokenCount - estimateTokenCount(trimmed[0].content)
      } else {
        trimmed.unshift(bodyMsgs[i])
      }

      if (totalTokens <= MAX_CONTEXT_TOKENS) break
    }

    if (totalTokens > MAX_CONTEXT_TOKENS) {
      const excess = totalTokens - MAX_CONTEXT_TOKENS
      while (trimmed.length > 1 && totalTokens > MAX_CONTEXT_TOKENS) {
        const removed = trimmed.shift()!
        totalTokens -= estimateTokenCount(removed.content)
      }
    }

    return [...systemMsgs, ...trimmed]
  }

  private buildSystemPrompt(agent: AgentConfigRow, tools: string[]): string {
    let prompt = agent.system_prompt

    if (tools.length > 0) {
      prompt += '\n\n你可以使用以下工具：\n'
      for (const tool of tools) {
        prompt += `- ${tool}: ${this.toolRegistry.getDescription(tool)}\n`
      }
      prompt += '\n使用工具时，请使用格式: [TOOL:工具名] 输入内容 [/TOOL]。工具名必须来自上方列表；即使你输出成 [TOOL: 工具名]，系统也会识别，但推荐不要在冒号后加空格。'
    }

    prompt += '\n\n' + this.buildKnowledgeRules()
    prompt += '\n\n' + this.buildNovelProseRules()

    return prompt
  }

  private buildKnowledgeRules(): string {
    return `【知识库使用铁律 — 所有 Agent 必须遵守】
1. 知识库检索返回的只是原文片段，不代表完整信息
2. 人物关系分为两级：
   事实：原文明确写的（如「X是Y的父亲」）— 必须标注「事实」
   推断：多个片段呈现的模式（如多处暧昧 → 「疑似情侣」）— 必须标注「推断」+ 证据
3. 你擅长文学分析，从模式中推断关系是正确的，但必须提供原文证据
4. 共现 + 关键词线索（脸红/牵手/对视等）= 可以推断关系类型
5. 禁止凭空编造：没有原文依据的人物名、事件、设定绝对不能出现
6. 推断无证据 = 禁止；推断有多个片段支撑 = 允许
7. 分析角色优先使用 analyze_entity 做深度检索`
  }

  private buildNovelProseRules(): string {
    return `【输出交付标准 — 所有 Agent 必须遵守】
1. 交付章节正文时，必须使用自然、完整的中文全角标点，尤其是「，。！？；：、」。
2. 不要为了制造紧张感而长时间省略逗号、句号或分号。连续叙述超过约 30-35 个汉字时，应根据语义加入停顿。
3. 动作、感官、心理、环境切换处要有清晰标点；不要写成未经润色的长串句。
4. create_chapter/write_chapter 的 content 必须是可直接入库的最终小说正文，不要包含工作总结、审核说明、标题包装或标点缺失的草稿。
5. 所有面向主编或用户的分析、方案、汇报也必须有正常标点；不要输出长串无标点文字。
6. 工作 Agent 接到任务后要一次性交付可推进结果，不要以“等待下一步任务”“请主编裁定”“是否入库请确认”收尾。
7. 如果被要求写章节，输出「## 正文」并给出完整可用正文；如果被要求做方案，输出可执行方案和明确结论。
8. 主编整合子 Agent 结果时，要先修正标点、病句和节奏，再调用写入工具。发现子 Agent 正文缺标点时，不得直接入库。`
  }
}

export function shouldAbortAgentRun(data: unknown): boolean {
  return !!(
    data &&
    typeof data === 'object' &&
    'abortAgentRun' in data &&
    (data as { abortAgentRun?: unknown }).abortAgentRun === true
  )
}

function parseTools(raw: string, agentName: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((tool): tool is string => typeof tool === 'string') : []
  } catch {
    throw new Error(`Agent「${agentName}」的工具配置不是合法 JSON`)
  }
}

function parseParams(raw: string, agentName: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    throw new Error(`Agent「${agentName}」的参数配置不是合法 JSON`)
  }
}

function getWatchdogTimeouts(params: Record<string, unknown>): {
  firstTokenTimeoutMs?: number
  idleTimeoutMs?: number
  totalTimeoutMs?: number
} {
  return {
    firstTokenTimeoutMs: readPositiveNumber(params.firstTokenTimeoutMs ?? params.first_token_timeout_ms),
    idleTimeoutMs: readPositiveNumber(params.streamIdleTimeoutMs ?? params.stream_idle_timeout_ms),
    totalTimeoutMs: readPositiveNumber(params.streamTotalTimeoutMs ?? params.stream_total_timeout_ms)
  }
}

function readPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

function formatToolResults(toolCalls: ToolCall[]): string {
  return JSON.stringify(toolCalls.map(call => ({
    tool: call.tool,
    ok: call.ok,
    input: call.input,
    output: call.output,
    data: call.data
  })))
}

function truncateText(text: string, maxLength: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength)}...`
}

export function parseAgentToolCalls(content: string): Array<{ tool: string; input: string }> {
  const calls: Array<{ tool: string; input: string }> = []
  let match: RegExpExecArray | null
  while ((match = AGENT_TOOL_CALL_PATTERN.exec(content)) !== null) {
    calls.push({ tool: match[1].trim().toLowerCase(), input: match[2].trim() })
  }
  return calls
}

export function cleanToolSyntax(content: string): string {
  return content.replace(AGENT_TOOL_CALL_PATTERN, '').replace(/\n{3,}/g, '\n\n')
}

const AGENT_TOOL_CALL_PATTERN = /\[\s*TOOL\s*:\s*([\w-]+)\s*\]\s*([\s\S]*?)\[\s*\/\s*TOOL\s*\]/gi

interface StreamWatchdogOptions {
  getOutputLength: () => number
  getOutputText?: () => string
  getAbortReason?: () => string | null
  onStaleOutput?: () => void
  firstTokenTimeoutMs?: number
  idleTimeoutMs?: number
  totalTimeoutMs?: number
}

export async function streamWithWatchdog(
  startStream: () => Promise<void>,
  options: StreamWatchdogOptions
): Promise<void> {
  const firstTokenTimeoutMs = options.firstTokenTimeoutMs ?? FIRST_TOKEN_TIMEOUT_MS
  const idleTimeoutMs = options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS
  const totalTimeoutMs = options.totalTimeoutMs ?? STREAM_TOTAL_TIMEOUT_MS
  const startedAt = Date.now()
  let lastLength = options.getOutputLength()
  let lastProgressAt = startedAt
  let staleNotified = false
  let settled = false
  let watchdog: ReturnType<typeof setInterval> | null = null

  const streamPromise = startStream().finally(() => {
    settled = true
    if (watchdog) clearInterval(watchdog)
  })

  const timeoutPromise = new Promise<never>((_, reject) => {
    watchdog = setInterval(() => {
      if (settled) return
      const now = Date.now()
      const currentLength = options.getOutputLength()
      const abortReason = options.getAbortReason?.()
      if (abortReason) {
        reject(new Error(abortReason))
        return
      }
      if (currentLength > lastLength) {
        lastLength = currentLength
        lastProgressAt = now
        staleNotified = false
        return
      }

      const hasOutput = currentLength > 0
      const timeout = hasOutput ? idleTimeoutMs : firstTokenTimeoutMs
      if (!staleNotified && now - lastProgressAt >= Math.max(10_000, Math.floor(timeout / 2))) {
        staleNotified = true
        options.onStaleOutput?.()
      }
      if (now - startedAt >= totalTimeoutMs) {
        reject(new Error(`Agent 输出超过 ${Math.round(totalTimeoutMs / 1000)} 秒仍未完成，已中断本次调用`))
        return
      }
      if (now - lastProgressAt >= timeout) {
        reject(new Error(hasOutput
          ? `Agent 已 ${Math.round(idleTimeoutMs / 1000)} 秒没有继续输出，已中断本次调用`
          : `Agent 在 ${Math.round(firstTokenTimeoutMs / 1000)} 秒内没有输出，已中断本次调用`
        ))
      }
    }, 1000)
  }).finally(() => {
    settled = true
    if (watchdog) clearInterval(watchdog)
  })

  await Promise.race([streamPromise, timeoutPromise])
}

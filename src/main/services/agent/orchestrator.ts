import { agentConfigRepo } from '../../db/repositories/agent-config.repo'
import { chapterRepo } from '../../db/repositories/chapter.repo'
import { conversationRepo } from '../../db/repositories/conversation.repo'
import { AgentRuntime, type AgentRunResult } from './agent-runtime'
import { AgentContextManager } from './context-manager'
import { assessAgentOutput, inspectChinesePunctuation, validateChapterDraft } from './quality-monitor'
import { MessageBus } from './message-bus'
import { ToolRegistry, toolFail, toolOk } from './tool-registry'
import { countContentChars } from '../../../shared/textMetrics'

export type CollaborationMode = 'round_robin' | 'moderator'

export const MAX_WORKER_CALLS_PER_MODERATOR_TURN = 1
const MAX_CONSECUTIVE_WORKER_TIMEOUTS = 2
const WORKER_MAX_TOKENS_CAP = 6000
const WORKER_FIRST_TOKEN_TIMEOUT_MS = 180_000
const WORKER_STREAM_IDLE_TIMEOUT_MS = 120_000
const DEFAULT_MODERATOR_MAX_ROUNDS = 30
const DEFAULT_CHAPTER_TARGET_CHARS = 2000
const MIN_CHAPTER_TARGET_CHARS = 300
const MAX_CHAPTER_TARGET_CHARS = 20000
const MIN_CHAPTER_TARGET_RATIO = 0.6

export interface WorkflowCallbacks {
  onAgentStart: (agentId: string, agentName: string) => void
  onAgentToken: (agentId: string, token: string) => void
  onAgentThinking: (agentId: string, thinking: string) => void
  onAgentComplete: (agentId: string, result: AgentRunResult) => void
  onRoundComplete: (round: number) => void
  onWorkflowComplete: (summary: string) => void
  onChapterWrite: (chapterId: string, oldContent: string, newContent: string) => void
  onChapterCreate: (chapter: { id: string; project_id: string; parent_id: string | null; title: string; content: string; sort_order: number; word_count: number; status: string; created_at: string; updated_at: string }) => void
  onError: (error: Error) => void
}

export interface WorkflowControl {
  abortController: AbortController
  injectedMessages: string[]
  stop(): void
  injectMessage(message: string): void
}

class WorkflowAbortError extends Error {
  constructor() {
    super('工作流已被用户停止')
    this.name = 'WorkflowAbortError'
  }
}

export interface WritingContinuityPlan {
  continuous: boolean
  targetChapterChars: number
  hasExplicitChapterTarget: boolean
  enforceChapterTarget: boolean
}

export interface CallAgentInput {
  agentId: string
  prompt: string
}

export class Orchestrator {
  private currentControl: WorkflowControl | null = null

  getActiveControl(): WorkflowControl | null {
    return this.currentControl
  }

  async runWorkflow(
    groupId: string,
    projectId: string,
    inputContext: string,
    callbacks: WorkflowCallbacks
  ): Promise<void> {
    const group = agentConfigRepo.getGroupById(groupId)
    if (!group) {
      callbacks.onError(new Error('Agent 组不存在'))
      return
    }

    const members = agentConfigRepo.getGroupMembers(groupId)
    if (members.length === 0) {
      callbacks.onError(new Error('Agent 组中没有成员'))
      return
    }

    const abortController = new AbortController()
    const injectedMessages: string[] = []
    const control: WorkflowControl = {
      abortController,
      injectedMessages,
      stop() { abortController.abort() },
      injectMessage(msg: string) { injectedMessages.push(msg) }
    }
    this.currentControl = control

    try {
      if (group.collaboration_mode === 'moderator') {
        await this.runModeratorMode(groupId, projectId, inputContext, members, callbacks, abortController.signal, injectedMessages)
      } else {
        await this.runRoundRobin(groupId, projectId, inputContext, members, callbacks, abortController.signal, injectedMessages)
      }
    } finally {
      this.currentControl = null
    }
  }

  private async runRoundRobin(
    groupId: string,
    projectId: string,
    inputContext: string,
    members: any[],
    callbacks: WorkflowCallbacks,
    signal: AbortSignal,
    injectedMessages: string[]
  ): Promise<void> {
    const bus = new MessageBus()
    const toolRegistry = new ToolRegistry(projectId, callbacks.onChapterWrite, callbacks.onChapterCreate)
    const runtime = new AgentRuntime(toolRegistry)
    const contextManager = new AgentContextManager()
    const orderedMembers = [...members].sort((a, b) => a.turn_order - b.turn_order)
    const maxRounds = 30

    for (const member of orderedMembers) {
      bus.getMessagesFor(member.agent_id)
    }
    bus.broadcast({ role: 'user', content: inputContext })

    let round = 0
    let conversationId: string | null = null

    while (round < maxRounds) {
      if (signal.aborted) {
        callbacks.onError(new WorkflowAbortError())
        return
      }

      while (injectedMessages.length > 0) {
        const msg = injectedMessages.shift()!
        bus.broadcast({ role: 'user', content: `[用户指令] ${msg}` })
        callbacks.onAgentThinking('', `[用户注入指令] ${msg}`)
      }

      let anyAgentTriggered = false

      for (const member of orderedMembers) {
        if (signal.aborted) {
          callbacks.onError(new WorkflowAbortError())
          return
        }

        const messages = bus.getMessagesFor(member.agent_id)
        if (messages.length === 0) continue
        bus.clearQueue(member.agent_id)

        anyAgentTriggered = true
        callbacks.onAgentStart(member.agent_id, member.name)

        try {
          const result = await runtime.execute(
            member as any,
            messages,
            (token) => callbacks.onAgentToken(member.agent_id, token),
            (thinking) => callbacks.onAgentThinking(member.agent_id, thinking)
          )
          const contextStats = contextManager.record(result.content)
          const quality = assessAgentOutput(result.content, result.toolCalls, contextStats.ratio)
          if (quality.issues.length > 0) {
            callbacks.onAgentThinking(member.agent_id, `[质量监控] ${quality.issues.join('；')}`)
          }
          callbacks.onAgentComplete(member.agent_id, result)
          bus.sendFrom(member.agent_id, { role: 'assistant', content: result.content })

          if (!conversationId) {
            const conv = conversationRepo.create(projectId)
            conversationId = conv.id
          }
          conversationRepo.addMessage(conversationId, 'assistant', result.content, member.agent_id)
        } catch (err) {
          if (signal.aborted || err instanceof WorkflowAbortError) {
            callbacks.onError(new WorkflowAbortError())
            return
          }
          callbacks.onError(err instanceof Error ? err : new Error(String(err)))
          return
        }
      }

      if (!anyAgentTriggered) break
      callbacks.onRoundComplete(round)
      round++
    }

    if (round >= maxRounds) {
      callbacks.onError(new Error(`轮询工作流超过 ${maxRounds} 轮仍未收敛，已停止。请缩小任务或调整 Agent 提示词。`))
      return
    }

    callbacks.onWorkflowComplete(`工作流完成，共 ${round} 轮`)
  }

  private async runModeratorMode(
    groupId: string,
    projectId: string,
    inputContext: string,
    members: any[],
    callbacks: WorkflowCallbacks,
    signal: AbortSignal,
    injectedMessages: string[]
  ): Promise<void> {
    // Find the moderator agent
    const moderator = members.find((m: any) => m.is_moderator === 1)
    if (!moderator) {
      callbacks.onError(new Error('Moderator 模式需要指定一个主编 Agent（设为 moderator）'))
      return
    }

    const workers = members.filter((m: any) => m.agent_id !== moderator.agent_id)
    if (workers.length === 0) {
      callbacks.onError(new Error('除主编外还需要至少一个工作 Agent'))
      return
    }

    const moderatorToolRegistry = new ToolRegistry(projectId, callbacks.onChapterWrite, callbacks.onChapterCreate)
    const workerToolRegistry = new ToolRegistry(projectId, callbacks.onChapterWrite, callbacks.onChapterCreate)
    const moderatorRuntime = new AgentRuntime(moderatorToolRegistry)
    const workerRuntime = new AgentRuntime(workerToolRegistry)
    const contextManager = new AgentContextManager()
    let workerCallsSinceLastChapterWrite = 0
    let successfulWorkerCallsThisTurn = 0
    let workerAgentIdsDeliveredThisTurn = new Set<string>()
    let consecutiveWorkerTimeouts = 0
    let totalWorkerCalls = 0
    let totalSuccessfulChapterWrites = 0
    let totalSuccessfulOutlineWrites = 0
    const expectedChapterWrites = estimateRequestedChapterCount(inputContext)
    const needsChapterDelivery = shouldRequireChapterDelivery(inputContext)
    const needsOutlineDelivery = shouldRequireOutlineDelivery(inputContext)
    const writingPlan = buildWritingContinuityPlan(inputContext)

    // Register call_agent tool for the moderator
    moderatorToolRegistry.registerTool({
      name: 'call_agent',
      description: `调用其他 Agent 执行子任务。可用的 Agent: ${workers.map((w: any) => `${w.name}(${w.role})`).join(', ')}。主编模式按串行调度：每轮最多只整合 ${MAX_WORKER_CALLS_PER_MODERATOR_TURN} 个工作 Agent 的可用交付，不要在同一轮并行请求多个工作 Agent。参数错误、模型参数限制、超时或未交付可用结果时，不占用名额，可以修正 prompt 后重试同一个 Agent。`,
      execute: async (input: string) => {
        if (signal.aborted) throw new WorkflowAbortError()

        const parsedCall = parseCallAgentInput(input)
        if (!parsedCall) {
          return toolFail('格式错误，请使用: agent_id: <id>\\nprompt: <内容>。也支持 JSON: {"agent_id":"<id>","prompt":"<内容>"}')
        }

        const targetAgentId = parsedCall.agentId
        const prompt = parsedCall.prompt
        const targetAgent = workers.find((m: any) =>
          m.agent_id === targetAgentId ||
          m.name === targetAgentId ||
          m.role === targetAgentId
        )
        if (!targetAgent) return toolFail(`未找到可调用的工作 Agent: ${targetAgentId}。可用: ${workers.map((w: any) => `${w.agent_id}(${w.name})`).join(', ')}。主编不能调用自己。`)

        if (workerAgentIdsDeliveredThisTurn.has(targetAgent.agent_id)) {
          return toolFail(`本轮已经收到过「${targetAgent.name}」的可用交付。请先整合已获得结果；若仍缺材料，下一轮再继续调度。`)
        }

        if (successfulWorkerCallsThisTurn >= MAX_WORKER_CALLS_PER_MODERATOR_TURN) {
          return toolFail(`主编模式当前为串行调度，本轮最多只能整合 ${MAX_WORKER_CALLS_PER_MODERATOR_TURN} 个工作 Agent 的可用交付。请先整合已获得结果；若仍缺材料，下一轮再继续调度。`)
        }

        callbacks.onAgentStart(targetAgent.agent_id, targetAgent.name)
        try {
          const nextChapterNumber = chapterRepo.listByProject(projectId).length + 1
          const workerPrompt = enrichWorkerPrompt(prompt, writingPlan, needsChapterDelivery, nextChapterNumber)
          const result = await workerRuntime.execute(
            prepareWorkerAgentForRuntime(targetAgent) as any,
            [{ role: 'user', content: workerPrompt }],
            (token) => callbacks.onAgentToken(targetAgent.agent_id, token),
            (thinking) => callbacks.onAgentThinking(targetAgent.agent_id, thinking)
          )
          consecutiveWorkerTimeouts = 0
          totalWorkerCalls++
          const workerDelivery = assessWorkerDelivery(result)
          if (result.quality.issues.length > 0) {
            callbacks.onAgentThinking(targetAgent.agent_id, `[质量监控] ${result.quality.issues.join('；')}`)
          }
          if (workerDelivery.ok) {
            workerCallsSinceLastChapterWrite++
            successfulWorkerCallsThisTurn++
            workerAgentIdsDeliveredThisTurn.add(targetAgent.agent_id)
          } else {
            callbacks.onAgentThinking(targetAgent.agent_id, `[交付保护] ${workerDelivery.reason}`)
          }
          totalSuccessfulChapterWrites += countSuccessfulChapterWrites(result)
          totalSuccessfulOutlineWrites += countSuccessfulOutlineWrites(result)
          const deliveredContent = workerDelivery.ok ? (extractUsableWorkerContent(result.content) ?? result.content) : result.content
          const deliveredResult = workerDelivery.ok && deliveredContent !== result.content
            ? { ...result, content: deliveredContent, quality: assessAgentOutput(deliveredContent, result.toolCalls) }
            : result
          callbacks.onAgentComplete(targetAgent.agent_id, deliveredResult)
          if (!workerDelivery.ok) {
            return toolFail([
              `子 Agent「${targetAgent.name}」未交付可用结果：${workerDelivery.reason}`,
              '请重新调用该 Agent 或换一个 Agent，并明确要求输出完整章节正文/可执行方案；不要让子 Agent 以“等待下一步任务”“请主编裁定”收尾。',
              `原输出摘要：${truncateText(result.content, 800)}`
            ].join('\n'))
          }
          return toolOk(`[${targetAgent.name} 的回复]\n${deliveredContent}`, {
            agentId: targetAgent.agent_id,
            toolCalls: result.toolCalls
          }, result.toolCalls.flatMap(call => call.uiEffects ?? []))
        } catch (err) {
          if (signal.aborted || err instanceof WorkflowAbortError) throw err
          const message = (err as Error).message
          if (isWorkerRuntimeTimeout(message)) {
            consecutiveWorkerTimeouts++
            callbacks.onAgentThinking(
              targetAgent.agent_id,
              `[运行保护] ${targetAgent.name} 无响应：${message}（连续 ${consecutiveWorkerTimeouts}/${MAX_CONSECUTIVE_WORKER_TIMEOUTS}）`
            )
            if (consecutiveWorkerTimeouts >= MAX_CONSECUTIVE_WORKER_TIMEOUTS) {
              return toolFail(buildWorkerTimeoutRecoveryMessage(consecutiveWorkerTimeouts))
            }
          } else {
            consecutiveWorkerTimeouts = 0
          }
          return toolFail(`调用 ${targetAgent.name} 失败: ${message}。这次失败不会占用本轮工作 Agent 名额；请修正参数或 prompt 后可以重新调用同一 Agent。`)
        }
      }
    })

    moderatorToolRegistry.registerTool({
      name: 'create_chapter',
      description: '创建新章节并写入正文。主编必须先调用至少一个工作 Agent 获取正文/方案后才能使用。',
      execute: async (input: string) => {
        if (workerCallsSinceLastChapterWrite <= 0) {
	          return toolFail('已拦截：主编不能绕过工作 Agent 直接创建章节。请先使用 call_agent 调用至少一个子 Agent 获取该章正文或方案，再创建章节。')
        }

        const lengthProblem = getChapterTargetLengthProblem(input, writingPlan)
        if (lengthProblem) return toolFail(lengthProblem)

        const output = await workerToolRegistry.execute('create_chapter', input)
        if (output.ok) {
          workerCallsSinceLastChapterWrite = 0
          totalSuccessfulChapterWrites++
        }
        return output
      }
    })

    moderatorToolRegistry.registerTool({
      name: 'write_chapter',
      description: '写入或更新章节内容。主编必须先调用至少一个工作 Agent 获取正文/方案后才能使用。',
      execute: async (input: string) => {
        if (workerCallsSinceLastChapterWrite <= 0) {
	          return toolFail('已拦截：主编不能绕过工作 Agent 直接写入章节。请先使用 call_agent 调用至少一个子 Agent 获取该章正文或方案，再写入章节。')
        }

        const lengthProblem = getChapterTargetLengthProblem(input, writingPlan)
        if (lengthProblem) return toolFail(lengthProblem)

        const output = await workerToolRegistry.execute('write_chapter', input)
        if (output.ok) {
          workerCallsSinceLastChapterWrite = 0
          totalSuccessfulChapterWrites++
        }
        return output
      }
    })

    moderatorToolRegistry.registerTool({
      name: 'write_outline',
      description: '创建或更新项目的大纲/细纲。主编必须先调用至少一个工作 Agent 获取大纲/细纲方案后才能使用。',
      execute: async (input: string) => {
        if (workerCallsSinceLastChapterWrite <= 0) {
          return toolFail('已拦截：主编不能绕过工作 Agent 直接写入大纲/细纲。请先使用 call_agent 调用至少一个子 Agent 获取方案，再写入大纲/细纲。')
        }

        const output = await workerToolRegistry.execute('write_outline', input)
        if (output.ok) {
          workerCallsSinceLastChapterWrite = 0
          totalSuccessfulOutlineWrites++
        }
        return output
      }
    })

    // Moderator loop
    let round = 0
    const maxRounds = getModeratorMaxRounds(inputContext)
    const initialChapterCount = chapterRepo.listByProject(projectId).length
    let lastCompletedChapterCount = initialChapterCount
    let consecutiveCompleteWithoutNewChapters = 0

    let conversationMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      {
        role: 'user',
        content: `你是主编 Agent。你的团队有: ${workers.map((w: any) => `- ${w.name} (${w.role}, ID: ${w.agent_id})`).join('\n')}\n\n任务: ${inputContext}\n\n你的职责是调度、审核、整合，不是绕过团队自己完成正文。请先分析任务，然后必须使用 [TOOL:call_agent] agent_id: <agent_id>\nprompt: <你的指令>\n[/TOOL] 调用工作 Agent。主编模式使用串行调度：每轮最多只整合 ${MAX_WORKER_CALLS_PER_MODERATOR_TURN} 个工作 Agent 的可用交付，不要在同一轮并行请求多个工作 Agent；如果还需要规则/线索/氛围补充，下一轮再调度。参数错误、模型参数限制、超时或未交付可用结果不算可用交付，请修正 prompt 后重试原 Agent，不要因为一次失败就改调不适合任务的 Agent。写章节时优先调用 1 个主笔 Agent 拿完整正文。拿到工作 Agent 结果后，再审核、整合并使用章节工具入库。${buildModeratorCompletionInstruction(writingPlan)}`
      }
    ]

    conversationMessages.push({
      role: 'user',
      content: `补充规则：
你必须交付小说章节正文，不要只输出工作总结。

可用章节工具：
[TOOL:list_chapters]
[/TOOL]

[TOOL:fact_check_chapter]
<待核查章节正文>
[/TOOL]

[TOOL:create_chapter]
title: <章节标题>
content:
<完整章节正文>
[/TOOL]

[TOOL:write_chapter]
chapter_id: <章节ID>
content:
<完整章节正文>
[/TOOL]

可用大纲/细纲工具：
[TOOL:read_outline]
type: outline|detailed（可选，默认读取全部）
[/TOOL]

[TOOL:write_outline]
type: <outline|detailed>
title: <标题>
content:
<完整内容>
[/TOOL]

可用知识库工具：
[TOOL:list_knowledge]
列出当前项目知识库中的所有文档（文件名、类型、字符数）
[/TOOL]

[TOOL:search_knowledge_base]
<搜索关键词>
[/TOOL]

[TOOL:analyze_entity]
<角色名/实体名>
[/TOOL]

知识库使用规范（重要）：
1. 创作前必须先用 list_knowledge 查看知识库中有哪些参考文档
2. 搜索时使用具体的关键词：角色名、地名、专有名词、特定术语，而非泛泛的描述
3. 如果一次搜索结果不足或相关度低，换不同角度的关键词再次搜索
4. 严格基于检索到的原文内容进行创作参考，绝对不要编造知识库中不存在的设定、情节或人物关系
5. 知识库检索返回的是「参考素材」，不是「必须复制的原文」。你可以借鉴风格和设定，但创作内容必须是原创的
6. 如果搜索不到相关内容，说明该设定在参考资料中不存在，应自行合理设计并在大纲中记录

人物/角色分析规定：
- 分析人物关系前，必须先使用 analyze_entity 对该角色做深度检索
- 关系分析分为两个层级：
  ① 事实：原文明确写出的关系（如「X是Y的父亲」「X和Y结为道侣」），标注为「事实」
  ② 推断：多个chunk呈现同一互动模式（如多处暧昧行为 → 「疑似情侣」），标注为「推断」+ 证据
- 允许推断：LLM擅长文学分析，从多次出现的模式中推断关系是合理且期望的行为
- 允许共现分析：如果A和B在大量chunk中同框且有亲密/冲突等关键词线索，可以推断关系
- 禁止凭空编造：没有原文依据的人物名、事件、设定不能出现
- 推断必须列出支持证据（chunk编号 + 原文引用），不接受无证据的推断

创作前应先使用 read_outline 读取项目的大纲和细纲，确保内容与已有设定一致。如果大纲/细纲不存在，可使用 write_outline 创建。
每一章拿到正文后，先使用 fact_check_chapter 做一致性核查；如发现冲突或缺少依据，先修订正文，再创建或写入章节。
每一章入库前必须做正文终审：补齐自然中文标点，拆开过长无停顿句，修正病句和节奏问题。子 Agent 交来的正文如果缺少逗号、句号或分号，主编必须先润色修订，不能直接入库。
当用户要求连续创作多章时，按章节顺序循环：规划当前章、调用工作 Agent、核查并审核当前章、创建或写入该章，然后自动继续下一章。单章通过即刻入库，不要等全部章节完成后再统一入库。只有用户给出明确章节数量且这些章节都已入库后，才输出 [WORKFLOW_COMPLETE]。
${buildWritingContinuityPrompt(writingPlan, needsChapterDelivery)}

重要：
1. 你必须先使用 call_agent 调用至少一个工作 Agent，拿到该章正文/方案后，才允许创建或写入章节。
2. 主编调度必须串行执行：每轮最多整合 ${MAX_WORKER_CALLS_PER_MODERATOR_TURN} 个工作 Agent 的可用交付，不要同轮并行请求多个 Agent。调用失败、参数错误、模型参数限制、超时、或子 Agent 未交付可用结果时，不算占用名额；你应该修正 prompt 后重试原 Agent，而不是为了绕开名额限制改调不适合任务的 Agent。
3. 每写入一章后，下一章必须重新调用至少一个工作 Agent，不能用旧调用记录连续自己写。
4. 你必须使用 create_chapter 或 write_chapter 工具将每章正文实际写入数据库，仅在工具调用成功返回后才视为该章完成。
5. 不要假设章节已存在，每次都必须显式调用工具。
6. 如果没有成功调用工作 Agent，不要输出 [WORKFLOW_COMPLETE]。`
    })

    while (round < maxRounds) {
      if (signal.aborted) {
        callbacks.onError(new WorkflowAbortError())
        return
      }

      while (injectedMessages.length > 0) {
        const msg = injectedMessages.shift()!
        conversationMessages.push({
          role: 'user',
          content: `[用户新指令] ${msg}\n\n请根据此新指令调整工作方向。如果需要更多工作，继续调用工作 Agent。没有成功调用工作 Agent 前，不要自己写章节，也不要输出 [WORKFLOW_COMPLETE]。`
        })
        callbacks.onAgentThinking(moderator.agent_id, `[用户注入指令] ${msg}`)
      }

      callbacks.onAgentStart(moderator.agent_id, `主编: ${moderator.name}`)
      callbacks.onRoundComplete(round)

      try {
        const compressed = contextManager.compress(conversationMessages)
        if (compressed.stats.compressed) {
          conversationMessages = compressed.messages as Array<{ role: 'user' | 'assistant'; content: string }>
          callbacks.onAgentThinking(moderator.agent_id, `[上下文压缩] 累计 token 已降至 ${compressed.stats.totalTokens}/${compressed.stats.limit} (${Math.round(compressed.stats.ratio * 100)}%)`)
        }

        const workerCallsBeforeTurn = totalWorkerCalls
        successfulWorkerCallsThisTurn = 0
        workerAgentIdsDeliveredThisTurn = new Set<string>()
        const result = await moderatorRuntime.execute(
          moderator as any,
          conversationMessages,
          (token) => callbacks.onAgentToken(moderator.agent_id, token),
          (thinking) => callbacks.onAgentThinking(moderator.agent_id, thinking)
        )
        const contextStats = contextManager.record(result.content)
        const quality = assessAgentOutput(result.content, result.toolCalls, contextStats.ratio)
        if (quality.issues.length > 0) {
          callbacks.onAgentThinking(moderator.agent_id, `[质量监控] ${quality.issues.join('；')}`)
        }
        callbacks.onAgentComplete(moderator.agent_id, result)

        conversationMessages.push({ role: 'assistant', content: result.content })
        const workerCallsThisTurn = totalWorkerCalls - workerCallsBeforeTurn

        if (consecutiveWorkerTimeouts >= MAX_CONSECUTIVE_WORKER_TIMEOUTS) {
          const message = buildWorkerTimeoutRecoveryMessage(consecutiveWorkerTimeouts)
          callbacks.onAgentThinking(moderator.agent_id, `[运行保护] ${message}`)
          conversationMessages.push({
            role: 'user',
            content: `${message}

不要结束工作流。请换一个工作 Agent，或把任务拆成更小的单章请求继续推进。当前目标仍然是继续写作并把下一章实际写入数据库。`
          })
          consecutiveWorkerTimeouts = 0
          round++
          continue
        }

        if (workerCallsThisTurn === 0 && result.toolCalls.length === 0 && !result.content.includes('[WORKFLOW_COMPLETE]')) {
          callbacks.onAgentThinking(moderator.agent_id, `[调度保护] 本轮主编没有调用任何工作 Agent，已要求重新调度`)
          conversationMessages.push({
            role: 'user',
            content: `调度保护：你本轮没有调用任何工作 Agent，也没有执行有效工具。主编模式下你不能只自己输出内容。

请立即使用 call_agent 调用至少一个工作 Agent。拿到子 Agent 的结果后，再审核、整合并决定是否写入章节。`
          })
          round++
          continue
        }

      const currentChapterCount = chapterRepo.listByProject(projectId).length
      const newChaptersThisRound = currentChapterCount - lastCompletedChapterCount

      if (newChaptersThisRound > 0) {
        lastCompletedChapterCount = currentChapterCount
        consecutiveCompleteWithoutNewChapters = 0
        callbacks.onAgentThinking(moderator.agent_id, `[入库确认] 本轮新增 ${newChaptersThisRound} 章，累计已入库 ${currentChapterCount - initialChapterCount} 章`)
        if (writingPlan.continuous) {
          callbacks.onAgentThinking(moderator.agent_id, `[持续写作] 已完成 ${currentChapterCount - initialChapterCount} 章，将自动进入下一章，直到用户停止工作流`)
        }
      }

      if (result.content.includes('[WORKFLOW_COMPLETE]')) {
        const deliveryProblem = getDeliveryProblem({
          needsChapterDelivery,
          needsOutlineDelivery,
          expectedChapterWrites,
          totalSuccessfulChapterWrites,
          totalSuccessfulOutlineWrites,
          continuousWriting: writingPlan.continuous
        })
        if (deliveryProblem) {
          consecutiveCompleteWithoutNewChapters++
          callbacks.onAgentThinking(moderator.agent_id, `[警告] 主编声称完成但交付未达标：${deliveryProblem}，强制继续工作`)
          conversationMessages.push({
            role: 'user',
            content: `警告：你声称工作已完成，但交付未达标：${deliveryProblem}。

当前项目共有 ${currentChapterCount} 章（工作流开始时有 ${initialChapterCount} 章）。
本工作流已成功写入章节 ${totalSuccessfulChapterWrites} 次，成功写入大纲/细纲 ${totalSuccessfulOutlineWrites} 次。

你必须先使用 call_agent 调用至少一个工作 Agent，再使用对应写入工具将结果实际写入数据库。仅输出总结或声明完成是不够的。

请立即调用工作 Agent，然后创建/写入缺失章节。${writingPlan.continuous ? '这是持续写作任务，不存在“全部章节已完成”；每写完一章就继续下一章，直到用户手动停止工作流。' : '不要再次输出 [WORKFLOW_COMPLETE]，直到所有章节都通过工具调用成功入库。'}`
          })
            round++
            continue
          }

        const totalNewChapters = currentChapterCount - initialChapterCount
        const summary = result.content.replace('[WORKFLOW_COMPLETE]', '').trim()
        callbacks.onWorkflowComplete(`${summary}\n\n【实际交付统计】新增章节 ${totalNewChapters} 章，成功章节写入 ${totalSuccessfulChapterWrites} 次，成功大纲/细纲写入 ${totalSuccessfulOutlineWrites} 次，总章节 ${currentChapterCount} 章`)
        return
      }

        // Continue: give moderator the results of the tool calls
        const TOOL_OUTPUT_MAX = 50000
        const trimmedCalls = result.toolCalls.map(tc => {
          let output = tc.output
          if (output.length > TOOL_OUTPUT_MAX) {
            const head = output.slice(0, TOOL_OUTPUT_MAX)
            const tail = output.slice(-3000)
            output = head + `\n\n⚠ [工具输出过长已截断，总长度${tc.output.length}字符，以下为末尾部分]\n\n` + tail
          }
          return `[${tc.tool}]\n${output}`
        })

        const toolSummary = trimmedCalls.join('\n\n')

        if (toolSummary && !result.content.includes('[WORKFLOW_COMPLETE]')) {
          conversationMessages.push({
            role: 'user',
            content: `以下是工具执行结果:\n${toolSummary}\n\n请继续。主编调度按串行执行：每轮最多整合 ${MAX_WORKER_CALLS_PER_MODERATOR_TURN} 个工作 Agent 的可用交付，优先整合已拿到的结果，不要同轮并行请求多个 Agent。若 call_agent 提示参数错误、模型参数限制、超时或“未交付可用结果”，这不占用名额；请修正 prompt 后重试同一个最适合任务的 Agent，并明确要求交付完整章节正文/可执行方案，不能等待确认。若章节写入工具被拦截，说明你还没有为该章成功调用工作 Agent，必须先调用 call_agent。${buildContinueInstruction(writingPlan)}`
          })
        }
      } catch (err) {
        if (signal.aborted || err instanceof WorkflowAbortError) {
          callbacks.onError(new WorkflowAbortError())
          return
        }
        callbacks.onError(err instanceof Error ? err : new Error(String(err)))
        return
      }

      round++
    }

    callbacks.onError(new Error(`主编工作流超过 ${maxRounds} 轮仍未完成，已停止。请缩小任务、提高子 Agent 指令明确度，或检查工具调用是否持续失败。`))
  }
}

export function hasUsefulWorkerOutput(result: AgentRunResult): boolean {
  return assessWorkerDelivery(result).ok
}

interface WorkerDeliveryAssessment {
  ok: boolean
  reason?: string
}

export function assessWorkerDelivery(result: AgentRunResult): WorkerDeliveryAssessment {
  if (result.toolCalls.some(call => call.ok !== false && (call.tool === 'create_chapter' || call.tool === 'write_chapter' || call.tool === 'write_outline'))) {
    return { ok: true }
  }

  const content = result.content.trim()
  if (!content) {
    return { ok: false, reason: '子 Agent 没有输出内容' }
  }

  if (isPassiveWorkerOutput(content)) {
    return { ok: false, reason: '子 Agent 以等待确认/请主编裁定收尾，没有交付可直接推进的正文或方案' }
  }

  const usableContent = extractUsableWorkerContent(content)
  if (usableContent) {
    return { ok: true }
  }

  const punctuation = inspectChinesePunctuation(content)
  if (!punctuation.ok) {
    return { ok: false, reason: punctuation.reason ?? '子 Agent 输出标点异常' }
  }

  return { ok: true }
}

export function extractUsableWorkerContent(content: string): string | null {
  const candidates = extractWorkerContentCandidates(content)
  for (const candidate of candidates) {
    if (validateChapterDraft(candidate).ok) return candidate
  }
  return null
}

function extractWorkerContentCandidates(content: string): string[] {
  const cleaned = content
    .replace(/\r\n/g, '\n')
    .replace(/\[\s*TOOL\s*:[\s\S]*?\[\s*\/\s*TOOL\s*\]/gi, '')
    .replace(/\[WORKFLOW_COMPLETE\]/g, '')
    .trim()
  if (!cleaned) return []

  const candidates: string[] = []
  candidates.push(...extractBodySections(cleaned))
  candidates.push(...extractChapterSections(cleaned))
  candidates.push(cleaned)

  const seen = new Set<string>()
  return candidates
    .map(candidate => candidate.trim())
    .filter(candidate => {
      if (!candidate || seen.has(candidate)) return false
      seen.add(candidate)
      return true
    })
}

function extractBodySections(content: string): string[] {
  const lines = content.split('\n')
  const sections: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!isBodyHeading(lines[i])) continue

    const bodyLines: string[] = []
    for (const line of lines.slice(i + 1)) {
      const normalized = normalizeHeading(line)
      if (bodyLines.length > 0 && isBodyHeading(line)) break
      if (isMetaHeading(normalized)) break
      bodyLines.push(line)
    }

    const section = bodyLines.join('\n').trim()
    if (section) sections.push(section)
  }
  return sections
}

function extractChapterSections(content: string): string[] {
  const lines = content.split('\n')
  const starts: number[] = []
  lines.forEach((line, index) => {
    if (/^第[一二三四五六七八九十百千万\d]+[章节回幕卷]/.test(normalizeHeading(line))) {
      starts.push(index)
    }
  })
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length
    return lines.slice(start, end).join('\n').trim()
  }).filter(Boolean)
}

function isBodyHeading(line: string): boolean {
  return /^(正文|正文定稿|最终正文|小说正文|章节正文|成稿|正文稿|最终稿|交付正文)[:：]?$/.test(normalizeHeading(line))
}

function isMetaHeading(normalized: string): boolean {
  return /^(校验|核验|总结|工作总结|交付说明|最终交付|备注|大纲|提纲|修改说明|审稿意见|字数校验|结构校验|人物校验|设定校验|风险提醒|节奏说明|氛围师工作汇报|主编分析)/.test(normalized)
}

function normalizeHeading(line: string): string {
  return line.trim().replace(/^#{1,6}\s*/, '').replace(/^\*\*|\*\*$/g, '').trim()
}

export function isPassiveWorkerOutput(content: string): boolean {
  return /(等待下一步|等待.*任务分配|请.*主编.*(审阅|裁定|整合|确认)|提请主编|是否入库|调度指示完毕|下一步任务分配确认|等待.*确认中)/.test(content)
}

export function isWorkerRuntimeTimeout(message: string): boolean {
  return /Agent (?:在 \d+ 秒内没有输出|已 \d+ 秒没有继续输出|输出超过 \d+ 秒仍未完成|输出重复退化)/.test(message)
}

function buildWorkerTimeoutRecoveryMessage(count: number): string {
  return `连续 ${count} 次工作 Agent 在首 token/输出阶段无响应。系统已将其视为单次成员失败，而不是整个工作流失败；请换用其他工作 Agent、缩小本章任务，或降低单次输出压力后继续调度。`
}

export function prepareWorkerAgentForRuntime(agent: any): any {
  let params: Record<string, unknown>
  try {
    const parsed = JSON.parse(agent.parameters || '{}')
    params = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return agent
  }

  const maxTokens = readNumberParam(params.maxTokens ?? params.max_tokens)
  if (maxTokens === undefined || maxTokens > WORKER_MAX_TOKENS_CAP) {
    params.maxTokens = WORKER_MAX_TOKENS_CAP
    params.max_tokens = WORKER_MAX_TOKENS_CAP
  }

  params.firstTokenTimeoutMs = readNumberParam(params.firstTokenTimeoutMs ?? params.first_token_timeout_ms) ?? WORKER_FIRST_TOKEN_TIMEOUT_MS
  params.first_token_timeout_ms = params.firstTokenTimeoutMs
  params.streamIdleTimeoutMs = readNumberParam(params.streamIdleTimeoutMs ?? params.stream_idle_timeout_ms) ?? WORKER_STREAM_IDLE_TIMEOUT_MS
  params.stream_idle_timeout_ms = params.streamIdleTimeoutMs

  return {
    ...agent,
    parameters: JSON.stringify(params)
  }
}

function readNumberParam(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function countSuccessfulChapterWrites(result: AgentRunResult): number {
  return result.toolCalls.filter(call =>
    (call.tool === 'create_chapter' || call.tool === 'write_chapter') && call.ok !== false
  ).length
}

function countSuccessfulOutlineWrites(result: AgentRunResult): number {
  return result.toolCalls.filter(call => call.tool === 'write_outline' && call.ok !== false).length
}

function truncateText(text: string, maxLength: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength)}...`
}

export function parseCallAgentInput(input: string): CallAgentInput | null {
  const jsonParsed = parseCallAgentJsonInput(input)
  if (jsonParsed) return jsonParsed

  const agentId = readLooseCallAgentField(input, ['agent_id', 'agentId', 'agent', 'target_agent', 'targetAgent'])
  const prompt = readLooseCallAgentPrompt(input)
  if (!agentId || !prompt) return null

  return {
    agentId: stripWrappingQuotes(agentId),
    prompt: stripWrappingQuotes(prompt)
  }
}

function parseCallAgentJsonInput(input: string): CallAgentInput | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const candidates = [trimmed]
  const objectMatch = trimmed.match(/\{[\s\S]*\}/)
  if (objectMatch && objectMatch[0] !== trimmed) candidates.push(objectMatch[0])

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const record = parsed as Record<string, unknown>
      const agentId = readRecordString(record, ['agent_id', 'agentId', 'agent', 'target_agent', 'targetAgent', 'name'])
      const prompt = readRecordString(record, ['prompt', 'instruction', 'task', 'content', 'message'])
      if (agentId && prompt) return { agentId, prompt }
    } catch {
      continue
    }
  }

  return null
}

function readLooseCallAgentField(input: string, names: string[]): string | null {
  for (const name of names) {
    const pattern = new RegExp(`^\\s*${name}\\s*[:=]\\s*(.+?)\\s*$`, 'im')
    const match = input.match(pattern)
    if (match?.[1]?.trim()) return match[1].trim()
  }
  return null
}

function readLooseCallAgentPrompt(input: string): string | null {
  const promptMatch = input.match(/^\s*(?:prompt|instruction|task|content|message)\s*[:=]\s*([\s\S]*)$/im)
  const prompt = promptMatch?.[1]?.trim()
  return prompt || null
}

function readRecordString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function stripWrappingQuotes(value: string): string {
  return value.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim()
}

export function buildWritingContinuityPlan(input: string): WritingContinuityPlan {
  const explicitTarget = estimateChapterTargetChars(input)
  const continuous = shouldContinueWritingIndefinitely(input)
  return {
    continuous,
    targetChapterChars: explicitTarget ?? DEFAULT_CHAPTER_TARGET_CHARS,
    hasExplicitChapterTarget: explicitTarget !== null,
    enforceChapterTarget: continuous || explicitTarget !== null
  }
}

export function shouldContinueWritingIndefinitely(input: string): boolean {
  const compact = input.replace(/\s+/g, '')
  if (!compact) return false
  const indefinite = /(一直|不停|不要停|别停|持续|长期|无限|无尽|写下去|一直写|持续写|连续不断|自动继续|直到.*停止|直到.*叫停|直到.*说停|直到用户.*停)/.test(compact)
  const writing = /(写|创作|生成|续写|连载|章节|正文|成稿)/.test(compact)
  return indefinite && writing
}

export function estimateChapterTargetChars(input: string): number | null {
  const compact = input.replace(/\s+/g, '')
  const arabicPatterns = [
    /(?:每章|单章|一章|章节)(?:字数|正文|内容|篇幅)?(?:约|大约|左右|不少于|至少|目标|控制在)?(\d{3,5})(?:字|字符)?/,
    /(\d{3,5})(?:字|字符)(?:左右|上下|以内|以上)?(?:每章|单章|一章|一节|章节)/,
    /(?:每章|单章|一章|章节).{0,6}?(\d{3,5})(?:字|字符)/
  ]
  for (const pattern of arabicPatterns) {
    const match = compact.match(pattern)
    if (match) return clampChapterTarget(Number(match[1]))
  }

  const chinesePatterns = [
    /(?:每章|单章|一章|章节)(?:字数|正文|内容|篇幅)?(?:约|大约|左右|不少于|至少|目标|控制在)?([零〇一二两三四五六七八九十百千万]{2,12})(?:字|字符)/,
    /([零〇一二两三四五六七八九十百千万]{2,12})(?:字|字符)(?:左右|上下|以内|以上)?(?:每章|单章|一章|一节|章节)/
  ]
  for (const pattern of chinesePatterns) {
    const match = compact.match(pattern)
    if (!match) continue
    const value = parseChineseInteger(match[1])
    if (value !== null) return clampChapterTarget(value)
  }

  return null
}

export function getModeratorMaxRounds(input: string): number {
  if (shouldContinueWritingIndefinitely(input)) return Number.POSITIVE_INFINITY
  const requestedChapters = estimateRequestedChapterCount(input)
  if (requestedChapters === null) return DEFAULT_MODERATOR_MAX_ROUNDS
  return Math.max(DEFAULT_MODERATOR_MAX_ROUNDS, requestedChapters * 4 + 10)
}

function buildModeratorCompletionInstruction(plan: WritingContinuityPlan): string {
  if (plan.continuous) {
    return '这是持续写作任务；不要输出 [WORKFLOW_COMPLETE]，也不要因为已经写了若干章就停下。只有用户手动停止工作流，或用户注入新指令要求结束时，才停止继续创作。'
  }
  return '完成后输出 [WORKFLOW_COMPLETE] 并附上总结。'
}

function buildWritingContinuityPrompt(plan: WritingContinuityPlan, needsChapterDelivery: boolean): string {
  if (!needsChapterDelivery) return ''

  const lines = [
    `章节篇幅要求：每章目标约 ${plan.targetChapterChars} 字。正文入库前必须检查篇幅；如果明显不足，先补写到目标篇幅附近，再调用 create_chapter/write_chapter。`
  ]

  if (plan.continuous) {
    lines.push('持续写作模式：用户要求一直写下去。你必须一章一章循环写作、审核、入库，然后自动进入下一章。不要输出 [WORKFLOW_COMPLETE]，不要等待用户确认下一章，直到用户点击停止或注入明确结束指令。')
  }

  return `\n${lines.join('\n')}\n`
}

function buildContinueInstruction(plan: WritingContinuityPlan): string {
  if (plan.continuous) {
    return `持续写作模式仍在进行：如果本轮已有章节成功入库，请立即规划并调度下一章；如果本轮尚未入库，请修正失败点后继续。每章目标约 ${plan.targetChapterChars} 字，不要输出 [WORKFLOW_COMPLETE]。`
  }
  return '需要更多工作时继续调用工作 Agent；任务完成且章节已实际入库后，才能输出 [WORKFLOW_COMPLETE]。'
}

function enrichWorkerPrompt(prompt: string, plan: WritingContinuityPlan, needsChapterDelivery: boolean, nextChapterNumber: number): string {
  if (!needsChapterDelivery) return prompt

  const additions = [
    '【系统补充交付要求】',
    `本次任务需要可直接推进的章节正文或明确可执行方案。若写正文，请按下一章顺序推进，当前预估应写第 ${nextChapterNumber} 章。`,
    `单章目标约 ${plan.targetChapterChars} 字；不要只写梗概、总结、片段或等待主编裁定。`,
    '正文必须有自然中文标点，结尾要形成章节钩子，但不要以“等待下一步任务”收尾。'
  ]

  if (plan.continuous) {
    additions.push('这是持续写作链路的一环：交付本章后，主编会继续调度下一章。你只需要把当前章写完整。')
  }

  return `${prompt}\n\n${additions.join('\n')}`
}

export function getChapterTargetLengthProblem(input: string, plan: WritingContinuityPlan): string | null {
  if (!plan.enforceChapterTarget) return null

  const content = extractChapterContentFromToolInput(input)
  if (content === null) return null

  const actualChars = countContentChars(content)
  const minimumChars = Math.max(80, Math.floor(plan.targetChapterChars * MIN_CHAPTER_TARGET_RATIO))
  if (actualChars >= minimumChars) return null

  return `章节篇幅不足：当前约 ${actualChars} 字，目标约 ${plan.targetChapterChars} 字，至少应达到 ${minimumChars} 字后再入库。请继续调用工作 Agent 补足本章正文，不要用摘要或片段冒充完整章节。`
}

function extractChapterContentFromToolInput(input: string): string | null {
  const contentMatch = input.match(/content:\s*([\s\S]*)/)
  return contentMatch ? contentMatch[1].trim() : null
}

function clampChapterTarget(value: number): number | null {
  if (!Number.isFinite(value) || value < MIN_CHAPTER_TARGET_CHARS) return null
  return Math.min(MAX_CHAPTER_TARGET_CHARS, Math.floor(value))
}

export function shouldRequireChapterDelivery(input: string): boolean {
  return /(正文|章节|第.{1,6}章|写.{0,6}章|续写|写下去|下一章|下一场|入库|放入正文)/.test(input)
}

export function shouldRequireOutlineDelivery(input: string): boolean {
  return /(大纲|细纲|纲要|故事结构|分章规划|章节规划)/.test(input)
}

export function estimateRequestedChapterCount(input: string): number | null {
  const arabic = input.match(/(?:前|写|创作|生成|连续|来|要)?\s*(\d{1,3})\s*(?:个)?(?:章|章节)/)
  if (arabic) return Number(arabic[1])

  const chinese = input.match(/(?:前|写|创作|生成|连续|来|要)?\s*([一二三四五六七八九十百千万两]{1,8})\s*(?:个)?(?:章|章节)/)
  if (!chinese) return null

  return parseChineseInteger(chinese[1])
}

function parseChineseInteger(input: string): number | null {
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9
  }
  const units: Record<string, number> = {
    十: 10,
    百: 100,
    千: 1000
  }
  if (!/^[零〇一二两三四五六七八九十百千万]+$/.test(input)) return null

  let total = 0
  let section = 0
  let number = 0
  for (const char of input) {
    if (digits[char] !== undefined) {
      number = digits[char]
      continue
    }
    if (units[char] !== undefined) {
      section += (number || 1) * units[char]
      number = 0
      continue
    }
    if (char === '万') {
      total += (section + number) * 10000
      section = 0
      number = 0
      continue
    }
    return null
  }

  const value = total + section + number
  return value > 0 ? value : null
}

export function getDeliveryProblem(params: {
  needsChapterDelivery: boolean
  needsOutlineDelivery: boolean
  expectedChapterWrites: number | null
  totalSuccessfulChapterWrites: number
  totalSuccessfulOutlineWrites: number
  continuousWriting?: boolean
}): string | null {
  const totalDeliveries = params.totalSuccessfulChapterWrites + params.totalSuccessfulOutlineWrites
  if (totalDeliveries === 0) return '没有任何成功写入动作'
  if (params.needsChapterDelivery && params.totalSuccessfulChapterWrites === 0) return '没有成功写入章节正文'
  if (params.needsChapterDelivery && params.continuousWriting) {
    return '用户要求持续写作，工作流必须继续下一章，直到用户手动停止'
  }
  if (params.needsChapterDelivery && params.expectedChapterWrites !== null && params.totalSuccessfulChapterWrites < params.expectedChapterWrites) {
    return `用户要求约 ${params.expectedChapterWrites} 章，但只成功写入 ${params.totalSuccessfulChapterWrites} 次章节`
  }
  if (params.needsOutlineDelivery && params.totalSuccessfulOutlineWrites === 0) return '没有成功写入大纲/细纲'
  return null
}

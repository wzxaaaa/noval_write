import { agentConfigRepo } from '../../db/repositories/agent-config.repo'
import { chapterRepo } from '../../db/repositories/chapter.repo'
import { conversationRepo } from '../../db/repositories/conversation.repo'
import { AgentRuntime, type AgentRunResult } from './agent-runtime'
import { AgentContextManager } from './context-manager'
import { assessAgentOutput, inspectChinesePunctuation, validateChapterDraft } from './quality-monitor'
import { MessageBus } from './message-bus'
import { ToolRegistry, toolFail, toolOk } from './tool-registry'

export type CollaborationMode = 'round_robin' | 'moderator'

const MAX_WORKER_CALLS_PER_MODERATOR_TURN = 2
const MAX_CONSECUTIVE_WORKER_TIMEOUTS = 2
const WORKER_MAX_TOKENS_CAP = 6000
const WORKER_FIRST_TOKEN_TIMEOUT_MS = 180_000
const WORKER_STREAM_IDLE_TIMEOUT_MS = 120_000

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
    let workerCallAttemptsThisTurn = 0
    let workerAgentIdsAttemptedThisTurn = new Set<string>()
    let consecutiveWorkerTimeouts = 0
    let totalWorkerCalls = 0
    let totalSuccessfulChapterWrites = 0
    let totalSuccessfulOutlineWrites = 0
    const expectedChapterWrites = estimateRequestedChapterCount(inputContext)
    const needsChapterDelivery = shouldRequireChapterDelivery(inputContext)
    const needsOutlineDelivery = shouldRequireOutlineDelivery(inputContext)

    // Register call_agent tool for the moderator
    moderatorToolRegistry.registerTool({
      name: 'call_agent',
      description: `调用其他 Agent 执行子任务。可用的 Agent: ${workers.map((w: any) => `${w.name}(${w.role})`).join(', ')}`,
      execute: async (input: string) => {
        if (signal.aborted) throw new WorkflowAbortError()

        // Parse: agent_id:\n<agent_id>\nprompt:\n<prompt>
        const agentMatch = input.match(/agent_id:\s*(\S+)/)
        const promptMatch = input.match(/prompt:\s*([\s\S]*)/)
        if (!agentMatch || !promptMatch) return toolFail('格式错误，请使用: agent_id: <id>\\nprompt: <内容>')

        const targetAgentId = agentMatch[1]
        const prompt = promptMatch[1].trim()
        const targetAgent = workers.find((m: any) =>
          m.agent_id === targetAgentId ||
          m.name === targetAgentId ||
          m.role === targetAgentId
        )
        if (!targetAgent) return toolFail(`未找到可调用的工作 Agent: ${targetAgentId}。可用: ${workers.map((w: any) => `${w.agent_id}(${w.name})`).join(', ')}。主编不能调用自己。`)

        if (workerAgentIdsAttemptedThisTurn.has(targetAgent.agent_id)) {
          return toolFail(`本轮已经调用过「${targetAgent.name}」。如果该 Agent 超时或交付失败，请改调其他工作 Agent，不要在同一轮重复等待同一个成员。`)
        }

        if (workerCallAttemptsThisTurn >= MAX_WORKER_CALLS_PER_MODERATOR_TURN) {
          return toolFail(`本轮最多只能调用 ${MAX_WORKER_CALLS_PER_MODERATOR_TURN} 个不同工作 Agent。请先整合已获得结果；若仍缺材料，下一轮再继续调度。`)
        }

        workerCallAttemptsThisTurn++
        workerAgentIdsAttemptedThisTurn.add(targetAgent.agent_id)
        callbacks.onAgentStart(targetAgent.agent_id, targetAgent.name)
        try {
          const result = await workerRuntime.execute(
            prepareWorkerAgentForRuntime(targetAgent) as any,
            [{ role: 'user', content: prompt }],
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
              return toolFail(
                buildWorkerTimeoutStopMessage(consecutiveWorkerTimeouts),
                { abortAgentRun: true, reason: 'worker_timeout' }
              )
            }
          } else {
            consecutiveWorkerTimeouts = 0
          }
          return toolFail(`调用 ${targetAgent.name} 失败: ${message}`)
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
    const maxRounds = 30
    const initialChapterCount = chapterRepo.listByProject(projectId).length
    let lastCompletedChapterCount = initialChapterCount
    let consecutiveCompleteWithoutNewChapters = 0

    let conversationMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      {
        role: 'user',
        content: `你是主编 Agent。你的团队有: ${workers.map((w: any) => `- ${w.name} (${w.role}, ID: ${w.agent_id})`).join('\n')}\n\n任务: ${inputContext}\n\n你的职责是调度、审核、整合，不是绕过团队自己完成正文。请先分析任务，然后必须使用 [TOOL:call_agent] agent_id: <agent_id>\nprompt: <你的指令>\n[/TOOL] 调用工作 Agent。每轮最多调用 ${MAX_WORKER_CALLS_PER_MODERATOR_TURN} 个工作 Agent；写章节时优先调用 1 个主笔 Agent 拿完整正文，再按需补调规则/线索/氛围。拿到工作 Agent 结果后，再审核、整合并使用章节工具入库。完成后输出 [WORKFLOW_COMPLETE] 并附上总结。`
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
当用户要求连续创作多章时，按章节顺序循环：规划当前章、调用工作 Agent、核查并审核当前章、创建或写入该章，然后自动继续下一章。单章通过即刻入库，不要等全部章节完成后再统一入库。全部章节都创建或写入后，才输出 [WORKFLOW_COMPLETE]。

重要：
1. 你必须先使用 call_agent 调用至少一个工作 Agent，拿到该章正文/方案后，才允许创建或写入章节。
2. 每轮最多调用 ${MAX_WORKER_CALLS_PER_MODERATOR_TURN} 个工作 Agent。默认先调 1 个主笔 Agent 交付完整正文；只有缺规则、线索或氛围时，才补调第 2 个。
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
        workerCallAttemptsThisTurn = 0
        workerAgentIdsAttemptedThisTurn = new Set<string>()
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
          const message = buildWorkerTimeoutStopMessage(consecutiveWorkerTimeouts)
          callbacks.onAgentThinking(moderator.agent_id, `[运行保护] ${message}`)
          callbacks.onError(new Error(message))
          return
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
      }

      if (result.content.includes('[WORKFLOW_COMPLETE]')) {
        const deliveryProblem = getDeliveryProblem({
          needsChapterDelivery,
          needsOutlineDelivery,
          expectedChapterWrites,
          totalSuccessfulChapterWrites,
          totalSuccessfulOutlineWrites
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

请立即调用工作 Agent，然后创建/写入缺失章节。不要再次输出 [WORKFLOW_COMPLETE]，直到所有章节都通过工具调用成功入库。`
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
            content: `以下是工具执行结果:\n${toolSummary}\n\n请继续。每轮最多调用 ${MAX_WORKER_CALLS_PER_MODERATOR_TURN} 个工作 Agent，优先整合已拿到的结果。若 call_agent 提示“未交付可用结果”，必须重新调用该 Agent 或改调其他 Agent，并明确要求交付完整章节正文/可执行方案，不能等待确认。若章节写入工具被拦截，说明你还没有为该章成功调用工作 Agent，必须先调用 call_agent。需要更多工作时继续调用工作 Agent；任务完成且章节已实际入库后，才能输出 [WORKFLOW_COMPLETE]。`
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

function buildWorkerTimeoutStopMessage(count: number): string {
  return `连续 ${count} 个不同工作 Agent 在首 token/输出阶段无响应，已停止本轮工作流。请稍后重试、降低任务规模，或切换到响应更稳定的模型/API。`
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

export function shouldRequireChapterDelivery(input: string): boolean {
  return /(正文|章节|第.{1,6}章|写.{0,6}章|续写|下一章|下一场|入库|放入正文)/.test(input)
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
  if (input === '十') return 10
  const tenMatch = input.match(/^([一二三四五六七八九两])?十([一二三四五六七八九])?$/)
  if (tenMatch) {
    return (tenMatch[1] ? digits[tenMatch[1]] : 1) * 10 + (tenMatch[2] ? digits[tenMatch[2]] : 0)
  }
  if (input.length === 1 && digits[input] !== undefined) return digits[input]
  return null
}

export function getDeliveryProblem(params: {
  needsChapterDelivery: boolean
  needsOutlineDelivery: boolean
  expectedChapterWrites: number | null
  totalSuccessfulChapterWrites: number
  totalSuccessfulOutlineWrites: number
}): string | null {
  const totalDeliveries = params.totalSuccessfulChapterWrites + params.totalSuccessfulOutlineWrites
  if (totalDeliveries === 0) return '没有任何成功写入动作'
  if (params.needsChapterDelivery && params.totalSuccessfulChapterWrites === 0) return '没有成功写入章节正文'
  if (params.needsChapterDelivery && params.expectedChapterWrites !== null && params.totalSuccessfulChapterWrites < params.expectedChapterWrites) {
    return `用户要求约 ${params.expectedChapterWrites} 章，但只成功写入 ${params.totalSuccessfulChapterWrites} 次章节`
  }
  if (params.needsOutlineDelivery && params.totalSuccessfulOutlineWrites === 0) return '没有成功写入大纲/细纲'
  return null
}

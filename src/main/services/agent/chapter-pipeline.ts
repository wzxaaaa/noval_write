import type { AgentConfigRow } from '../../db/repositories/agent-config.repo'
import { chapterRepo, type ChapterRow } from '../../db/repositories/chapter.repo'
import { conversationRepo } from '../../db/repositories/conversation.repo'
import { novelMemoryRepo, type NovelMemoryRow, type NovelMemoryType } from '../../db/repositories/novel-memory.repo'
import { outlineRepo } from '../../db/repositories/outline.repo'
import { projectRepo } from '../../db/repositories/project.repo'
import { retrieverService } from '../knowledge/retriever'
import { AgentRuntime, buildAntiAiFlavorRules, type AgentRunResult, type ToolCall } from './agent-runtime'
import { assessAgentOutput, formatAiFlavorReport, inspectAiFlavor, validateChapterDraft } from './quality-monitor'
import { ToolRegistry } from './tool-registry'
import { listSkillDocsForTarget } from '../skills/skill-docs'
import { normalizeAssistantContent } from '../../../shared/chatMessages'
import { cleanDraftText, extractJsonObject } from '../../../shared/novelEditPlan'
import { countContentChars, htmlToPlainText } from '../../../shared/textMetrics'
import { CHAPTER_MAX_RATIO, chapterCharBudget, classifyChapterWriteTarget } from '../../../shared/chapterTarget'

export type ChapterPipelineRole =
  | 'plot_planner'
  | 'continuity'
  | 'character'
  | 'worldbuilding'
  | 'scene_architect'
  | 'draft_writer'
  | 'style_editor'
  | 'critic'
  | 'revision_integrator'

export const CHAPTER_PIPELINE_ROLES: ChapterPipelineRole[] = [
  'plot_planner',
  'continuity',
  'character',
  'worldbuilding',
  'scene_architect',
  'draft_writer',
  'style_editor',
  'critic',
  'revision_integrator'
]

export interface ChapterTaskPackage {
  novel_id: string
  chapter_index: number
  chapter_goal: string
  user_directive: string
  target_words: number
  pov: string
  must_include: string[]
  must_avoid: string[]
  chapter_id?: string | null
  is_revision: boolean
  single_chapter_only: boolean
}

export interface MemoryPatch {
  chapter_summary: string
  timeline_events: MemoryPatchItem[]
  character_updates: MemoryPatchItem[]
  foreshadowing_updates: MemoryPatchItem[]
  new_facts: MemoryPatchItem[]
  style_notes: string[]
  next_chapter_seed?: string
  chapter_end_state?: string
}

export interface MemoryPatchItem {
  subject: string
  content: string
  status?: string
  metadata?: Record<string, unknown>
}

export interface RetrievedMemoryBundle {
  storyBible: NovelMemoryRow[]
  styleGuide: NovelMemoryRow[]
  timeline: NovelMemoryRow[]
  characterCards: NovelMemoryRow[]
  foreshadowingLedger: NovelMemoryRow[]
  semanticMemories: NovelMemoryRow[]
  relevantMemories: NovelMemoryRow[]
  recentChapters: ChapterRow[]
  targetChapter: ChapterRow | null
  previousChapter: ChapterRow | null
  outlines: Array<{ type: string; title: string; content: string }>
  knowledgeContext: string
}

export interface ChapterPipelineFinalOutput {
  chapter_title: string
  chapter_text: string
  chapter_summary: string
  memory_patch: MemoryPatch
}

export interface ChapterPipelineCallbacks {
  onAgentStart: (agentId: string, agentName: string) => void
  onAgentToken: (agentId: string, token: string) => void
  onAgentThinking: (agentId: string, thinking: string) => void
  onAgentComplete: (agentId: string, result: AgentRunResult) => void
  onRoundComplete: (round: number) => void
  onWorkflowComplete: (summary: string) => void
  onChapterWrite: (chapterId: string, oldContent: string, newContent: string) => void
  onChapterCreate: (chapter: ChapterRow) => void
  onError: (error: Error) => void
}

export type PipelineMember = AgentConfigRow & {
  group_id?: string
  agent_id?: string
  turn_order?: number
  can_initiate?: number
  is_moderator?: number
  routing_rules?: string
}
export type PipelineAssignments = Record<ChapterPipelineRole, PipelineMember>

const DEFAULT_PIPELINE_TARGET_WORDS = 3500
const MIN_PIPELINE_TARGET_WORDS = 300
const MAX_PIPELINE_TARGET_WORDS = 20000
const MIN_FINAL_CHAPTER_RATIO = 0.45

/** 单个流水线步骤的最大尝试次数（首次 + 重试）。 */
const PIPELINE_STEP_MAX_ATTEMPTS = 3
/** 重试前的等待时间。 */
const PIPELINE_RETRY_BACKOFF_MS = 3000

/**
 * 判断某个 Agent 步骤的错误是否值得自动重试。命中超时/卡流/网络/限流/退化类的
 * 瞬时错误返回 true；配置错误、篇幅不足等确定性问题不重试。
 */
export function isRetryablePipelineError(message: string): boolean {
  if (/不是合法\s*JSON|篇幅不足|质量检查未通过|目标章节不属于/.test(message)) return false
  return /没有继续输出|没有输出|输出超过|重复退化|超时|timed?\s*out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed|Connection|terminated|aborted|stream|过载|overloaded|rate.?limit|限流|429|50[0234]/i.test(message)
}

const ROLE_LABELS: Record<ChapterPipelineRole, string> = {
  plot_planner: 'Plot Planner Agent',
  continuity: 'Continuity Agent',
  character: 'Character Agent',
  worldbuilding: 'Worldbuilding / Research Agent',
  scene_architect: 'Scene Architect Agent',
  draft_writer: 'Draft Writer Agent',
  style_editor: 'Style Editor Agent',
  critic: 'Critic Agent',
  revision_integrator: 'Revision Integrator Agent'
}

const ROLE_KEYWORDS: Record<ChapterPipelineRole, string[]> = {
  plot_planner: ['plot_planner', 'planner', 'plot', 'planning', '剧情', '情节', '规划', '策划', '大纲'],
  continuity: ['continuity', 'fact', 'timeline', '一致性', '连续性', '设定', '时间线', '校对', '审校'],
  character: ['character', '人物', '角色', '动机', '关系', '对白', '性格'],
  worldbuilding: ['worldbuilding', 'research', 'world', '世界观', '设定', '资料', '研究', '背景', '规则'],
  scene_architect: ['scene_architect', 'scene', 'architect', '场景', '分场', '分镜', '场面', '结构'],
  draft_writer: ['draft_writer', 'writer', 'draft', '主笔', '作者', '写手', '正文', '起草', '创作'],
  style_editor: ['style_editor', 'editor', 'style', '润色', '编辑', '文风', '风格', '节奏'],
  critic: ['critic', 'review', 'quality', '质检', '批评', '审稿', '挑错', '检查'],
  revision_integrator: ['revision_integrator', 'revision', 'integrator', '主编', '整合', '修订', '定稿', '总编']
}

const ROLE_FALLBACKS: Record<ChapterPipelineRole, ChapterPipelineRole[]> = {
  plot_planner: [],
  continuity: ['plot_planner'],
  character: ['continuity', 'plot_planner'],
  worldbuilding: ['continuity', 'plot_planner'],
  scene_architect: ['plot_planner', 'worldbuilding'],
  draft_writer: ['scene_architect', 'plot_planner'],
  style_editor: ['draft_writer'],
  critic: ['continuity', 'style_editor'],
  revision_integrator: ['style_editor', 'critic', 'draft_writer']
}

export class ChapterPipelineRunner {
  private readonly runtime: AgentRuntime
  private readonly toolRegistry: ToolRegistry
  private conversationId: string | null = null
  private injectedDirectiveTrail: string[] = []

  constructor(
    private readonly projectId: string,
    private readonly callbacks: ChapterPipelineCallbacks,
    private readonly signal: AbortSignal,
    private readonly injectedMessages: string[],
    private readonly currentChapterId: string | null = null
  ) {
    this.toolRegistry = new ToolRegistry(projectId, callbacks.onChapterWrite, callbacks.onChapterCreate)
    this.runtime = new AgentRuntime(this.toolRegistry)
  }

  async run(inputContext: string, members: PipelineMember[]): Promise<void> {
    this.throwIfAborted()
    const chapters = chapterRepo.listByProject(this.projectId)
    const currentChapterIndex = this.currentChapterId
      ? chapters.findIndex(chapter => chapter.id === this.currentChapterId)
      : -1
    const task = parseChapterTaskPackage(inputContext, {
      projectId: this.projectId,
      nextChapterIndex: chapters.length + 1,
      currentChapterId: currentChapterIndex >= 0 ? this.currentChapterId : null,
      currentChapterIndex: currentChapterIndex >= 0 ? currentChapterIndex + 1 : null,
      defaultTargetWords: projectRepo.getChapterWordTarget(this.projectId)
    })
    if (task.chapter_id) {
      const explicitTargetIndex = chapters.findIndex(chapter => chapter.id === task.chapter_id)
      if (explicitTargetIndex < 0) {
        throw new Error('目标章节不属于当前项目或已被删除')
      }
      task.chapter_index = explicitTargetIndex + 1
      task.is_revision = true
    }
    const assignments = resolvePipelineAssignments(members)
    const memory = await retrieveChapterMemory(this.projectId, task)
    this.throwIfAborted()

    this.callbacks.onAgentThinking(
      'chapter_orchestrator',
      `[Memory Retriever] 已读取 Story Bible、Timeline、角色卡、伏笔账本、章节摘要和相关知识库片段。`
    )

    const planner = await this.runStructuredStep('plot_planner', assignments.plot_planner, buildPlannerPrompt(task, memory))
    this.callbacks.onRoundComplete(0)

    const continuity = await this.runStructuredStep('continuity', assignments.continuity, buildContinuityPrompt(task, memory, planner))
    this.callbacks.onRoundComplete(1)

    const character = await this.runStructuredStep('character', assignments.character, buildCharacterPrompt(task, memory, planner, continuity))
    this.callbacks.onRoundComplete(2)

    const worldbuilding = await this.runStructuredStep('worldbuilding', assignments.worldbuilding, buildWorldbuildingPrompt(task, memory, planner, continuity))
    this.callbacks.onRoundComplete(3)

    const scenes = await this.runStructuredStep(
      'scene_architect',
      assignments.scene_architect,
      buildSceneArchitectPrompt(task, memory, { planner, continuity, character, worldbuilding })
    )
    this.callbacks.onRoundComplete(4)

    const draft = await this.runTextStep(
      'draft_writer',
      assignments.draft_writer,
      buildDraftWriterPrompt(task, memory, { planner, continuity, character, worldbuilding, scenes })
    )
    this.callbacks.onRoundComplete(5)

    const edited = await this.runTextStep(
      'style_editor',
      assignments.style_editor,
      buildStyleEditorPrompt(task, memory, draft)
    )
    this.callbacks.onRoundComplete(6)

    const styleReport = formatAiFlavorReport(inspectAiFlavor(edited))
    if (styleReport) {
      this.callbacks.onAgentThinking('chapter_orchestrator', `[AI 腔检测] 已在修订前标记润色稿中的 AI 腔特征，交由审稿与整合环节消除。`)
    }

    const critic = await this.runStructuredStep(
      'critic',
      assignments.critic,
      buildCriticPrompt(task, memory, { planner, continuity, character, worldbuilding, scenes, edited }, styleReport)
    )
    this.callbacks.onRoundComplete(7)

    const revisionRaw = await this.runTextStep(
      'revision_integrator',
      assignments.revision_integrator,
      buildRevisionIntegratorPrompt(task, memory, { planner, continuity, character, worldbuilding, scenes, edited, critic }, styleReport)
    )
    this.callbacks.onRoundComplete(8)

    this.throwIfAborted()
    let finalOutput = normalizeFinalOutput(revisionRaw, edited, task, readString(planner, ['chapter_title', 'chapterTitle', 'title']))
    this.throwIfAborted()
    finalOutput = await this.enforceChapterLengthBudget(task, finalOutput, assignments.style_editor)
    this.throwIfAborted()
    const writeCall = await this.writeFinalChapter(task, finalOutput, memory.targetChapter)
    this.throwIfAborted()
    const chapterId = readChapterIdFromToolData(writeCall.data) ?? memory.targetChapter?.id ?? null
    const memoryCalls = this.applyMemoryPatch(task, finalOutput, chapterId)
    this.throwIfAborted()

    const curatorContent = JSON.stringify({
      chapter_text: finalOutput.chapter_text,
      chapter_summary: finalOutput.chapter_summary,
      memory_patch: finalOutput.memory_patch
    }, null, 2)

    const curatorResult: AgentRunResult = {
      agentId: 'memory_curator',
      content: curatorContent,
      toolCalls: [writeCall, ...memoryCalls],
      quality: assessAgentOutput(curatorContent, [writeCall, ...memoryCalls])
    }

    this.callbacks.onAgentStart('memory_curator', 'Memory Curator')
    this.callbacks.onAgentComplete('memory_curator', curatorResult)
    this.callbacks.onWorkflowComplete(
      `单章协作流水线完成：第 ${task.chapter_index} 章已${writeCall.tool === 'write_chapter' ? '更新' : '生成'}，并回写 ${memoryCalls.length} 条记忆。`
    )
  }

  private async runStructuredStep(
    role: ChapterPipelineRole,
    member: PipelineMember,
    prompt: string
  ): Promise<Record<string, unknown>> {
    const result = await this.runAgentStep(role, member, prompt)
    this.throwIfAborted()
    const parsed = extractJsonObject(result.content)
    if (isRecord(parsed)) return parsed

    this.callbacks.onAgentThinking(getPipelineAgentId(member), `[结构化输出修复] ${ROLE_LABELS[role]} 未返回合法 JSON，已将原文作为 raw 字段继续。`)
    return { raw: result.content.trim() }
  }

  private async runTextStep(
    role: ChapterPipelineRole,
    member: PipelineMember,
    prompt: string
  ): Promise<string> {
    const result = await this.runAgentStep(role, member, prompt)
    this.throwIfAborted()
    return result.content.trim()
  }

  private async runAgentStep(
    role: ChapterPipelineRole,
    member: PipelineMember,
    prompt: string
  ): Promise<AgentRunResult> {
    this.throwIfAborted()
    const directivePrompt = this.drainInjectedDirectives()
    const messages = [{ role: 'user' as const, content: directivePrompt ? `${prompt}\n\n${directivePrompt}` : prompt }]
    const agent = preparePipelineAgentForRuntime(member, role)

    const agentId = getPipelineAgentId(member)
    this.callbacks.onAgentStart(agentId, `${ROLE_LABELS[role]} · ${member.name}`)

    let lastError: unknown
    for (let attempt = 1; attempt <= PIPELINE_STEP_MAX_ATTEMPTS; attempt++) {
      this.throwIfAborted()
      try {
        const result = await this.runtime.execute(
          agent,
          messages,
          (token) => this.callbacks.onAgentToken(agentId, token),
          (thinking) => this.callbacks.onAgentThinking(agentId, thinking),
          this.signal
        )
        this.throwIfAborted()

        if (result.quality.issues.length > 0) {
          this.callbacks.onAgentThinking(agentId, `[质量监控] ${result.quality.issues.join('；')}`)
        }

        this.callbacks.onAgentComplete(agentId, result)
        this.recordConversation(agentId, result.content)
        return result
      } catch (err) {
        if (this.signal.aborted) throw new Error('工作流已被用户停止')
        lastError = err
        const message = err instanceof Error ? err.message : String(err)
        if (attempt >= PIPELINE_STEP_MAX_ATTEMPTS || !isRetryablePipelineError(message)) {
          throw err
        }
        this.callbacks.onAgentThinking(
          agentId,
          `[自动重试] ${ROLE_LABELS[role]} 第 ${attempt} 次调用失败：${message}。${Math.round(PIPELINE_RETRY_BACKOFF_MS / 1000)} 秒后重试（第 ${attempt + 1}/${PIPELINE_STEP_MAX_ATTEMPTS} 次）。`
        )
        await this.delay(PIPELINE_RETRY_BACKOFF_MS)
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  /** 可被工作流中止打断的等待。 */
  private delay(ms: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.signal.aborted) {
        reject(new Error('工作流已被用户停止'))
        return
      }
      const onAbort = () => {
        clearTimeout(timer)
        reject(new Error('工作流已被用户停止'))
      }
      const timer = setTimeout(() => {
        this.signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      this.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private async writeFinalChapter(
    task: ChapterTaskPackage,
    finalOutput: ChapterPipelineFinalOutput,
    targetChapter: ChapterRow | null
  ): Promise<ToolCall> {
    this.throwIfAborted()
    const chapterText = cleanDraftText(finalOutput.chapter_text)
    const validation = validateChapterDraft(chapterText)
    if (!validation.ok) {
      throw new Error(`最终章节正文未通过质量检查：${validation.reason}`)
    }

    const actualChars = countContentChars(chapterText)
    const minimumChars = Math.max(80, Math.floor(task.target_words * MIN_FINAL_CHAPTER_RATIO))
    if (actualChars < minimumChars) {
      throw new Error(`最终章节篇幅不足：当前约 ${actualChars} 字，目标约 ${task.target_words} 字，至少应达到 ${minimumChars} 字。`)
    }

    const shouldUpdate = !!targetChapter
    const tool = shouldUpdate ? 'write_chapter' : 'create_chapter'
    const input = shouldUpdate
      ? `title: ${ensureNumberedChapterTitle(targetChapter!.title || finalOutput.chapter_title, task.chapter_index)}\nchapter_id: ${targetChapter!.id}\ncontent:\n${chapterText}`
      : `title: ${composeCreatedChapterTitle(finalOutput.chapter_title, task.chapter_index)}\ncontent:\n${chapterText}`

    const output = await this.toolRegistry.execute(tool, input)
    this.throwIfAborted()
    const call: ToolCall = {
      tool,
      input,
      output: output.message,
      ok: output.ok,
      data: output.data,
      uiEffects: output.uiEffects
    }
    if (!output.ok) throw new Error(output.message)
    return call
  }

  /** 超过上限字数时跑一次压缩重写；压缩失败或结果不达标则保留原稿。 */
  private async enforceChapterLengthBudget(
    task: ChapterTaskPackage,
    finalOutput: ChapterPipelineFinalOutput,
    member: PipelineMember
  ): Promise<ChapterPipelineFinalOutput> {
    const budget = chapterCharBudget(task.target_words)
    const currentText = cleanDraftText(finalOutput.chapter_text)
    const chars = countContentChars(currentText)
    if (chars <= budget.max) return finalOutput

    this.callbacks.onAgentThinking(
      'chapter_orchestrator',
      `[字数控制] 本章约 ${chars} 字，超过上限 ${budget.max} 字（目标 ${task.target_words} 字），启动压缩重写。`
    )

    const compressedRaw = await this.runTextStep('style_editor', member, buildCompressionPrompt(task, currentText, budget.max))
    this.throwIfAborted()
    const compressedText = cleanDraftText(extractBodySection(compressedRaw) || compressedRaw)
    const compressedChars = countContentChars(compressedText)

    if (compressedText && compressedChars >= budget.min && compressedChars < chars) {
      this.callbacks.onAgentThinking(
        'chapter_orchestrator',
        compressedChars > budget.max
          ? `[字数控制] 压缩后约 ${compressedChars} 字，仍略高于上限，按现状交付。`
          : `[字数控制] 压缩完成，约 ${compressedChars} 字。`
      )
      return { ...finalOutput, chapter_text: compressedText }
    }

    this.callbacks.onAgentThinking('chapter_orchestrator', `[字数控制] 压缩结果不达标，保留原稿交付。`)
    return finalOutput
  }

  private applyMemoryPatch(
    task: ChapterTaskPackage,
    finalOutput: ChapterPipelineFinalOutput,
    chapterId: string | null
  ): ToolCall[] {
    this.throwIfAborted()
    const patch = finalOutput.memory_patch
    const calls: ToolCall[] = []
    const addCall = (input: string, rows: NovelMemoryRow[]) => {
      calls.push({
        tool: 'apply_memory_patch',
        input,
        output: `已回写 ${rows.length} 条记忆`,
        ok: true,
        data: rows
      })
    }

    const baseMeta = {
      chapter_index: task.chapter_index,
      chapter_goal: task.chapter_goal
    }

    const summaryRows = [
      novelMemoryRepo.upsertBySubject({
        project_id: this.projectId,
        memory_type: 'chapter_summary',
        subject: `Chapter ${task.chapter_index}`,
        content: patch.chapter_summary || finalOutput.chapter_summary,
        metadata: { ...baseMeta, kind: 'chapter_summary' },
        source_chapter_id: chapterId
      })
    ]
    addCall('chapter_summary', summaryRows)

    const timelineRows = patch.timeline_events.map(item => novelMemoryRepo.create({
      project_id: this.projectId,
      memory_type: 'timeline_event',
      subject: item.subject || `Chapter ${task.chapter_index}`,
      content: item.content,
      metadata: { ...baseMeta, ...(item.metadata ?? {}) },
      status: item.status ?? 'active',
      source_chapter_id: chapterId
    }))
    if (timelineRows.length > 0) addCall('timeline_events', timelineRows)

    const characterRows = patch.character_updates.map(item => novelMemoryRepo.mergeBySubject({
      project_id: this.projectId,
      memory_type: 'character_card',
      subject: item.subject,
      content: item.content,
      metadata: { ...baseMeta, ...(item.metadata ?? {}) },
      status: item.status ?? 'active',
      source_chapter_id: chapterId
    }))
    if (characterRows.length > 0) addCall('character_updates', characterRows)

    const foreshadowingRows = patch.foreshadowing_updates.map(item => novelMemoryRepo.upsertBySubject({
      project_id: this.projectId,
      memory_type: 'foreshadowing',
      subject: item.subject,
      content: item.content,
      metadata: { ...baseMeta, ...(item.metadata ?? {}) },
      status: item.status ?? 'active',
      source_chapter_id: chapterId
    }))
    if (foreshadowingRows.length > 0) addCall('foreshadowing_updates', foreshadowingRows)

    const factRows = patch.new_facts.map(item => {
      const memoryType = normalizeFactMemoryType(item.metadata?.memory_type)
      const write = ['story_bible', 'style_guide', 'world_rule', 'user_preference'].includes(memoryType)
        ? novelMemoryRepo.mergeBySubject.bind(novelMemoryRepo)
        : novelMemoryRepo.create.bind(novelMemoryRepo)
      return write({
        project_id: this.projectId,
        memory_type: memoryType,
        subject: item.subject,
        content: item.content,
        metadata: { ...baseMeta, ...(item.metadata ?? {}) },
        status: item.status ?? 'active',
        source_chapter_id: chapterId
      })
    })
    if (factRows.length > 0) addCall('new_facts', factRows)

    const styleRows = patch.style_notes.map((note, index) => novelMemoryRepo.create({
      project_id: this.projectId,
      memory_type: 'style_guide',
      subject: `Chapter ${task.chapter_index} style note ${index + 1}`,
      content: note,
      metadata: { ...baseMeta, kind: 'style_note' },
      source_chapter_id: chapterId
    }))
    if (styleRows.length > 0) addCall('style_notes', styleRows)

    if (patch.next_chapter_seed) {
      const seed = novelMemoryRepo.upsertBySubject({
        project_id: this.projectId,
        memory_type: 'semantic_note',
        subject: `Next after Chapter ${task.chapter_index}`,
        content: patch.next_chapter_seed,
        metadata: { ...baseMeta, kind: 'next_chapter_seed' },
        source_chapter_id: chapterId
      })
      addCall('next_chapter_seed', [seed])
    }

    if (patch.chapter_end_state) {
      const endState = novelMemoryRepo.upsertBySubject({
        project_id: this.projectId,
        memory_type: 'semantic_note',
        subject: `第${task.chapter_index}章 章末状态`,
        content: patch.chapter_end_state,
        metadata: { ...baseMeta, kind: 'chapter_end_state' },
        source_chapter_id: chapterId
      })
      addCall('chapter_end_state', [endState])
    }

    return calls
  }

  private drainInjectedDirectives(): string {
    const drained: string[] = []
    while (this.injectedMessages.length > 0) {
      const message = this.injectedMessages.shift()!
      drained.push(message)
      this.injectedDirectiveTrail.push(message)
      this.callbacks.onAgentThinking('chapter_orchestrator', `[用户注入指令] ${message}`)
    }

    if (drained.length === 0) return ''
    return [
      '【运行中用户新指令】',
      '以下指令优先级高于既有大纲，但仍必须经过连续性检查，只影响当前章节后续步骤：',
      ...drained.map((message, index) => `${index + 1}. ${message}`)
    ].join('\n')
  }

  private recordConversation(agentId: string, content: string): void {
    if (!this.conversationId) {
      this.conversationId = conversationRepo.create(this.projectId).id
    }
    const safeContent = normalizeAssistantContent(content)
    if (safeContent) {
      conversationRepo.addMessage(this.conversationId, 'assistant', safeContent, agentId)
    }
  }

  private throwIfAborted(): void {
    if (this.signal.aborted) throw new Error('工作流已被用户停止')
  }
}

export function parseChapterTaskPackage(
  input: string,
  defaults: {
    projectId: string
    nextChapterIndex: number
    currentChapterId?: string | null
    currentChapterIndex?: number | null
    defaultTargetWords?: number | null
  }
): ChapterTaskPackage {
  const parsed = extractJsonObject(input)
  const record = isRecord(parsed) ? parsed : {}
  const plainTextTarget = classifyChapterWriteTarget(input)
  const structuredChapterIndex = readNumber(record, ['chapter_index', 'chapterIndex', 'chapter', 'index'])
  const explicitChapterIndex = structuredChapterIndex ??
    (plainTextTarget.kind === 'ordinal' ? plainTextTarget.index : null)
  const explicitChapterId = readString(record, ['chapter_id', 'chapterId']) || null
  const inferredRevision = readBoolean(record, ['is_revision', 'isRevision', 'revise']) ??
    /(修改|修订|重写|润色|改写|替换|调整)/.test(input)
  const useCurrentChapter = !explicitChapterId && plainTextTarget.kind !== 'next' && explicitChapterIndex == null &&
    (inferredRevision || plainTextTarget.kind === 'current') &&
    Boolean(defaults.currentChapterId && defaults.currentChapterIndex)
  const chapterIndex = clampPositiveInt(
    explicitChapterIndex ??
      (useCurrentChapter ? defaults.currentChapterIndex! : defaults.nextChapterIndex),
    defaults.nextChapterIndex
  )

  const projectDefaultTarget = defaults.defaultTargetWords && defaults.defaultTargetWords > 0
    ? defaults.defaultTargetWords
    : DEFAULT_PIPELINE_TARGET_WORDS
  const targetWords = clampTargetWords(
    readNumber(record, ['target_words', 'targetWords', 'target_chars', 'targetChars']) ??
      estimateTargetWords(input) ??
      projectDefaultTarget
  )

  const chapterGoal = readString(record, ['chapter_goal', 'chapterGoal', 'goal', 'purpose', 'intent']) ||
    inferChapterGoal(input)
  const userDirective = readString(record, ['user_directive', 'userDirective', 'directive', 'instruction']) || input.trim()
  const pov = readString(record, ['pov', 'viewpoint', 'narrative_pov']) || inferPov(input)
  const mustInclude = readStringArray(record.must_include ?? record.mustInclude)
  const mustAvoid = readStringArray(record.must_avoid ?? record.mustAvoid)
  const chapterId = explicitChapterId || (useCurrentChapter ? defaults.currentChapterId! : null)
  const isRevision = inferredRevision || Boolean(chapterId)

  return {
    novel_id: readString(record, ['novel_id', 'novelId']) || defaults.projectId,
    chapter_index: chapterIndex,
    chapter_goal: chapterGoal,
    user_directive: userDirective,
    target_words: targetWords,
    pov,
    must_include: mustInclude,
    must_avoid: mustAvoid,
    chapter_id: chapterId,
    is_revision: isRevision,
    single_chapter_only: true
  }
}

export function resolvePipelineAssignments(members: PipelineMember[]): PipelineAssignments {
  if (members.length === 0) {
    throw new Error('Chapter Pipeline 需要至少一个 Agent 成员')
  }

  const sorted = [...members].sort((a, b) => (a.turn_order ?? 0) - (b.turn_order ?? 0))
  const roleBuckets = new Map<ChapterPipelineRole, PipelineMember[]>()
  for (const member of sorted) {
    const role = inferChapterPipelineRole(member)
    if (!role) continue
    roleBuckets.set(role, [...(roleBuckets.get(role) ?? []), member])
  }

  const assignments = {} as PipelineAssignments
  const fallbackMember = sorted.find(member => member.is_moderator === 1) ?? sorted[0]

  for (const role of CHAPTER_PIPELINE_ROLES) {
    const direct = roleBuckets.get(role)?.[0]
    if (direct) {
      assignments[role] = direct
      continue
    }

    const fallbackRole = ROLE_FALLBACKS[role].find(candidate => assignments[candidate])
    assignments[role] = fallbackRole ? assignments[fallbackRole] : fallbackMember
  }

  return assignments
}

export function inferChapterPipelineRole(member: Partial<PipelineMember>): ChapterPipelineRole | null {
  const explicit = normalizeRoleName(member.pipeline_role || readPipelineRoleFromRouting(member.routing_rules) || readPipelineRoleFromParameters(member.parameters))
  if (explicit) return explicit

  const searchable = normalizeComparable([
    member.name,
    member.role,
    member.description,
    member.system_prompt
  ].filter(Boolean).join(' '))

  let bestRole: ChapterPipelineRole | null = null
  let bestScore = 0
  for (const role of CHAPTER_PIPELINE_ROLES) {
    const score = ROLE_KEYWORDS[role].reduce((total, keyword) => {
      const normalized = normalizeComparable(keyword)
      if (!normalized || !searchable.includes(normalized)) return total
      return total + (keyword.includes('_') ? 4 : 1)
    }, 0)
    if (score > bestScore) {
      bestScore = score
      bestRole = role
    }
  }

  return bestScore > 0 ? bestRole : null
}

function getPipelineAgentId(member: PipelineMember): string {
  return member.agent_id || member.id
}

export async function retrieveChapterMemory(projectId: string, task: ChapterTaskPackage): Promise<RetrievedMemoryBundle> {
  const chapters = chapterRepo.listByProject(projectId)
  const targetChapter = task.chapter_id
    ? chapters.find(chapter => chapter.id === task.chapter_id) ?? null
    : chapters[task.chapter_index - 1] ?? null
  const targetIndex = targetChapter ? chapters.findIndex(chapter => chapter.id === targetChapter.id) : chapters.length
  const previousChapter = targetIndex > 0 ? chapters[targetIndex - 1] ?? null : null
  const query = [
    task.chapter_goal,
    task.user_directive,
    ...task.must_include,
    ...task.must_avoid
  ].join(' ')

  const outlines = outlineRepo.listByProject(projectId).map(outline => ({
    type: outline.type,
    title: outline.title,
    content: outline.content
  }))

  const [
    storyBible,
    styleGuide,
    timeline,
    characterCards,
    foreshadowingLedger,
    semanticMemories,
    relevantMemories,
    knowledgeContext
  ] = await Promise.all([
    Promise.resolve(novelMemoryRepo.listByTypes(projectId, ['story_bible', 'world_rule'], 80)),
    Promise.resolve(novelMemoryRepo.listByType(projectId, 'style_guide', 40)),
    Promise.resolve(novelMemoryRepo.listByType(projectId, 'timeline_event', 120)),
    Promise.resolve(novelMemoryRepo.listByType(projectId, 'character_card', 80)),
    Promise.resolve(novelMemoryRepo.listByType(projectId, 'foreshadowing', 80)),
    Promise.resolve(novelMemoryRepo.listByTypes(projectId, ['chapter_summary', 'semantic_note', 'user_preference'], 120)),
    Promise.resolve(novelMemoryRepo.search(projectId, query, 30)),
    retrieverService.searchContext(query, projectId, { limit: 5 })
  ])

  return {
    storyBible,
    styleGuide,
    timeline,
    characterCards,
    foreshadowingLedger,
    semanticMemories,
    relevantMemories,
    recentChapters: chapters.slice(Math.max(0, chapters.length - 3)),
    targetChapter,
    previousChapter,
    outlines,
    knowledgeContext
  }
}

function preparePipelineAgentForRuntime(agent: PipelineMember, role: ChapterPipelineRole): PipelineMember {
  let params: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(agent.parameters || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) params = parsed as Record<string, unknown>
  } catch {
    params = {}
  }

  const maxTokens = readNumberValue(params.maxTokens ?? params.max_tokens)
  const desiredMaxTokens = ['draft_writer', 'style_editor', 'revision_integrator'].includes(role) ? 9000 : 3500
  if (!maxTokens || maxTokens < desiredMaxTokens) {
    params.maxTokens = desiredMaxTokens
    params.max_tokens = desiredMaxTokens
  }

  // 提高写作类角色的采样温度，打破可预测、模板化的措辞（AI 腔的主要来源之一）。
  // 规划/审校类角色保持低温以维持连贯与判断力，因此不在此处调整。
  const temperature = readNumberValue(params.temperature)
  const temperatureFloor = role === 'draft_writer' ? 0.95 : role === 'style_editor' ? 0.85 : null
  if (temperatureFloor !== null && (temperature === null || temperature < temperatureFloor)) {
    params.temperature = temperatureFloor
  }

  // 重复惩罚可压制口头禅和词汇复读；对 OpenAI/兼容通道生效，Anthropic 通道会被静默忽略。
  if (['draft_writer', 'style_editor', 'revision_integrator'].includes(role)) {
    if (readNumberValue(params.presencePenalty ?? params.presence_penalty) === null) {
      params.presencePenalty = 0.4
      params.presence_penalty = 0.4
    }
    if (readNumberValue(params.frequencyPenalty ?? params.frequency_penalty) === null) {
      params.frequencyPenalty = 0.3
      params.frequency_penalty = 0.3
    }
  }

  params.firstTokenTimeoutMs = readNumberValue(params.firstTokenTimeoutMs ?? params.first_token_timeout_ms) ?? 180_000
  params.first_token_timeout_ms = params.firstTokenTimeoutMs
  params.streamIdleTimeoutMs = readNumberValue(params.streamIdleTimeoutMs ?? params.stream_idle_timeout_ms) ?? 120_000
  params.stream_idle_timeout_ms = params.streamIdleTimeoutMs

  // 流水线默认禁用工具（规划类 Agent 要输出纯 JSON）。唯一例外是技能子文档读取——
  // 挂载的技能带 references 时才放开，让 Agent 能取回"详见某某.md"的细节。
  const skillDocsAvailable = hasWritingTeamSkillDocs()
  const tools = skillDocsAvailable ? JSON.stringify(['read_skill_doc']) : '[]'

  return {
    ...agent,
    tools,
    parameters: JSON.stringify(params),
    system_prompt: [
      agent.system_prompt.trim(),
      buildPipelineSystemPrompt(role, skillDocsAvailable)
    ].filter(Boolean).join('\n\n')
  }
}

/** 写作团队是否挂了带子文档的技能——决定要不要给流水线开工具口子。 */
function hasWritingTeamSkillDocs(): boolean {
  try {
    return listSkillDocsForTarget('writingTeam').length > 0
  } catch {
    return false
  }
}

function buildPipelineSystemPrompt(role: ChapterPipelineRole, skillDocsAvailable = false): string {
  const toolRule = skillDocsAvailable
    ? `除 Draft Writer 与 Style Editor 可输出「## 正文」外，其余规划/检查类 Agent 必须输出合法 JSON。
唯一允许使用的工具是 [TOOL:read_skill_doc] 相对路径 [/TOOL]，用于读取已挂载技能的子文档；读完后仍然要按本角色要求输出 JSON 或正文，不要输出其他 [TOOL:...]。`
    : `除 Draft Writer 与 Style Editor 可输出「## 正文」外，其余规划/检查类 Agent 必须输出合法 JSON，不要使用工具，不要输出 [TOOL:...]。`

  return `【单章多 Agent 小说流水线】
你当前身份是 ${ROLE_LABELS[role]}。系统一次只生成或修订一章，不允许续写多章、自动进入下一章或要求用户再补一步。
所有输出都必须服务于当前章节任务包。user_directive 优先级高于既有大纲，但不得破坏已建立的连续性、人物边界和世界规则。
${toolRule}`
}

function buildPlannerPrompt(task: ChapterTaskPackage, memory: RetrievedMemoryBundle): string {
  return `${commonContext(task, memory)}

你是 Plot Planner Agent。请确定本章剧情功能，只输出 JSON：
{
  "chapter_title": "本章短标题，4-14字，概括本章看点或核心转折，不要带「第几章」编号，不要照抄正文首句",
  "opening_continuity": "本章开场如何承接【上一章结尾】：起始的时间、地点、在场人物、主角手上的物品/设备，必须与上一章结尾连续；若要转场，必须在本章内交代过渡，禁止无交代地跳回更早的场景",
  "chapter_purpose": "本章功能",
  "beats": ["剧情节拍1", "剧情节拍2"],
  "ending_hook": "章末钩子",
  "risk_notes": ["可能造成水文/重复/提前泄密的问题"]
}

要求：本章必须有明确变化，不能只是继续铺陈情绪；本章开场必须与上一章结尾无缝衔接；如用户要求多章或持续写作，只规划当前这一章。`
}

function buildContinuityPrompt(task: ChapterTaskPackage, memory: RetrievedMemoryBundle, planner: Record<string, unknown>): string {
  return `${commonContext(task, memory)}

Planner 输出：
${JSON.stringify(planner, null, 2)}

你是 Continuity Agent。只检查能不能这样写，不写正文。请重点核对本章开场与【上一章结尾】的连续性：时间是否顺承、地点是否一致（上一章若已离开某场景，本章不得无交代地又回到该场景）、在场人物是否对得上、主角手上的物品/设备是否一致。请输出 JSON：
{
  "passed": true,
  "opening_continuity_check": { "result": "pass|warn|fail", "note": "本章开场与上一章结尾在时间/地点/在场/道具上的衔接是否连续，不连续要指出具体冲突" },
  "checks": [
    { "item": "角色此时是否知道该信息", "result": "pass|warn|fail", "note": "说明" },
    { "item": "开场是否承接上一章结尾的场景与时间", "result": "pass|warn|fail", "note": "说明" }
  ],
  "required_fixes": ["必须修正的点"],
  "protected_secrets": ["本章不能提前暴露的秘密"],
  "usable_foreshadowing": ["本章可埋/可回收的伏笔"]
}`
}

function buildCharacterPrompt(
  task: ChapterTaskPackage,
  memory: RetrievedMemoryBundle,
  planner: Record<string, unknown>,
  continuity: Record<string, unknown>
): string {
  return `${commonContext(task, memory)}

Planner 输出：
${JSON.stringify(planner, null, 2)}

Continuity 输出：
${JSON.stringify(continuity, null, 2)}

你是 Character Agent。请锁定本章重要角色的外在目标、内在冲突、说话方式和行为边界。只输出 JSON：
{
  "characters": {
    "角色名": {
      "external_goal": "外在目标",
      "internal_conflict": "内在冲突",
      "speech_style": "说话方式",
      "boundary": "不能越界的行为"
    }
  },
  "relationship_changes_allowed": ["允许发生的关系变化"],
  "relationship_changes_forbidden": ["不能发生的关系变化"]
}`
}

function buildWorldbuildingPrompt(
  task: ChapterTaskPackage,
  memory: RetrievedMemoryBundle,
  planner: Record<string, unknown>,
  continuity: Record<string, unknown>
): string {
  return `${commonContext(task, memory)}

Planner 输出：
${JSON.stringify(planner, null, 2)}

Continuity 输出：
${JSON.stringify(continuity, null, 2)}

你是 Worldbuilding / Research Agent。请给出本章需要的背景细节和限制，不写正文。只输出 JSON：
{
  "setting_details": ["地点、天气、物件、组织规则等"],
  "world_rules_to_preserve": ["必须遵守的世界规则"],
  "research_notes": ["可用于增强真实感的细节"],
  "forbidden_inventions": ["不能新编的设定"]
}`
}

function buildSceneArchitectPrompt(
  task: ChapterTaskPackage,
  memory: RetrievedMemoryBundle,
  upstream: Record<string, unknown>
): string {
  return `${commonContext(task, memory)}

上游 Agent 输出：
${JSON.stringify(upstream, null, 2)}

你是 Scene Architect Agent。把本章拆成场景设计稿，只输出 JSON：
{
  "scenes": [
    {
      "location": "场景地点",
      "purpose": "场景功能",
      "conflict": "场景冲突",
      "turn": "场景转折",
      "characters": ["参与角色"]
    }
  ],
  "information_release": ["本章信息释放顺序"],
  "ending_hook": "结尾钩子"
}`
}

function buildDraftWriterPrompt(
  task: ChapterTaskPackage,
  memory: RetrievedMemoryBundle,
  upstream: Record<string, unknown>
): string {
  return `${commonContext(task, memory)}

上游 Agent 输出：
${JSON.stringify(upstream, null, 2)}

你是 Draft Writer Agent。根据场景设计写本章初稿。
输出格式：
## 正文
<只写小说正文，不要解释、不总结、不输出 JSON>

硬性要求：
- 开篇必须承接【上一章结尾】：起始的时间、地点、在场人物、主角手上的物品/设备要与上一章结尾连续；上一章若已离开某场景（如锁门离开实验室），本章不得无交代地又回到该场景。确需转场时，要在正文里交代过渡。
- 只写当前一章，目标约 ${task.target_words} 字，硬上限约 ${Math.ceil(task.target_words * CHAPTER_MAX_RATIO)} 字，不要超过上限；接近上限时优先精简描写，不要为凑字数注水。
- 视角：${task.pov}。
- 必须包含：${formatList(task.must_include)}。
- 必须避免：${formatList(task.must_avoid)}。
- 不要用摘要、梗概、提纲或工作汇报冒充正文。

${buildAntiAiFlavorRules()}`
}

function buildCompressionPrompt(task: ChapterTaskPackage, chapterText: string, maxChars: number): string {
  return `你是 Style Editor Agent，现在只做一件事：把下面这章正文压缩到 ${maxChars} 字以内（目标约 ${task.target_words} 字）。

硬性要求：
- 只删冗余描写、重复的心理/环境刻画、可有可无的过渡和注水句；必须保留全部剧情节点、关键对白、伏笔和结尾钩子。
- 不得新增情节，不得改变剧情走向、人物关系和已建立的设定。
- 保持中文全角标点和自然语感，不要为了压字数而砍掉必要停顿或写成流水账。

输出格式：
## 正文
<只输出压缩后的完整正文，不要解释、不总结、不输出 JSON>

${buildAntiAiFlavorRules()}

待压缩正文：
${chapterText}`
}

function buildStyleEditorPrompt(task: ChapterTaskPackage, memory: RetrievedMemoryBundle, draft: string): string {
  return `${commonContext(task, memory)}

下面是 Draft Writer 初稿：
${draft}

你是 Style Editor Agent。你的首要任务是消除"AI 腔"，其次才是删水和顺节奏。删水的同时要保留人物口语、个性化语感和真实的粗糙感，不要把每句都磨成一样平滑工整的"范文腔"。
输出格式：
## 正文
<只输出修订后的小说正文，不要解释、不总结、不输出 JSON>

特别处理：
- 删除重复心理描写和重复环境描写。
- 增强对白张力，保持视角稳定，不要提前解释全部真相。
- 保留本章核心剧情功能与结尾钩子。
- 主动改写掉一切 AI 腔句式：对偶警句、伪精确打分、术语堆砌、套路喻体、过量短句成段。

${buildAntiAiFlavorRules()}`
}

function buildCriticPrompt(
  task: ChapterTaskPackage,
  memory: RetrievedMemoryBundle,
  upstream: Record<string, unknown>,
  styleReport = ''
): string {
  return `${commonContext(task, memory)}

上游 Agent 输出与修订正文：
${JSON.stringify(upstream, null, 2)}
${styleReport ? `\n${styleReport}\n请把上述被自动标记的 AI 腔问题作为 high 优先级逐条列入 issues。\n` : ''}
你是 Critic Agent。挑问题，不负责美化。AI 腔(对偶警句、伪精确打分、术语堆砌、套路喻体、过量短句成段、说明文式解释)属于必须挑出的高优先级问题。请按清单质检，只输出 JSON：
{
  "passed": false,
  "issues": [
    {
      "type": "goal|continuity|character|foreshadowing|style|pacing|hook|length|ai_flavor",
      "severity": "high|medium|low",
      "problem": "具体问题，ai_flavor 需引用原文可疑句",
      "fix": "修正建议"
    }
  ],
  "checklist": {
    "chapter_goal": "pass|warn|fail",
    "conflict_strength": "pass|warn|fail",
    "character_consistency": "pass|warn|fail",
    "foreshadowing": "pass|warn|fail",
    "ending_hook": "pass|warn|fail",
    "ai_flavor": "pass|warn|fail"
  }
}`
}

function buildRevisionIntegratorPrompt(
  task: ChapterTaskPackage,
  memory: RetrievedMemoryBundle,
  upstream: Record<string, unknown>,
  styleReport = ''
): string {
  return `${commonContext(task, memory)}

上游 Agent 输出：
${JSON.stringify(upstream, null, 2)}
${styleReport ? `\n${styleReport}\n定稿前必须逐条消除以上被标记的 AI 腔特征。\n` : ''}
你是 Revision Integrator Agent。根据 Critic 意见生成最终版，并产出记忆更新补丁。定稿时必须消除全部 AI 腔(对偶警句、伪精确打分、术语堆砌、套路喻体、过量短句成段、说明文式解释)。

${buildAntiAiFlavorRules()}
只输出合法 JSON，格式如下：
{
  "chapter_title": "本章小标题，4-14字，概括本章看点；不要带「第几章」编号，也不要照抄正文首句",
  "chapter_text": "最终小说正文，不能包含解释、总结或 JSON 以外的包装",
  "chapter_summary": "本章摘要，说明发生了什么以及结尾钩子",
  "memory_patch": {
    "chapter_summary": "本章摘要",
    "timeline_events": [
      { "subject": "事件名", "content": "时间、地点、参与角色、因果关系", "metadata": { "time": "", "location": "", "characters": [] } }
    ],
    "character_updates": [
      { "subject": "角色名", "content": "目标、秘密、关系或成长阶段变化" }
    ],
    "foreshadowing_updates": [
      { "subject": "伏笔内容", "content": "来源章节、计划回收章节、当前状态", "status": "planted|active|revealed|resolved" }
    ],
    "new_facts": [
      { "subject": "事实主题", "content": "新增且需要长期记忆的设定/秘密/世界规则", "metadata": { "memory_type": "story_bible|world_rule|semantic_note|user_preference" } }
    ],
    "style_notes": ["用户偏好或本书稳定风格的新约束"],
    "next_chapter_seed": "下一章自然承接点",
    "chapter_end_state": "本章结尾时的定格状态：主角此刻所在地点、时间、在场人物、手上的关键物品/设备、以及刚做完的动作（供下一章无缝承接，务必与正文结尾一致）"
  }
}

硬性要求：只交付当前一章；chapter_text 目标约 ${task.target_words} 字、不得超过约 ${Math.ceil(task.target_words * CHAPTER_MAX_RATIO)} 字，超了先删冗余而不是砍情节；memory_patch 和 chapter_text 同等重要；不要让补丁记录空泛总结。`
}

function commonContext(task: ChapterTaskPackage, memory: RetrievedMemoryBundle): string {
  return `【章节任务包】
${JSON.stringify(task, null, 2)}

【结构化记忆】
Story Bible / World Rules:
${formatMemoryRows(memory.storyBible)}

Style Guide:
${formatMemoryRows(memory.styleGuide)}

Character Cards:
${formatMemoryRows(memory.characterCards)}

Timeline:
${formatMemoryRows(memory.timeline)}

Foreshadowing Ledger:
${formatMemoryRows(memory.foreshadowingLedger)}

【语义记忆】
${formatMemoryRows([...memory.semanticMemories, ...memory.relevantMemories])}

【大纲/细纲】
${memory.outlines.map(outline => `[${outline.type}] ${outline.title}\n${truncateText(outline.content, 1600)}`).join('\n\n') || '(暂无大纲/细纲)'}

【最近章节】
${memory.recentChapters.map(chapter => `${chapter.title}（${chapter.word_count}字）\n${truncateText(htmlToPlainText(chapter.content), 1200)}`).join('\n\n') || '(暂无已写章节)'}

【上一章结尾 — 本章开头必须由此自然承接】
${memory.previousChapter
  ? `${memory.previousChapter.title}\n${truncateTail(memory.previousChapter.content, 900)}\n\n（硬性要求：本章开头的时间、地点、在场人物和主角手上的物品/设备，必须与上面这段结尾连续。上一章若已离开某场景，本章不得无交代地又回到该场景。）`
  : '(无上一章，可自由设定开场)'}

【目标章节现有内容】
${memory.targetChapter ? `${memory.targetChapter.title}\n${truncateText(htmlToPlainText(memory.targetChapter.content), 2400)}` : '(无，预计创建新章节)'}

【知识库检索片段】
${memory.knowledgeContext || '(暂无相关知识库片段)'}`
}

function normalizeFinalOutput(
  revisionRaw: string,
  edited: string,
  task: ChapterTaskPackage,
  fallbackTitle = ''
): ChapterPipelineFinalOutput {
  const parsed = extractJsonObject(revisionRaw)
  const record = isRecord(parsed) ? parsed : {}
  const chapterText = cleanDraftText(readString(record, ['chapter_text', 'chapterText', 'content', 'text']) || extractBodySection(revisionRaw) || extractBodySection(edited) || edited)
  const summary = readString(record, ['chapter_summary', 'chapterSummary', 'summary']) || summarizeText(chapterText)
  const rawPatch = isRecord(record.memory_patch) ? record.memory_patch : {}

  return {
    chapter_title: readString(record, ['chapter_title', 'chapterTitle', 'title']) || fallbackTitle.trim() || inferChapterTitle(chapterText),
    chapter_text: chapterText,
    chapter_summary: summary,
    memory_patch: normalizeMemoryPatch(rawPatch, summary)
  }
}

export function normalizeMemoryPatch(raw: Record<string, unknown>, fallbackSummary: string): MemoryPatch {
  return {
    chapter_summary: readRawString(raw.chapter_summary ?? raw.chapterSummary) || fallbackSummary,
    timeline_events: readPatchItems(raw.timeline_events ?? raw.timelineEvents, ['subject', 'event', 'summary', 'title']),
    character_updates: readPatchItems(raw.character_updates ?? raw.characterUpdates, ['subject', 'name', 'character']),
    foreshadowing_updates: readPatchItems(raw.foreshadowing_updates ?? raw.foreshadowingUpdates, ['subject', 'content', 'foreshadowing']),
    new_facts: readPatchItems(raw.new_facts ?? raw.newFacts, ['subject', 'fact', 'scope']),
    style_notes: readStringArray(raw.style_notes ?? raw.styleNotes),
    next_chapter_seed: readRawString(raw.next_chapter_seed ?? raw.nextChapterSeed) || undefined,
    chapter_end_state: readRawString(raw.chapter_end_state ?? raw.chapterEndState) || undefined
  }
}

function readPatchItems(value: unknown, subjectKeys: string[]): MemoryPatchItem[] {
  const values = Array.isArray(value) ? value : value ? [value] : []
  return values.map((item, index): MemoryPatchItem | null => {
    if (typeof item === 'string') {
      return { subject: `Item ${index + 1}`, content: item.trim() }
    }
    if (!isRecord(item)) return null

    const subject = subjectKeys.map(key => readRawString(item[key])).find(Boolean) || `Item ${index + 1}`
    const content = readRawString(item.content) ||
      readRawString(item.update) ||
      readRawString(item.summary) ||
      readRawString(item.description) ||
      JSON.stringify(item)
    const status = readRawString(item.status)
    const metadata = Object.fromEntries(
      Object.entries(item).filter(([key]) => !['subject', 'name', 'character', 'content', 'update', 'summary', 'description', 'status'].includes(key))
    )

    return { subject, content, status: status || undefined, metadata }
  }).filter((item): item is MemoryPatchItem => !!item && !!item.content.trim())
}

function extractBodySection(text: string): string | null {
  const cleaned = cleanDraftText(text)
  const lines = cleaned.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const heading = normalizeHeading(lines[i])
    if (!/^(正文|正文定稿|最终正文|小说正文|章节正文|成稿|正文稿|最终稿|交付正文)$/.test(heading)) continue

    const body: string[] = []
    for (const line of lines.slice(i + 1)) {
      const normalized = normalizeHeading(line)
      if (body.length > 0 && /^(校验|核验|总结|工作总结|交付说明|最终交付|备注|修改说明|审稿意见|memory_patch)$/i.test(normalized)) break
      body.push(line)
    }
    const result = body.join('\n').trim()
    if (result) return result
  }
  return null
}

function inferChapterTitle(text: string): string {
  const firstLine = text.split('\n').map(normalizeHeading).find(Boolean)
  if (!firstLine) return ''
  if (/^第[一二三四五六七八九十百千万\d]+[章节回幕卷]/.test(firstLine)) return firstLine
  // 只有短、无句读的首行才当作标题；否则视为正文，不拿正文首句当标题。
  if (Array.from(firstLine).length <= 16 && !/[。！？，,、；;：]/.test(firstLine)) return firstLine
  return ''
}

/** 阿拉伯数字转中文章节序号（1–9999），与"第五章"这类风格保持一致。 */
export function toChineseChapterNumeral(value: number): string {
  const n = Math.floor(value)
  if (!Number.isFinite(n) || n <= 0 || n >= 10000) return String(value)
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
  const units = ['', '十', '百', '千']
  const s = String(n)
  let result = ''
  let zeroPending = false
  for (let i = 0; i < s.length; i++) {
    const digit = Number(s[i])
    const unit = s.length - 1 - i
    if (digit === 0) {
      zeroPending = true
      continue
    }
    if (zeroPending) {
      result += digits[0]
      zeroPending = false
    }
    result += digits[digit] + units[unit]
  }
  return result.replace(/^一十/, '十') || digits[0]
}

/** 为新建章节生成"第N章 小标题"格式的标题，保证有编号、不重复、不拿正文当标题。 */
export function composeCreatedChapterTitle(rawTitle: string, chapterIndex: number): string {
  const numeral = `第${toChineseChapterNumeral(chapterIndex)}章`
  const topic = extractChapterTopic(rawTitle)
  return topic ? `${numeral} ${topic}` : numeral
}

/** 修订已有章节时，若标题已带"第X章"编号则保留，否则补上编号前缀。 */
export function ensureNumberedChapterTitle(rawTitle: string, chapterIndex: number): string {
  const cleaned = normalizeHeading(rawTitle || '').trim()
  if (/^第[一二三四五六七八九十百千万\d]+[章节回幕卷]/.test(cleaned)) return cleaned
  return composeCreatedChapterTitle(cleaned, chapterIndex)
}

function extractChapterTopic(rawTitle: string): string {
  let topic = normalizeHeading(rawTitle || '').trim()
  topic = topic.replace(/^第[一二三四五六七八九十百千万\d]+[章节回幕卷][\s:：、.．\-—]*/, '').trim()
  topic = topic.replace(/^(title|标题|章节标题)\s*[:：]\s*/i, '').trim()
  const firstClause = topic.split(/[。！？，,、；;：]/)[0].trim()
  if (firstClause) topic = firstClause
  return Array.from(topic).slice(0, 18).join('').trim()
}

function summarizeText(text: string): string {
  return text.replace(/\s+/g, '').slice(0, 180)
}

function formatMemoryRows(rows: NovelMemoryRow[]): string {
  if (rows.length === 0) return '(暂无)'
  const seen = new Set<string>()
  return rows
    .filter(row => {
      const key = `${row.memory_type}:${row.subject}:${row.content.slice(0, 80)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 60)
    .map(row => `- [${row.memory_type}${row.status && row.status !== 'active' ? `/${row.status}` : ''}] ${row.subject || '(未命名)'}: ${truncateMemoryText(row.content, 900)}`)
    .join('\n')
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join('、') : '无明确要求'
}

function normalizeHeading(line: string): string {
  return line.trim().replace(/^#{1,6}\s*/, '').replace(/^\*\*|\*\*$/g, '').trim()
}

function truncateText(text: string, maxLength: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength)}...`
}

/** 保留文本结尾（用于承接上一章的收尾场景），而不是像 truncateText 那样取开头。 */
function truncateTail(text: string, maxLength: number): string {
  const cleaned = htmlToPlainText(text).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return cleaned.length <= maxLength ? cleaned : `……${cleaned.slice(-maxLength)}`
}

export function truncateMemoryText(text: string, maxLength: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxLength) return cleaned
  const separator = ' ... [较早内容已折叠] ... '
  const available = Math.max(2, maxLength - separator.length)
  const headLength = Math.ceil(available * 0.58)
  const tailLength = available - headLength
  return `${cleaned.slice(0, headLength)}${separator}${cleaned.slice(-tailLength)}`
}

function readChapterIdFromToolData(data: unknown): string | null {
  return isRecord(data) && typeof data.id === 'string' ? data.id : null
}

function normalizeFactMemoryType(value: unknown): NovelMemoryType {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (['story_bible', 'style_guide', 'world_rule', 'user_preference', 'semantic_note'].includes(normalized)) {
    return normalized as NovelMemoryType
  }
  return 'semantic_note'
}

function readPipelineRoleFromRouting(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  try {
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? readRawString(parsed.pipeline_role ?? parsed.pipelineRole ?? parsed.role) : ''
  } catch {
    return ''
  }
}

function readPipelineRoleFromParameters(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  try {
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? readRawString(parsed.pipeline_role ?? parsed.pipelineRole) : ''
  } catch {
    return ''
  }
}

function normalizeRoleName(value: string): ChapterPipelineRole | null {
  const normalized = normalizeComparable(value)
  if (!normalized) return null
  for (const role of CHAPTER_PIPELINE_ROLES) {
    if (normalizeComparable(role) === normalized) return role
    if (ROLE_KEYWORDS[role].some(keyword => normalizeComparable(keyword) === normalized)) return role
  }
  return null
}

function normalizeComparable(value: string): string {
  return value.toLowerCase().replace(/[\s_\-:：/\\|()[\]【】「」“”'".,，。]+/g, '')
}

function inferChapterGoal(input: string): string {
  const firstLine = input.split(/\r?\n/).map(line => line.trim()).find(Boolean)
  return firstLine || '完成当前章节，推进主线并保持连续性'
}

function inferPov(input: string): string {
  if (/第一人称/.test(input)) return '第一人称'
  if (/第三人称全知/.test(input)) return '第三人称全知视角'
  if (/第三人称/.test(input)) return '第三人称有限视角'
  if (/第二人称/.test(input)) return '第二人称'
  return '第三人称有限视角'
}

function estimateTargetWords(input: string): number | null {
  const arabic = input.match(/(?:目标|约|大约|不少于|至少|控制在|target_words["']?\s*[:：]?)\s*(\d{3,5})\s*(?:字|词|字符|words?)?/i)
  if (arabic) return Number(arabic[1])
  const loose = input.match(/(\d{3,5})\s*(?:字|词|字符|words?)/i)
  if (loose) return Number(loose[1])
  return null
}

function clampPositiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function clampTargetWords(value: number): number {
  if (!Number.isFinite(value) || value < MIN_PIPELINE_TARGET_WORDS) return DEFAULT_PIPELINE_TARGET_WORDS
  return Math.min(MAX_PIPELINE_TARGET_WORDS, Math.floor(value))
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key]
    const numberValue = readNumberValue(value)
    if (numberValue !== null) return numberValue
  }
  return null
}

function readNumberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) return Number(value)
  return null
}

function readBoolean(record: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
      if (/^(true|yes|1)$/i.test(value.trim())) return true
      if (/^(false|no|0)$/i.test(value.trim())) return false
    }
  }
  return null
}

function readString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = readRawString(record[key])
    if (value) return value
  }
  return ''
}

function readRawString(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(readRawString).filter(Boolean)
  }
  const raw = readRawString(value)
  if (!raw) return []
  return raw.split(/[，,、;\n]/).map(item => item.trim()).filter(Boolean)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

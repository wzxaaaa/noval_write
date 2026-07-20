import { ipcMain } from 'electron'
import { providerConfigRepo, type ProviderConfigCreate } from '../db/repositories/provider-config.repo'
import { conversationRepo } from '../db/repositories/conversation.repo'
import { createAdapter } from '../services/ai-adapter/adapter-factory'
import type { AIChatMessage } from '../services/ai-adapter/types'
import { normalizeAssistantContent, sanitizeChatMessages } from '../../shared/chatMessages'
import { assertTrustedIpcSender } from '../utils/approved-paths'
import {
  abortStreamController,
  releaseStreamController,
  replaceStreamController
} from './stream-controller-registry'
import {
  applyNovelEditPlan,
  buildNumberedChapterText,
  cleanDraftText,
  extractJsonObject,
  fallbackNovelEditPlan,
  findSelectedParagraphRange,
  type NovelEditOperation,
  type NovelEditOperationType,
  type NovelEditPlan,
  type PlannedChapterEditRequest
} from '../../shared/novelEditPlan'

// 活跃流的 AbortController，按 conversationId 索引
const activeStreams = new Map<string, AbortController>()

export function registerAIHandlers(): void {
  // Provider management
  ipcMain.handle('ai:listProviders', async (event) => {
    assertTrustedIpcSender(event)
    return providerConfigRepo.list()
  })

  ipcMain.handle('ai:getProvider', async (event, id: string) => {
    assertTrustedIpcSender(event)
    return providerConfigRepo.getById(id)
  })

  ipcMain.handle('ai:createProvider', async (event, params: ProviderConfigCreate) => {
    assertTrustedIpcSender(event)
    return providerConfigRepo.create(params)
  })

  ipcMain.handle('ai:updateProvider', async (event, id: string, updates: Partial<ProviderConfigCreate>) => {
    assertTrustedIpcSender(event)
    providerConfigRepo.update(id, updates)
  })

  ipcMain.handle('ai:deleteProvider', async (event, id: string) => {
    assertTrustedIpcSender(event)
    providerConfigRepo.delete(id)
  })

  ipcMain.handle('ai:testConnection', async (event, configId: string) => {
    assertTrustedIpcSender(event)
    const config = providerConfigRepo.getById(configId)
    if (!config) return { ok: false, error: '配置不存在' }
    const adapter = createAdapter(config)
    return adapter.testConnection()
  })

  // Conversation management
  ipcMain.handle('ai:createConversation', async (event, projectId: string, chapterId?: string, title?: string, providerConfigId?: string) => {
    assertTrustedIpcSender(event)
    return conversationRepo.create(projectId, chapterId, title, providerConfigId)
  })

  ipcMain.handle('ai:listConversations', async (event, projectId: string) => {
    assertTrustedIpcSender(event)
    return conversationRepo.listByProject(projectId)
  })

  ipcMain.handle('ai:getMessages', async (event, conversationId: string) => {
    assertTrustedIpcSender(event)
    return conversationRepo.getMessages(conversationId)
  })

  ipcMain.handle('ai:deleteConversation', async (event, conversationId: string) => {
    assertTrustedIpcSender(event)
    conversationRepo.delete(conversationId)
  })

  // Streaming AI chat
  ipcMain.handle('ai:abortStream', async (event, conversationId: string) => {
    assertTrustedIpcSender(event)
    abortStreamController(activeStreams, conversationId)
  })

  ipcMain.handle('ai:sendMessage', async (event, params: {
    conversationId: string
    providerConfigId: string
    messages: AIChatMessage[]
    userMessage?: string
    aiParams?: Record<string, unknown>
  }) => {
    assertTrustedIpcSender(event)
    const config = providerConfigRepo.getById(params.providerConfigId)
    if (!config) throw new Error('AI 配置不存在')

    // 如果该对话已有活跃流，先终止
    const abortController = replaceStreamController(activeStreams, params.conversationId)

    const adapter = createAdapter(config)
    // 清洗历史：丢空消息、合并连续同角色，修复此前可能存进库的脏数据。
    const fullMessages: AIChatMessage[] = sanitizeChatMessages(params.messages)
    const latestMessage = fullMessages[fullMessages.length - 1]
    const userMessage = typeof params.userMessage === 'string' && params.userMessage.trim()
      ? params.userMessage
      : latestMessage?.role === 'user' ? latestMessage.content : null
    if (userMessage) {
      conversationRepo.addUserMessageIfNeeded(params.conversationId, userMessage)
    }

    let fullText = ''
    let fullThinking = ''
    try {
      await adapter.chatStream(fullMessages, {
        onToken: (token) => {
          fullText += token
          if (activeStreams.get(params.conversationId) === abortController) {
            event.sender.send('ai:token', { conversationId: params.conversationId, token })
          }
        },
        onThinking: (thinking) => {
          fullThinking += thinking
          if (activeStreams.get(params.conversationId) === abortController) {
            event.sender.send('ai:thinking', { conversationId: params.conversationId, thinking })
          }
        },
        onComplete: (content) => {
          if (activeStreams.get(params.conversationId) !== abortController) return
          // 空回复不能落库：一旦写进历史，之后每次请求都会带着它触发 400。
          const safeContent = normalizeAssistantContent(content) ?? normalizeAssistantContent(fullText)
          if (!safeContent) return
          conversationRepo.addMessage(
            params.conversationId,
            'assistant',
            safeContent,
            undefined,
            fullThinking ? { thinking: fullThinking } : {}
          )
        },
        onError: (err) => {
          throw err
        }
      }, { ...params.aiParams as any, signal: abortController.signal })

      return { content: fullText, conversationId: params.conversationId }
    } catch (err) {
      const isAbort = (err as Error).name === 'AbortError' || abortController.signal.aborted
      // 被终止时，已产出的内容仍然保存
      if (isAbort && fullText) {
        if (activeStreams.get(params.conversationId) === abortController) {
          conversationRepo.addMessage(
            params.conversationId,
            'assistant',
            fullText,
            undefined,
            fullThinking ? { thinking: fullThinking } : {}
          )
        }
        return { content: fullText, conversationId: params.conversationId, aborted: true }
      }
      return { conversationId: params.conversationId, error: isAbort ? '已终止生成' : (err as Error).message }
    } finally {
      releaseStreamController(activeStreams, params.conversationId, abortController)
    }
  })

  // Non-streaming AI chat
  ipcMain.handle('ai:sendMessageSync', async (event, params: {
    providerConfigId: string
    messages: AIChatMessage[]
    aiParams?: Record<string, unknown>
  }) => {
    assertTrustedIpcSender(event)
    const config = providerConfigRepo.getById(params.providerConfigId)
    if (!config) throw new Error('AI 配置不存在')

    const adapter = createAdapter(config)
    return adapter.chat(params.messages, params.aiParams as any)
  })

  ipcMain.handle('ai:planChapterEdit', async (event, params: PlannedChapterEditRequest) => {
    assertTrustedIpcSender(event)
    const config = providerConfigRepo.getById(params.providerConfigId)
    if (!config) throw new Error('AI 配置不存在')

    const adapter = createAdapter(config)
    const assistantDraft = cleanDraftText(params.assistantContent)
    if (!assistantDraft) {
      throw new Error('没有可放入正文的 AI 输出')
    }

    try {
      const response = await adapter.chat([
        { role: 'system', content: buildNovelEditSystemPrompt() },
        { role: 'user', content: buildNovelEditUserPrompt(params, assistantDraft) }
      ], {
        temperature: 0.1,
        maxTokens: 2200
      })

      const parsed = extractJsonObject(response.content)
      const plan = coerceNovelEditPlan(parsed, assistantDraft)
      return applyNovelEditPlan(params.chapterHtml, plan)
    } catch (err) {
      const fallback = fallbackNovelEditPlan(
        assistantDraft,
        `定位失败，已降级为章尾追加：${(err as Error).message}`
      )
      return applyNovelEditPlan(params.chapterHtml, fallback)
    }
  })
}

function buildNovelEditSystemPrompt(): string {
  return `你是小说写作 IDE 的编辑 Agent。你的任务不是聊天，而是生成可由宿主应用执行的结构化章节编辑计划。

你会收到：
1. 当前章节标题；
2. 当前章节正文，已按段落标记为 [p1]、[p2]；
3. 用户最近的写作指令；
4. AI 最近生成的候选正文；
5. 用户当前选中的文字及其段落范围（如果有）。

你必须只返回 JSON，不要 markdown，不要解释。JSON 结构：
{
  "summary": "一句话说明将如何放入正文",
  "confidence": 0.0,
  "operations": [
    {
      "type": "append_chapter | prepend_chapter | insert_after_paragraph | insert_before_paragraph | replace_paragraphs | delete_paragraphs | rewrite_chapter",
      "paragraphId": "p3",
      "startParagraphId": "p3",
      "endParagraphId": "p4",
      "text": "要插入或替换成的正文",
      "reason": "为什么放在这里"
    }
  ]
}

规则：
- 优先像代码编辑器一样做最小编辑，不要整章重写，除非当前章节为空或用户明确要求重写。
- 如果有选区，优先围绕选区替换或插入。
- 如果候选正文是续写，通常插入到语义最连贯的段落之后，常见是最后一段之后。
- 如果用户要求“放入正文”，你要判断它应该成为新段落、替换选区、还是追加到章尾。
- text 必须是可直接进入小说正文的内容，不要包含“正文：”“以下是”“说明”等包装语。
- 段落编号只能使用输入中存在的编号；不确定时使用 append_chapter，并降低 confidence。
- 不要改变没有必要改变的旧正文。`
}

function buildNovelEditUserPrompt(params: PlannedChapterEditRequest, assistantDraft: string): string {
  const selectedRange = findSelectedParagraphRange(params.chapterHtml, params.selectedText)
  const numberedChapter = buildNumberedChapterText(params.chapterHtml)

  return `章节标题：
${params.chapterTitle || '未命名章节'}

当前章节正文：
${numberedChapter}

${selectedRange ? `当前选区：
范围：${selectedRange.startParagraphId} 到 ${selectedRange.endParagraphId}
内容：
${selectedRange.text}` : '当前选区：无'}

用户最近指令：
${params.userInstruction?.trim() || '(无明确指令，请根据候选正文判断最合理的位置)'}

AI 候选正文：
${assistantDraft}

请返回严格 JSON 编辑计划。`
}

function coerceNovelEditPlan(value: unknown, fallbackText: string): NovelEditPlan {
  if (!isRecord(value)) {
    return fallbackNovelEditPlan(fallbackText, '模型未返回 JSON 编辑计划，已默认追加到章尾')
  }

  const operations = Array.isArray(value.operations)
    ? value.operations.map(coerceNovelEditOperation).filter((operation): operation is NovelEditOperation => operation !== null)
    : []

  if (operations.length === 0) {
    return fallbackNovelEditPlan(fallbackText, '模型返回的编辑计划没有有效操作，已默认追加到章尾')
  }

  return {
    summary: typeof value.summary === 'string' ? value.summary : 'AI 已生成章节编辑计划',
    confidence: typeof value.confidence === 'number' ? value.confidence : 0.5,
    operations
  }
}

function coerceNovelEditOperation(value: unknown): NovelEditOperation | null {
  if (!isRecord(value)) return null

  const type = typeof value.type === 'string' && isNovelEditOperationType(value.type)
    ? value.type
    : null
  if (!type) return null

  return {
    type,
    paragraphId: typeof value.paragraphId === 'string' ? value.paragraphId : undefined,
    startParagraphId: typeof value.startParagraphId === 'string' ? value.startParagraphId : undefined,
    endParagraphId: typeof value.endParagraphId === 'string' ? value.endParagraphId : undefined,
    text: typeof value.text === 'string' ? value.text : '',
    reason: typeof value.reason === 'string' ? value.reason : undefined
  }
}

function isNovelEditOperationType(value: string): value is NovelEditOperationType {
  return [
    'append_chapter',
    'prepend_chapter',
    'insert_after_paragraph',
    'insert_before_paragraph',
    'replace_paragraphs',
    'delete_paragraphs',
    'rewrite_chapter'
  ].includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

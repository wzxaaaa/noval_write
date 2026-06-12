import { APP_ACTION_DEFINITIONS, type AppActionCall, type AppActionResult, type AppAgentActionEvent, type AppAgentMessageParams, type AppAgentMessageResult } from '../../../shared/appActions'
import { extractJsonObject } from '../../../shared/novelEditPlan'
import { conversationRepo } from '../../db/repositories/conversation.repo'
import { providerConfigRepo } from '../../db/repositories/provider-config.repo'
import { createAdapter } from '../ai-adapter/adapter-factory'
import type { AIChatMessage } from '../ai-adapter/types'
import { ActionRegistry } from './action-registry'

interface RunnerCallbacks {
  onActionEvent?: (event: AppAgentActionEvent) => void
}

interface AgentDecision {
  actions: AppActionCall[]
  say: string
  done: boolean
}

export interface TaskIntent {
  outlineRelated: boolean
  outlineOnly: boolean
  wantsDetailed: boolean
  wantsOutline: boolean
  bodyWriting: boolean
  explicitChapterReference: boolean
}

const MAX_ACTION_ROUNDS = 6

export async function runAppAgentMessage(
  params: AppAgentMessageParams,
  callbacks: RunnerCallbacks = {}
): Promise<AppAgentMessageResult> {
  const config = providerConfigRepo.getById(params.providerConfigId)
  if (!config) throw new Error('AI 配置不存在')

  const adapter = createAdapter(config)
  const registry = new ActionRegistry({
    projectId: params.projectId,
    chapterId: params.chapterId,
    currentPanel: params.currentPanel
  })

  const latestMessage = params.messages[params.messages.length - 1]
  if (latestMessage?.role === 'user') {
    conversationRepo.addMessage(params.conversationId, 'user', latestMessage.content)
  }

  const actionResults: AppActionResult[] = []
  const latestUserContent = latestMessage?.role === 'user' ? latestMessage.content : ''
  const needsAction = shouldRequireAction(latestUserContent)
  const taskIntent = getTaskIntent(latestUserContent)
  let complianceRetries = 0
  const workingMessages: AIChatMessage[] = [
    { role: 'system', content: buildAppAgentSystemPrompt() },
    { role: 'system', content: buildRuntimeContextPrompt(registry.getRuntimeContext()) },
    ...params.messages
  ]

  let finalContent = ''

  try {
    for (let round = 0; round < MAX_ACTION_ROUNDS; round++) {
      const response = await adapter.chat(workingMessages, {
        temperature: 0.2,
        maxTokens: 5000,
        ...params.aiParams
      })

      const decision = parseAgentDecision(response.content)
      if (!decision) {
        if (needsAction && complianceRetries < 2) {
          complianceRetries++
          workingMessages.push({ role: 'assistant', content: response.content.slice(0, 3000) })
          workingMessages.push({
            role: 'user',
            content: buildComplianceCorrection('你刚才没有返回可执行 JSON。用户这次请求需要真实操作软件，不能只口头回复。')
          })
          continue
        }

        finalContent = needsAction && actionResults.length === 0
          ? '我这次没有成功调用软件动作，所以还没有写入。请再发一次，我会重新执行。'
          : cleanAssistantText(response.content)
        break
      }

      const requestedActions = decision.actions.filter(action => action.name)
      const executableActions = prepareActionsForExecution(requestedActions, taskIntent)

      if (executableActions.length === 0) {
        if ((needsAction || requestedActions.length > 0) && actionResults.length === 0 && complianceRetries < 2) {
          complianceRetries++
          workingMessages.push({
            role: 'assistant',
            content: JSON.stringify(decision)
          })
          workingMessages.push({
            role: 'user',
            content: buildComplianceCorrection(
              requestedActions.length > 0
                ? '你刚才调用的 action 与用户任务目标不匹配。大纲/细纲任务不要调用正文写入或正文提案。'
                : '你没有调用任何 action。用户要求创建、写入或控制软件时，必须通过 actions 完成。'
            )
          })
          continue
        }

        finalContent = needsAction && actionResults.length === 0
          ? '我这次没有成功调用软件动作，所以还没有写入。请再发一次，我会重新执行。'
          : decision.say || summarizeActionResults(actionResults) || '我已经处理好了。'
        break
      }

      const roundResults: AppActionResult[] = []
      for (const action of executableActions.slice(0, 5)) {
        callbacks.onActionEvent?.({
          conversationId: params.conversationId,
          status: 'started',
          action: action.name,
          message: `小漫正在执行：${labelAction(action.name)}`
        })

        const result = await registry.execute(action)
        actionResults.push(result)
        roundResults.push(result)

        callbacks.onActionEvent?.({
          conversationId: params.conversationId,
          status: result.ok ? 'completed' : 'error',
          action: action.name,
          message: result.message,
          result,
          uiEffects: result.uiEffects
        })
      }

      if (shouldStopAfterActionRound(taskIntent, actionResults, roundResults)) {
        finalContent = summarizeActionResults(actionResults)
        break
      }

      workingMessages.push({
        role: 'assistant',
        content: JSON.stringify({
          actions: executableActions,
          say: decision.say,
          done: false
        })
      })
      workingMessages.push({
        role: 'user',
        content: `动作执行结果如下，请基于结果继续。如果任务已经完成，返回 actions: [] 和面向用户的 say。\n${formatResultsForModel(roundResults)}`
      })
    }

    if (!finalContent) {
      finalContent = needsAction && actionResults.length === 0
        ? '我这次没有成功调用软件动作，所以还没有写入。请再发一次，我会重新执行。'
        : summarizeActionResults(actionResults) || '我已经处理好了。'
    }

    conversationRepo.addMessage(params.conversationId, 'assistant', finalContent)
    return {
      content: finalContent,
      conversationId: params.conversationId,
      actionResults
    }
  } catch (err) {
    return {
      conversationId: params.conversationId,
      actionResults,
      error: (err as Error).message
    }
  }
}

function buildAppAgentSystemPrompt(): string {
  return `你是小说写作软件里的 AI 助手「小漫」。你不只是聊天，也可以通过宿主应用提供的 Action Registry 控制软件。

你必须只返回 JSON，不要使用 markdown，不要在 JSON 外输出任何文字。

返回格式：
{
  "actions": [
    { "name": "action_name", "input": { "key": "value" } }
  ],
  "say": "给用户看的自然语言回复。执行动作前可以为空；动作完成后要简洁说明结果。",
  "done": false
}

可用动作：
${APP_ACTION_DEFINITIONS.map(action => {
  const schema = Object.entries(action.inputSchema)
    .map(([key, description]) => `${key}: ${description}`)
    .join('; ') || '无参数'
  return `- ${action.name}（${action.safety}）：${action.description} 参数：${schema}`
}).join('\n')}

第二期 Agent 规则：
- 你要像 IDE Agent 一样先判断目标，再行动。涉及“第几章、当前章、某个标题”的请求，优先用 resolve_chapter/read_chapter 确认目标。
- 用户要求按大纲/细纲写正文时，先用 read_outline 读取对应 outline/detailed 内容，再生成正文。
- 生成、续写、润色、完成某章正文时，默认使用 propose_chapter_edit，把结果放入正文确认条；只有用户明确说“直接保存、写入数据库、无需确认、入库”时，才使用 update_chapter_content。
- propose_chapter_edit 的 content 必须是可直接进入小说正文的正文，不要包含“下面是、说明、分析、修改建议、字数统计”等包装文字。
- 如果需要新章节，先 create_chapter；如果要填已有章节，先 resolve_chapter/read_chapter，再 propose_chapter_edit。
- 用户只要求规划、制定、整理、创建大纲/细纲时，只调用 upsert_outline/read_outline/list_outlines/open_panel 这一类结构动作；不要读取章节，不要 propose_chapter_edit，不要 update_chapter_content。
- “前十章细纲、前 N 章规划、章节拆解”属于细纲任务，不是第 1 章正文写作任务。写入细纲成功后停止，不要再改正文。
- 如果动作失败，不要硬说完成；根据错误继续读取、定位、重试，或者在 say 里说明缺少什么。

行为规则：
1. 用户要求你“放入、写入、保存、创建、打开、切换、读取、搜索”时，优先使用 action，不能只口头承诺。
2. 用户要求整理、生成、创建大纲/细纲并放入对应位置时，直接使用 upsert_outline；type 必须是 outline 或 detailed，并把你生成的完整内容放进 input.content。
3. 用户要求创建章节时，使用 create_chapter。用户要求写入已有章节正文时，才使用 update_chapter_content。
4. 写正文时不要把“以下是、说明、建议”等包装文字写入正文。
5. 不确定章节 ID 时，先用 list_chapters 或 read_chapter 查清楚。
6. 不确定知识库信息时，先用 search_knowledge 或 list_knowledge。
7. open_panel 和 select_chapter 只负责界面控制；数据写入必须使用对应写入动作。
8. 不要编造动作执行结果。只有看到动作结果后，才能说已经完成。
9. 如果只是普通创作咨询、头脑风暴或解释问题，可以 actions 为空，直接在 say 里回答。
10. 如果 actions 非空，即使你认为任务完成了，也必须让宿主应用先执行 actions；done 不能用来跳过动作。
11. 每轮最多调用 5 个 action。任务未完成时 done 为 false；完成或无需动作时 actions 为空且 done 为 true。

例子：
用户：“先创建一个大纲吧？然后细纲也来点”
你第一轮必须返回：
{
  "actions": [
    { "name": "upsert_outline", "input": { "type": "outline", "title": "故事大纲", "content": "这里放完整大纲内容" } },
    { "name": "upsert_outline", "input": { "type": "detailed", "title": "章节细纲", "content": "这里放完整细纲内容" } }
  ],
  "say": "",
  "done": false
}`
}

function buildRuntimeContextPrompt(context: Record<string, unknown>): string {
  return `当前宿主软件上下文(JSON)。你可以信任这些 id、标题、当前面板和当前章节；需要更完整正文或细纲时继续调用 read_chapter/read_outline。
${JSON.stringify(context)}`
}

export function getTaskIntent(text: string): TaskIntent {
  const compact = text.replace(/\s+/g, '')
  const wantsDetailed = /细纲|章节细纲|分章|章节规划|章节拆解|分场|前[零〇一二两三四五六七八九十百千万\d]+章/.test(compact)
  const wantsOutline = /大纲|纲要|提纲|卷纲|故事梗概|剧情梗概|总体结构|整体结构|主线结构/.test(compact)
  const outlineRelated = wantsDetailed || wantsOutline
  const bodyWriting = /正文|小说正文|章节正文|成稿|正文稿|最终稿|续写|润色|改写|重写|扩写|补写|下一场|下一幕|开篇|开头|写开头|写一段|放入正文|放到正文|放进正文|替换正文|更新正文/.test(compact) ||
    /(?:完成|写|创作|生成|补全|续写|润色|改写|重写|扩写).{0,8}第[零〇一二两三四五六七八九十百千万\d]+章/.test(compact) ||
    /第[零〇一二两三四五六七八九十百千万\d]+章.{0,8}(?:正文|成稿|写完|完成|续写|润色|改写|重写|扩写)/.test(compact)
  const explicitChapterReference = /当前章|这一章|本章|已有章节|现有章节|章节内容|第[零〇一二两三四五六七八九十百千万\d]+章/.test(compact) && !/前[零〇一二两三四五六七八九十百千万\d]+章/.test(compact)

  return {
    outlineRelated,
    outlineOnly: outlineRelated && !bodyWriting,
    wantsDetailed,
    wantsOutline,
    bodyWriting,
    explicitChapterReference
  }
}

export function prepareActionsForExecution(actions: AppActionCall[], intent: TaskIntent): AppActionCall[] {
  const allowedForOutlineOnly = new Set([
    'get_project_context',
    'list_outlines',
    'read_outline',
    'upsert_outline',
    'open_panel',
    'search_knowledge',
    'list_knowledge'
  ])

  const allowedChapterReads = new Set(['resolve_chapter', 'list_chapters', 'read_chapter'])

  const prepared = actions
    .map(action => normalizeActionForIntent(action, intent))
    .filter((action): action is AppActionCall => {
      if (!action) return false
      if (!intent.outlineOnly) return true
      if (allowedForOutlineOnly.has(action.name)) return true
      return intent.explicitChapterReference && allowedChapterReads.has(action.name)
    })

  return dedupeActions(prepared)
}

function normalizeActionForIntent(action: AppActionCall, intent: TaskIntent): AppActionCall | null {
  const input = { ...(action.input ?? {}) }

  if (intent.outlineOnly && (action.name === 'create_chapter' || action.name === 'propose_chapter_edit' || action.name === 'update_chapter_content')) {
    return null
  }

  if (action.name === 'open_panel' && intent.outlineOnly) {
    input.panel = 'outline'
  }

  if ((action.name === 'upsert_outline' || action.name === 'read_outline' || action.name === 'list_outlines') && intent.outlineRelated) {
    const normalizedType = normalizeOutlineTypeForIntent(input, intent)
    if (normalizedType) {
      input.type = normalizedType
    }
  }

  return { ...action, input }
}

export function shouldStopAfterActionRound(intent: TaskIntent, actionResults: AppActionResult[], roundResults: AppActionResult[]): boolean {
  if (!intent.outlineOnly) return false
  return roundResults.some(result => result.ok && result.name === 'upsert_outline') ||
    actionResults.some(result => result.ok && result.name === 'upsert_outline')
}

function normalizeOutlineTypeForIntent(input: Record<string, unknown>, intent: TaskIntent): 'outline' | 'detailed' | null {
  const rawType = readLooseInputString(input, 'type')
  const directType = normalizeOutlineTypeAlias(rawType)
  if (directType) return directType

  const searchable = [
    rawType,
    readLooseInputString(input, 'title'),
    readLooseInputString(input, 'name'),
    readLooseInputString(input, 'label'),
    readLooseInputString(input, 'content').slice(0, 500)
  ].join(' ')
  const typeFromText = inferOutlineTypeFromText(searchable)
  if (typeFromText) return typeFromText

  if (intent.wantsDetailed && !intent.wantsOutline) return 'detailed'
  if (intent.wantsOutline && !intent.wantsDetailed) return 'outline'
  if (intent.wantsDetailed) return 'detailed'
  if (intent.wantsOutline) return 'outline'
  return null
}

function normalizeOutlineTypeAlias(value: string): 'outline' | 'detailed' | null {
  const normalized = normalizeComparable(value)
  if (!normalized || normalized === 'null' || normalized === 'undefined') return null

  const outlineAliases = new Set([
    'outline',
    'storyoutline',
    'mainoutline',
    'overalloutline',
    'plotoutline',
    'noveloutline',
    '大纲',
    '故事大纲',
    '总体大纲',
    '整体大纲',
    '总纲',
    '卷纲',
    '剧情大纲'
  ].map(normalizeComparable))
  const detailedAliases = new Set([
    'detailed',
    'detail',
    'details',
    'detailedoutline',
    'detailoutline',
    'chapteroutline',
    'chapterplan',
    'chapterplanning',
    'sceneoutline',
    '细纲',
    '章节细纲',
    '分章细纲',
    '分场细纲',
    '章节规划',
    '章节拆解',
    '前十章细纲'
  ].map(normalizeComparable))

  if (outlineAliases.has(normalized)) return 'outline'
  if (detailedAliases.has(normalized)) return 'detailed'
  return null
}

function inferOutlineTypeFromText(value: string): 'outline' | 'detailed' | null {
  const compact = value.replace(/\s+/g, '')
  if (!compact) return null
  if (/细纲|章节细纲|分章|分场|章节规划|章节拆解|前[零〇一二两三四五六七八九十百千万\d]+章/.test(compact)) return 'detailed'
  if (/大纲|纲要|提纲|卷纲|故事梗概|剧情梗概|总体结构|整体结构|主线结构/.test(compact)) return 'outline'
  return null
}

export function parseAgentDecision(content: string): AgentDecision | null {
  const jsonDecision = parseJsonDecision(content)
  if (jsonDecision) return jsonDecision

  const actions = parseLooseActionCalls(content)
  if (actions.length === 0) return null

  return {
    actions,
    say: cleanAssistantText(content),
    done: false
  }
}

function parseJsonDecision(content: string): AgentDecision | null {
  const parsed = extractJsonObject(content)
  if (!isRecord(parsed)) return null

  const actions = extractActionsFromRecord(parsed)
  const say = readString(parsed, ['say', 'message', 'content', 'text', 'response'])
  const hasDecisionShape = actions.length > 0 ||
    typeof parsed.done === 'boolean' ||
    typeof say === 'string' ||
    Array.isArray(parsed.actions) ||
    Array.isArray(parsed.tool_calls) ||
    isRecord(parsed.function_call)

  if (!hasDecisionShape) return null

  return {
    actions,
    say: say?.trim() ?? '',
    done: typeof parsed.done === 'boolean' ? parsed.done : actions.length === 0
  }
}

function extractActionsFromRecord(record: Record<string, unknown>): AppActionCall[] {
  const candidates: unknown[] = []

  if (Array.isArray(record.actions)) candidates.push(...record.actions)
  if (Array.isArray(record.tool_calls)) candidates.push(...record.tool_calls)
  if (Array.isArray(record.toolCalls)) candidates.push(...record.toolCalls)
  if (Array.isArray(record.tools)) candidates.push(...record.tools)
  if (isRecord(record.function_call)) candidates.push(record.function_call)
  if (isRecord(record.functionCall)) candidates.push(record.functionCall)
  if (record.type === 'tool_use' && typeof record.name === 'string') candidates.push(record)
  if (typeof record.name === 'string' && (isRecord(record.input) || isRecord(record.arguments) || typeof record.arguments === 'string')) {
    candidates.push(record)
  }

  return candidates
    .map(coerceActionCall)
    .filter((action): action is AppActionCall => action !== null)
}

function parseLooseActionCalls(content: string): AppActionCall[] {
  return dedupeActions([
    ...parseMinimaxToolCalls(content),
    ...parseBracketToolCalls(content),
    ...parseXmlToolCalls(content),
    ...parseFunctionStyleActionCalls(content)
  ])
}

function parseMinimaxToolCalls(content: string): AppActionCall[] {
  if (!/<minimax:tool_call\b/i.test(content)) return []

  const actions: AppActionCall[] = []
  let currentName: string | null = null
  let currentInput: Record<string, unknown> = {}

  const commit = () => {
    if (!currentName) return
    const action = coerceActionCall({ name: currentName, input: currentInput })
    if (action) actions.push(action)
    currentName = null
    currentInput = {}
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || /^<\/?minimax:tool_call/i.test(line)) continue
    if (/^<\s*}\s*$/.test(line)) {
      commit()
      continue
    }

    const field = /^<\s*([\w-]+)\s*:\s*(.*)$/.exec(line)
    if (!field) continue

    const key = field[1]
    const value = parseMinimaxValue(field[2])

    if (key === 'name') {
      if (currentName) commit()
      currentName = typeof value === 'string' ? value : null
      continue
    }

    if (value === null || value === undefined) continue

    if ((key === 'arguments' || key === 'input') && isRecord(value)) {
      currentInput = { ...currentInput, ...value }
    } else if (!['id', 'label', 'version', 'disabled'].includes(key)) {
      currentInput[key] = value
    }
  }

  commit()
  return actions
}

function parseBracketToolCalls(content: string): AppActionCall[] {
  const actions: AppActionCall[] = []
  const pattern = /\[\s*TOOL\s*:\s*([\w-]+)\s*\]\s*([\s\S]*?)\[\s*\/\s*TOOL\s*\]/gi
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) !== null) {
    const action = coerceActionCall({
      name: match[1].trim().toLowerCase(),
      input: parseLooseInputBlock(match[2])
    })
    if (action) actions.push(action)
  }

  return actions
}

function parseXmlToolCalls(content: string): AppActionCall[] {
  const actions: AppActionCall[] = []
  const pattern = /<((?:[\w-]+:)?(?:tool_call|tool_use|function_call))\b[^>]*>([\s\S]*?)<\/\1>/gi
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) !== null) {
    const block = match[2].trim()
    const parsed = extractJsonObject(block)
    if (isRecord(parsed)) {
      const parsedActions = extractActionsFromRecord(parsed)
      if (parsedActions.length > 0) {
        actions.push(...parsedActions)
        continue
      }
    }

    const name = readXmlTag(block, 'name') || readLooseNamedField(block, 'name')
    if (!name) continue

    const args = readXmlTag(block, 'arguments') ||
      readXmlTag(block, 'input') ||
      readXmlTag(block, 'args') ||
      block
    const action = coerceActionCall({
      name,
      input: parseLooseInputBlock(args)
    })
    if (action) actions.push(action)
  }

  return actions
}

function parseFunctionStyleActionCalls(content: string): AppActionCall[] {
  const knownNames = APP_ACTION_DEFINITIONS.map(action => action.name).join('|')
  const pattern = new RegExp(`\\b(${knownNames})\\s*\\((\\{[\\s\\S]*?\\})\\)`, 'g')
  const actions: AppActionCall[] = []
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) !== null) {
    const action = coerceActionCall({
      name: match[1],
      input: parseLooseInputBlock(match[2])
    })
    if (action) actions.push(action)
  }

  return actions
}

function parseLooseInputBlock(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  if (!trimmed) return {}

  const parsed = parseActionValue(trimmed)
  if (isRecord(parsed)) return filterNullish(parsed)

  const result: Record<string, unknown> = {}
  let currentKey: string | null = null
  let currentValue: string[] = []

  const commit = () => {
    if (!currentKey) return
    const value = parseActionValue(currentValue.join('\n').trim())
    if (value !== null && value !== undefined) result[currentKey] = value
    currentKey = null
    currentValue = []
  }

  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    const field = /^<?\s*([\w-]+)\s*[:=]\s*(.*)$/.exec(line)
    if (field) {
      commit()
      currentKey = field[1]
      currentValue = [field[2]]
    } else if (currentKey) {
      currentValue.push(rawLine)
    }
  }
  commit()

  return result
}

function parseMinimaxValue(raw: string): unknown {
  return parseActionValue(raw)
}

function parseActionValue(raw: string): unknown {
  const value = raw.trim()
  if (!value || value === 'null' || value === '"null"' || value === "'null'") return null

  const jsonLike = value.replace(/,$/, '')
  try {
    return JSON.parse(jsonLike)
  } catch {
    return jsonLike.replace(/^["']|["']$/g, '')
  }
}

function coerceActionCall(value: unknown): AppActionCall | null {
  if (!isRecord(value)) return null

  const functionRecord = isRecord(value.function) ? value.function : null
  const rawName = typeof value.name === 'string'
    ? value.name
    : typeof functionRecord?.name === 'string'
      ? functionRecord.name
      : null
  if (!rawName) return null

  const rawInput = value.input ??
    value.arguments ??
    value.parameters ??
    value.args ??
    functionRecord?.arguments ??
    functionRecord?.parameters
  const name = normalizeActionName(rawName)
  const input = isRecord(rawInput)
    ? filterNullish(rawInput)
    : typeof rawInput === 'string'
      ? parseLooseInputBlock(rawInput)
      : {}

  if ((rawName === 'open_outline_panel' || rawName === 'open_knowledge_panel') && !input.panel) {
    input.panel = rawName === 'open_outline_panel' ? 'outline' : 'knowledge'
  }

  return {
    id: typeof value.id === 'string' ? value.id : undefined,
    name,
    input
  }
}

function filterNullish(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== null && value !== undefined && value !== 'null')
  )
}

function dedupeActions(actions: AppActionCall[]): AppActionCall[] {
  const seen = new Set<string>()
  return actions.filter(action => {
    const key = `${action.name}:${JSON.stringify(action.input ?? {})}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'string') return record[key]
  }
  return undefined
}

function readLooseInputString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function readXmlTag(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block)
  return match?.[1]?.trim() || null
}

function readLooseNamedField(block: string, field: string): string | null {
  const match = new RegExp(`^<?\\s*${field}\\s*[:=]\\s*(.+)$`, 'im').exec(block)
  const value = match?.[1] ? parseActionValue(match[1]) : null
  return typeof value === 'string' ? value : null
}

function normalizeActionName(name: string): string {
  const aliases: Record<string, string> = {
    find_chapter: 'resolve_chapter',
    locate_chapter: 'resolve_chapter',
    select_target_chapter: 'resolve_chapter',
    preview_chapter_edit: 'propose_chapter_edit',
    propose_edit: 'propose_chapter_edit',
    propose_chapter_content: 'propose_chapter_edit',
    write_chapter_preview: 'propose_chapter_edit',
    write_outline: 'upsert_outline',
    create_outline: 'upsert_outline',
    save_outline: 'upsert_outline',
    get_outline: 'read_outline',
    get_chapter_versions: 'list_chapter_versions',
    set_chapter_status: 'update_chapter_status',
    open_outline_panel: 'open_panel',
    open_knowledge_panel: 'open_panel'
  }
  return aliases[name] ?? name
}

function formatResultsForModel(results: AppActionResult[]): string {
  return JSON.stringify(results.map(result => ({
    name: result.name,
    ok: result.ok,
    message: result.message,
    data: result.data,
    uiEffects: result.uiEffects,
    requiresConfirmation: result.requiresConfirmation
  })))
}

function summarizeActionResults(results: AppActionResult[]): string {
  if (results.length === 0) return ''

  const successful = results.filter(result => result.ok)
  const failed = results.filter(result => !result.ok)
  const writeSuccessNames = new Set([
    'upsert_outline',
    'create_chapter',
    'propose_chapter_edit',
    'update_chapter_content',
    'rename_chapter',
    'update_chapter_status'
  ])
  const meaningfulSuccessNames = new Set([
    ...writeSuccessNames,
    'open_panel',
    'select_chapter'
  ])
  const quietSuccessNames = new Set([
    'get_project_context',
    'list_chapters',
    'read_chapter',
    'list_chapter_versions',
    'list_outlines',
    'read_outline',
    'search_knowledge',
    'list_knowledge'
  ])

  const writeSuccesses = successful.filter(result => writeSuccessNames.has(result.name))
  const meaningfulSuccesses = successful.filter(result => meaningfulSuccessNames.has(result.name))
  const visibleSuccesses = writeSuccesses.length > 0
    ? writeSuccesses
    : meaningfulSuccesses.length > 0
    ? meaningfulSuccesses
    : successful.filter(result => !quietSuccessNames.has(result.name))
  const fallbackSuccesses = visibleSuccesses.length > 0 ? visibleSuccesses : successful
  const hasWriteSuccess = writeSuccesses.length > 0
  const lines = fallbackSuccesses.map(result => result.message)

  if (failed.length > 0 && !hasWriteSuccess) {
    lines.push(...failed.map(result => `未完成：${result.message}`))
  }

  return lines.join('\n')
}

function cleanAssistantText(content: string): string {
  const trimmed = content.trim()
  return trimmed
    .replace(/<minimax:tool_call\b[\s\S]*?(?:<\/minimax:tool_call>|$)/gi, '')
    .replace(/<((?:[\w-]+:)?(?:tool_call|tool_use|function_call))\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/\[\s*TOOL\s*:\s*[\w-]+\s*\]\s*[\s\S]*?\[\s*\/\s*TOOL\s*\]/gi, '')
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim()
}

export function shouldRequireAction(text: string): boolean {
  const compact = text.replace(/\s+/g, '')
  if (!compact) return false

  const actionVerb = /(创建|新建|生成|整理|规划|计划|制定|设计|安排|拆解|放入|放到|放进|写入|保存|加入|更新|修改|重命名|打开|切换|选择|搜索|查一下|找一下|读取|定位|标记|完成|续写|润色|改写|按照|根据|参考|制作|写)/
  const target = /(大纲|细纲|章节|正文|知识库|面板|设置|项目|当前章|这一章|第[零〇一二两三四五六七八九十百千万\d]+章)/

  return actionVerb.test(compact) && target.test(compact)
}

function buildComplianceCorrection(reason: string): string {
  return `${reason}

请重新严格返回 JSON，不要 markdown，不要解释。
如果要创建大纲/细纲，请直接调用 upsert_outline，并在 input.content 中给出完整内容。
在 action 执行结果返回之前，不允许在 say 里写“已创建”“已写入”“已完成”。`
}

function labelAction(name: string): string {
  return APP_ACTION_DEFINITIONS.find(action => action.name === name)?.title ?? name
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeComparable(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_\-:：/\\]+/g, '')
}

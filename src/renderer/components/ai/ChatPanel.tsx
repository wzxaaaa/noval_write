import React, { useState, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { isConversationStreaming, useAIStore } from '../../stores/ai.store'
import { useAIStream } from '../../hooks/useAIStream'
import { useEditorStore } from '../../stores/editor.store'
import { countContentChars, htmlToPlainText } from '../../../shared/textMetrics'
import { emitAgentChapterProposal, extractAgentDrafts } from '../../lib/agentProposal'
import { resolveTargetChapter } from '../../lib/chapterTarget'
import { shouldAutoApplyAssistantDraft } from '../../lib/autoDraftIntent'
import { getEffortOptions, getThinkingCapability, THINKING_EFFORT_LABELS, type ThinkingEffort } from '../../../shared/thinkingSupport'
import type { AppAgentActionEvent, AppPanel } from '../../../shared/appActions'
import type { ChapterData, ConversationData } from '../../../preload/types'
import type { SettingsTab } from '../settings/SettingsPanel'

interface ChatPanelProps {
  projectId: string | null
  chapterId: string | null
  currentPanel: AppPanel
  onOpenSettings: (tab?: SettingsTab) => void
  onChapterSelect: (id: string) => void
}

export function ChatPanel({ projectId, chapterId, currentPanel, onOpenSettings, onChapterSelect }: ChatPanelProps) {
  const [input, setInput] = useState('')
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  const [thinkingEffort, setThinkingEffort] = useState<ThinkingEffort>('default')
  const [thinkingExpanded, setThinkingExpanded] = useState(true)
  const [deletingConversation, setDeletingConversation] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [expandedThinkingIds, setExpandedThinkingIds] = useState<Record<string, boolean>>({})
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)
  const [modelMenuPos, setModelMenuPos] = useState<{ left: number; bottom: number } | null>(null)
  const modelTriggerRef = useRef<HTMLButtonElement>(null)
  const modelPopoverRef = useRef<HTMLDivElement>(null)
  const effortRowRef = useRef<HTMLDivElement>(null)
  const effortOptionsRef = useRef<HTMLDivElement>(null)
  const effortCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [effortSubPos, setEffortSubPos] = useState<{ left: number; bottom: number } | null>(null)
  const [showThinking, setShowThinking] = useState(() => localStorage.getItem('noval:showThinking') !== '0')
  const historyRef = useRef<HTMLDivElement>(null)
  const modelMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    localStorage.setItem('noval:showThinking', showThinking ? '1' : '0')
  }, [showThinking])

  // 点击模型菜单外部时收起（弹层经 Portal 渲染，需同时检查触发器与弹层两个节点）。
  useEffect(() => {
    if (!modelMenuOpen) return
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (modelMenuRef.current?.contains(target)) return
      if (modelPopoverRef.current?.contains(target)) return
      if (effortOptionsRef.current?.contains(target)) return
      setModelMenuOpen(false)
      setEffortOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [modelMenuOpen])
  const [isPlanningEdit, setIsPlanningEdit] = useState(false)
  const [isLoadingMessages, setIsLoadingMessages] = useState(false)
  const [planStatus, setPlanStatus] = useState<string | null>(null)
  const [agentActionStatus, setAgentActionStatus] = useState<string | null>(null)
  const [chatError, setChatError] = useState<string | null>(null)
  const [retryDraft, setRetryDraft] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const projectIdRef = useRef<string | null>(projectId)
  const chapterIdRef = useRef<string | null>(chapterId)
  const requestContextVersionRef = useRef(0)
  const sendRequestVersionRef = useRef(0)
  const messagesLoadVersionRef = useRef(0)
  const agentStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const planStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  projectIdRef.current = projectId
  chapterIdRef.current = chapterId
  const {
    providers,
    conversations,
    currentConversationId,
    messages,
    streamingContent,
    streamingThinking,
    streamingConversations,
    setProviders,
    setConversations,
    setCurrentConversation,
    setMessages,
    addConversation,
    removeConversation,
    clearStream
  } = useAIStore()
  // 流式状态按会话跟踪，切换对话不影响其他会话进行中的请求
  const isStreaming = isConversationStreaming(streamingConversations, currentConversationId)
  const { sendMessage } = useAIStream()
  const chapterTitle = useEditorStore(s => s.title)
  const chapterContent = useEditorStore(s => s.content)

  useEffect(() => {
    window.electronAPI.ai.listProviders().then(setProviders)
  }, [])

  useEffect(() => {
    let cancelled = false
    projectIdRef.current = projectId
    const contextVersion = ++requestContextVersionRef.current
    sendRequestVersionRef.current += 1
    messagesLoadVersionRef.current += 1
    if (agentStatusTimerRef.current) clearTimeout(agentStatusTimerRef.current)
    if (planStatusTimerRef.current) clearTimeout(planStatusTimerRef.current)
    agentStatusTimerRef.current = null
    planStatusTimerRef.current = null
    setChatError(null)
    setRetryDraft(null)
    setAgentActionStatus(null)
    setPlanStatus(null)
    setIsPlanningEdit(false)
    setIsLoadingMessages(false)
    setConversations([])
    setCurrentConversation(null)
    setMessages([])
    clearStream()

    if (!projectId) {
      return
    }

    window.electronAPI.ai.listConversations(projectId).then(rows => {
      if (cancelled || requestContextVersionRef.current !== contextVersion || projectIdRef.current !== projectId) return
      const sortedRows = rows.slice().sort((a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )
      const activeConversationId = useAIStore.getState().currentConversationId
      const activeConversation = sortedRows.find(conv => conv.id === activeConversationId)
      const nextConversation = activeConversation ?? sortedRows[0] ?? null

      setConversations(sortedRows)
      setCurrentConversation(nextConversation?.id ?? null)
      if (!nextConversation) setMessages([])
    })

    return () => {
      cancelled = true
    }
  }, [clearStream, projectId, setConversations, setCurrentConversation, setMessages])

  useEffect(() => {
    const loadVersion = ++messagesLoadVersionRef.current
    if (!currentConversationId) {
      setMessages([])
      setIsLoadingMessages(false)
      return
    }

    let cancelled = false
    const contextVersion = requestContextVersionRef.current
    const requestProjectId = projectIdRef.current
    const isCurrentLoad = () => !cancelled &&
      messagesLoadVersionRef.current === loadVersion &&
      requestContextVersionRef.current === contextVersion &&
      projectIdRef.current === requestProjectId &&
      useAIStore.getState().currentConversationId === currentConversationId

    setMessages([])
    setIsLoadingMessages(true)
    window.electronAPI.ai.getMessages(currentConversationId).then(rows => {
      if (!isCurrentLoad()) return
      setMessages(rows)
    }).catch((err: unknown) => {
      if (!isCurrentLoad()) return
      const message = err instanceof Error ? err.message : String(err)
      setChatError(message ? `加载对话失败：${message}` : '加载对话失败')
    }).finally(() => {
      if (isCurrentLoad()) setIsLoadingMessages(false)
    })
    return () => {
      cancelled = true
    }
  }, [currentConversationId, setMessages])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingContent, isStreaming])

  const defaultProvider = providers.find(p => p.is_default === 1) || providers[0]
  const selectedProvider = providers.find(p => p.id === selectedProviderId) || defaultProvider
  const thinkingCapability = useMemo(
    () => selectedProvider
      ? getThinkingCapability(selectedProvider.provider, selectedProvider.model)
      : { adjustable: false, kind: null, mayEmitThinking: false },
    [selectedProvider]
  )

  // 模型不支持调节时固定为默认；openai 风格通道没有 Max 档，降到 High。
  useEffect(() => {
    if (!thinkingCapability.adjustable && thinkingEffort !== 'default') {
      setThinkingEffort('default')
    } else if (thinkingCapability.kind === 'openai' && thinkingEffort === 'max') {
      setThinkingEffort('high')
    }
  }, [thinkingCapability.adjustable, thinkingCapability.kind, thinkingEffort])

  const deleteConversationById = async (conversationId: string) => {
    if (deletingConversation) return
    const confirmed = window.confirm('删除该对话及其全部消息记录？此操作无法撤销。')
    if (!confirmed) return
    setDeletingConversation(true)
    try {
      await window.electronAPI.ai.deleteConversation(conversationId)
      const wasCurrent = useAIStore.getState().currentConversationId === conversationId
      removeConversation(conversationId)
      if (wasCurrent) startFreshConversation()
    } catch (err) {
      setChatError(`删除对话失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setDeletingConversation(false)
    }
  }

  // 点击下拉外部时关闭历史对话菜单。
  useEffect(() => {
    if (!historyOpen) return
    const onDocMouseDown = (e: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setHistoryOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [historyOpen])
  const chapterText = useMemo(() => htmlToPlainText(chapterContent), [chapterContent])
  const chapterTail = useMemo(() => chapterText.slice(-1800), [chapterText])
  const chapterBrief = useMemo(() => buildChapterPromptExcerpt(chapterText, 3600), [chapterText])
  const chapterRewriteText = useMemo(() => buildChapterPromptExcerpt(chapterText, 12000), [chapterText])
  const chapterChars = useMemo(() => countContentChars(chapterText), [chapterText])
  const polishTarget = useMemo(() => formatCharTarget(chapterChars, 1.08, 1.18), [chapterChars])
  const antiAiTarget = useMemo(() => formatCharTarget(chapterChars, 1.00, 1.10), [chapterChars])
  const latestUserInstruction = useMemo(() => {
    return messages
      .slice()
      .reverse()
      .find(msg => msg.role === 'user' && msg.content.trim())
      ?.content ?? ''
  }, [messages])
  const quickPrompts = useMemo(() => {
    const safeTitle = chapterTitle.trim() || '当前章节'

    if (!chapterId) {
      return [
        {
          label: '开篇',
          title: '构思一个有钩子的开篇',
          prompt: '请帮我构思小说开篇：给出主角登场、核心悬念、第一场冲突和本章收束点。'
        },
        {
          label: '设定',
          title: '整理世界观和人物设定',
          prompt: '请帮我整理这个新项目的基础设定：核心卖点、主角欲望、主要阻力、长期伏笔和前三章节奏。'
        }
      ]
    }

    return [
      {
        label: '续写',
        title: '按当前章节继续写',
        prompt: `请续写《${safeTitle}》900-1300 字，只输出可直接放入正文的小说内容，不要解释、不要总结、不要标题。\n\n写法按读者书荒推书区的口味来：别压抑太久，别水设定，三段内给读者一个“继续看”的理由。\n\n写法要求：\n1. 紧接当前章节末尾，不复述前文，不改写已发生内容。\n2. 尽快抛出新阻力、新线索、新误会或新选择，避免原地抒情。\n3. 用动作、对白和具体物件承载信息，少用专业术语堆解释。\n4. 对白要有网文可读性：能互相试探、打断、嘴硬、藏话，不端着讲道理。\n5. 中段给一个小爽点或小反差：打脸、发现、关系推进、危机反转任选其一。\n6. 结尾留下钩子：更大的麻烦、未说完的话、异常线索或选择代价。\n\n当前章节末尾：\n${chapterTail || '(当前章节还没有正文)'}`
      },
      {
        label: '润色',
        title: '润色当前章节',
        prompt: `请对《${safeTitle}》做一次“实质润色改写”，只输出可直接替换整章的小说正文，不要解释、不要修改原则、不要清单。\n\n原文字数约 ${chapterChars || 0} 字；目标字数${polishTarget || '比原文增加约 8%-18%'}。如果原文较短，也必须产生明显增删，不要只做同义词替换。\n\n润色方向按读者真实追更口味来：节奏快一点，爽点/笑点/悬疑点更明确，人物互动更有火花，别让读者觉得“作者在讲设定”。\n\n具体要求：\n1. 保留剧情走向、人物关系、视角和关键信息，不擅自改设定。\n2. 增加具体动作、场景压力、生活细节和对白潜台词，让段落像一场戏在往前走。\n3. 删掉空泛总结、论文腔和解释腔，把专业术语改成读者能立刻看懂的行为后果。\n4. 每 600-900 字至少有一次状态变化：打脸、反差、发现、关系推进、危险升级任选其一。\n5. 主角不要只思考，要做选择；配角不要只捧场，要制造阻力或提供反差。\n6. 章尾要比原文更有追读钩子。\n\n当前章节：\n${chapterRewriteText || '(当前章节还没有正文)'}`
      },
      {
        label: '祛味',
        title: '去掉 AI 味，改成更像真人作者的正文',
        prompt: `请对《${safeTitle}》做一次“祛味”改写，只输出可直接替换整章的小说正文，不要分析、不要说明、不要标题。\n\n原文字数约 ${chapterChars || 0} 字；目标字数${antiAiTarget || '不低于原文，最多增加约 10%'}。不要为了等长而保留模板句，必须有明显句式变化和段落节奏变化。\n\n处理要求：\n1. 保留原剧情、人物关系、视角、伏笔和关键信息，不新增硬设定。\n2. 删掉“他意识到/她不禁/仿佛/某种/这一刻/空气凝固/命运齿轮/内心深处”等泛化套话。\n3. 把抽象心理总结改成具体动作、感官细节、停顿、潜台词和人物反应。\n4. 对白要像真人说话：能嘴硬、吐槽、试探、打断、装没事，不端着解释世界观。\n5. 专业术语只保留必要名词，其余改成读者能立刻看懂的行为后果。\n6. 别写成作文腔，也别写成短视频解说词；要像作者在现场盯着人物行动。\n7. 章尾保留或强化一个追读点。\n\n当前章节：\n${chapterRewriteText || '(当前章节还没有正文)'}`
      },
      {
        label: '挑刺',
        title: '检查章节问题',
        prompt: `请以“老书虫 + 网文编辑”的角度挑刺《${safeTitle}》。只做诊断和修改建议，不要改写正文，不要写入软件。\n\n请按读者真实弃书点来检查，不要按作文评分：\n1. 前三段有没有钩子，读者会不会觉得“还没开始”。\n2. 本章有没有爽点、笑点、悬疑点、社死点、打脸点或关系变化；至少要命中一个。\n3. 有没有设定灌输、专业术语堆叠、原地解释、原地内耗、重复情绪。\n4. 主角有没有主动选择，还是一直被剧情推着走。\n5. 配角有没有功能，还是只负责问问题/捧场/解释。\n6. 章尾有没有下一章诱因。\n\n输出格式：先给一句“读者追更判断”，再按 P0/P1/P2 列问题，最后给 3 条最优先修改动作。\n\n当前章节：\n${chapterBrief || '(当前章节还没有正文)'}`
      },
      {
        label: '下一场',
        title: '设计下一场戏',
        prompt: `请基于《${safeTitle}》只设计“下一场戏方案”，不要写正文，不要放入正文，不要写入软件。\n\n方案按书荒推书区常见好评来做：开局就有事，人物一进场就有目标，冲突别等太久，结尾给读者一个“再看一章”的理由。\n\n输出格式：\n1. 下一场一句话功能。\n2. 场景地点与入场人物。\n3. 6 拍细纲：入场钩子 / 角色小目标 / 直接阻力 / 交锋或反差 / 代价或发现 / 章末钩子。\n4. 可埋伏笔 2 个。\n5. 可用爽点或笑点 2 个。\n6. 不建议这么写的坑 2 个。\n\n当前章节末尾：\n${chapterTail || '(当前章节还没有正文)'}`
      }
    ]
  }, [antiAiTarget, chapterBrief, chapterChars, chapterId, chapterRewriteText, chapterTail, chapterTitle, polishTarget])

  const formatConversationLabel = (conversation: ConversationData) => {
    const title = conversation.title?.trim()
    if (title) return title.length > 28 ? `${title.slice(0, 28)}...` : title

    const createdAt = new Date(conversation.created_at)
    const createdLabel = Number.isNaN(createdAt.getTime())
      ? '未命名对话'
      : createdAt.toLocaleString('zh-CN', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        })

    return `对话 ${createdLabel}`
  }

  useEffect(() => {
    if (providers.length === 0) {
      setSelectedProviderId(null)
      return
    }

    if (!selectedProviderId || !providers.some(provider => provider.id === selectedProviderId)) {
      setSelectedProviderId(defaultProvider?.id ?? providers[0].id)
    }
  }, [defaultProvider?.id, providers, selectedProviderId])

  useEffect(() => {
    if (!currentConversationId) return

    const currentConversation = conversations.find(conv => conv.id === currentConversationId)
    if (currentConversation?.provider_config_id) {
      setSelectedProviderId(currentConversation.provider_config_id)
    }
  }, [conversations, currentConversationId])

  const startFreshConversation = () => {
    requestContextVersionRef.current += 1
    sendRequestVersionRef.current += 1
    messagesLoadVersionRef.current += 1
    if (agentStatusTimerRef.current) clearTimeout(agentStatusTimerRef.current)
    if (planStatusTimerRef.current) clearTimeout(planStatusTimerRef.current)
    agentStatusTimerRef.current = null
    planStatusTimerRef.current = null
    setChatError(null)
    setRetryDraft(null)
    setAgentActionStatus(null)
    setPlanStatus(null)
    setIsPlanningEdit(false)
    setIsLoadingMessages(false)
    setInput('')
    setCurrentConversation(null)
    setMessages([])
    clearStream()
  }

  const switchConversation = (conversationId: string) => {
    requestContextVersionRef.current += 1
    sendRequestVersionRef.current += 1
    messagesLoadVersionRef.current += 1
    if (agentStatusTimerRef.current) clearTimeout(agentStatusTimerRef.current)
    if (planStatusTimerRef.current) clearTimeout(planStatusTimerRef.current)
    agentStatusTimerRef.current = null
    planStatusTimerRef.current = null
    setChatError(null)
    setRetryDraft(null)
    setAgentActionStatus(null)
    setPlanStatus(null)
    setIsPlanningEdit(false)
    setIsLoadingMessages(true)
    setMessages([])
    clearStream()
    setCurrentConversation(conversationId || null)
  }

  useEffect(() => {
    const unsubscribe = window.electronAPI.appAgent.onAction((event: AppAgentActionEvent) => {
      if (event.projectId !== projectIdRef.current) return
      if (event.conversationId !== useAIStore.getState().currentConversationId) return

      if (event.status === 'started') {
        if (agentStatusTimerRef.current) clearTimeout(agentStatusTimerRef.current)
        agentStatusTimerRef.current = null
        setChatError(null)
        setRetryDraft(null)
      }

      setAgentActionStatus(
        event.status === 'started'
          ? event.message
          : event.result?.ok === false
            ? `小漫没有完成：${event.message}`
            : event.message
      )

      if (event.status !== 'started') {
        if (agentStatusTimerRef.current) clearTimeout(agentStatusTimerRef.current)
        const contextVersion = requestContextVersionRef.current
        const eventProjectId = event.projectId
        const eventConversationId = event.conversationId
        agentStatusTimerRef.current = setTimeout(() => {
          agentStatusTimerRef.current = null
          if (requestContextVersionRef.current !== contextVersion) return
          if (projectIdRef.current !== eventProjectId) return
          if (useAIStore.getState().currentConversationId !== eventConversationId) return
          setAgentActionStatus(null)
        }, 3500)
      }
    })

    return () => {
      unsubscribe()
      if (agentStatusTimerRef.current) clearTimeout(agentStatusTimerRef.current)
      if (planStatusTimerRef.current) clearTimeout(planStatusTimerRef.current)
      agentStatusTimerRef.current = null
      planStatusTimerRef.current = null
      requestContextVersionRef.current += 1
      projectIdRef.current = null
    }
  }, [])

  const resolveInstructionTarget = async (
    userInstruction: string,
    targetProjectId = projectId,
    selectedChapterId = chapterId
  ): Promise<ChapterData | null> => {
    if (!targetProjectId) return null

    const chapters = await window.electronAPI.file.listChapters(targetProjectId)
    return resolveTargetChapter(chapters, userInstruction, selectedChapterId)
  }

  const readLatestTarget = async (
    targetId: string,
    targetProjectId: string
  ): Promise<ChapterData | null> => {
    const chapters = await window.electronAPI.file.listChapters(targetProjectId)
    const persistedTarget = chapters.find(candidate => candidate.id === targetId) ?? null
    if (!persistedTarget) return null

    const editor = useEditorStore.getState()
    if (chapterIdRef.current !== targetId || editor.loadedChapterId !== targetId) return persistedTarget

    return {
      ...persistedTarget,
      title: editor.title,
      content: editor.content
    }
  }

  const applyAssistantDraft = async (
    assistantContent: string | null,
    userInstruction = latestUserInstruction,
    targetChapter?: ChapterData | null,
    expectedContext?: {
      projectId: string
      contextVersion: number
      conversationId: string
      chapterId: string | null
    }
  ) => {
    if (!projectId || !selectedProvider || !assistantContent || isPlanningEdit) return
    const applyingProjectId = expectedContext?.projectId ?? projectId
    const applyingContextVersion = expectedContext?.contextVersion ?? requestContextVersionRef.current
    const applyingConversationId = expectedContext?.conversationId ?? useAIStore.getState().currentConversationId
    const applyingChapterId = expectedContext?.chapterId ?? chapterId
    const isCurrentApplyContext = () => {
      if (projectIdRef.current !== applyingProjectId) return false
      if (requestContextVersionRef.current !== applyingContextVersion) return false
      return !applyingConversationId || useAIStore.getState().currentConversationId === applyingConversationId
    }
    if (!isCurrentApplyContext()) return

    const drafts = extractAgentDrafts(assistantContent)
    if (drafts.length === 0) return
    const draftContent = drafts.map(draft => draft.content).join('\n\n')
    const resolvedTarget = targetChapter ?? await resolveInstructionTarget(userInstruction, applyingProjectId, applyingChapterId)
    if (!resolvedTarget || resolvedTarget.project_id !== applyingProjectId || !isCurrentApplyContext()) return
    const target = await readLatestTarget(resolvedTarget.id, applyingProjectId)
    if (!target || !isCurrentApplyContext()) return

    if (planStatusTimerRef.current) clearTimeout(planStatusTimerRef.current)
    planStatusTimerRef.current = null
    setIsPlanningEdit(true)
    setPlanStatus('AI 正在判断正文位置...')
    try {
      const result = await window.electronAPI.ai.planChapterEdit({
        providerConfigId: selectedProvider.id,
        chapterTitle: target.title,
        chapterHtml: target.content,
        assistantContent: draftContent,
        userInstruction,
        selectedText: target.id === chapterIdRef.current && useEditorStore.getState().loadedChapterId === target.id
          ? useEditorStore.getState().selectedText
          : ''
      })

      if (!isCurrentApplyContext()) return

      const latestTarget = await readLatestTarget(target.id, applyingProjectId)
      if (!isCurrentApplyContext()) return
      if (!latestTarget || latestTarget.title !== target.title || latestTarget.content !== target.content) {
        setPlanStatus('正文在生成编辑方案期间已更新，本次提案未应用，请重试。')
        return
      }

      emitAgentChapterProposal({
        chapterId: target.id,
        html: result.proposedHtml,
        oldHtml: target.content,
        sourceName: result.summary || 'AI 对话编辑计划'
      })
      if (target.id !== chapterIdRef.current) {
        onChapterSelect(target.id)
      }
      setPlanStatus(result.warnings[0] || result.summary || `已放入「${target.title}」正文区，等待确认`)
    } catch (err) {
      if (!isCurrentApplyContext()) return
      setPlanStatus((err as Error).message || '生成编辑计划失败')
    } finally {
      if (isCurrentApplyContext()) {
        setIsPlanningEdit(false)
        if (planStatusTimerRef.current) clearTimeout(planStatusTimerRef.current)
        planStatusTimerRef.current = setTimeout(() => {
          planStatusTimerRef.current = null
          if (!isCurrentApplyContext()) return
          setPlanStatus(null)
        }, 5000)
      }
    }
  }

  const handleAbort = async () => {
    const convId = currentConversationId
    if (!convId) return
    await Promise.all([
      window.electronAPI.ai.abortStream(convId),
      window.electronAPI.appAgent.abortMessage(convId)
    ])
  }

  const handleSend = async (draftOverride?: string) => {
    const content = (draftOverride ?? input).trim()
    if (!content || !projectId || !selectedProvider || isLoadingMessages) return
    const sendVersion = ++sendRequestVersionRef.current

    // 追发：如果当前正在流式输出，先终止再发送
    if (isStreaming && currentConversationId) {
      await Promise.all([
        window.electronAPI.ai.abortStream(currentConversationId),
        window.electronAPI.appAgent.abortMessage(currentConversationId)
      ])
    }
    const requestProjectId = projectId
    const requestChapterId = chapterId
    const requestContextVersion = requestContextVersionRef.current
    const isCurrentRequestContext = (conversationId?: string) => {
      if (sendRequestVersionRef.current !== sendVersion) return false
      if (requestContextVersionRef.current !== requestContextVersion) return false
      if (projectIdRef.current !== requestProjectId) return false
      return !conversationId || useAIStore.getState().currentConversationId === conversationId
    }
    setChatError(null)
    setRetryDraft(null)
    let convId: string | null = currentConversationId
    // 消息刷新只看"此刻是否停在这条会话"：用户切走再切回来，完成时也要能
    // 把落库的回复刷出来，不能因为 contextVersion 变过就永远漏掉。
    const stillOnConversation = () =>
      projectIdRef.current === requestProjectId &&
      !!convId && useAIStore.getState().currentConversationId === convId
    const refreshMessagesFromDb = async () => {
      if (!stillOnConversation()) return
      const rows = await window.electronAPI.ai.getMessages(convId!)
      if (stillOnConversation()) setMessages(rows)
    }

    try {
      const targetChapter = await resolveInstructionTarget(content, requestProjectId, requestChapterId)
      if (!isCurrentRequestContext()) return
      const contextChapterId = targetChapter?.id ?? chapterId

      if (!convId) {
        const conv = await window.electronAPI.ai.createConversation(
          requestProjectId,
          undefined,
          undefined,
          selectedProvider.id
        )
        if (!isCurrentRequestContext()) return
        addConversation(conv)
        setCurrentConversation(conv.id)
        convId = conv.id
      }

      setInput('')
      const result = await sendMessage(
        convId,
        selectedProvider.id,
        content,
        thinkingEffort !== 'default' ? { thinkingEffort } : undefined,
        {
          projectId: requestProjectId,
          chapterId: contextChapterId,
          currentPanel
        }
      )
      await refreshMessagesFromDb()
      if (!isCurrentRequestContext(convId)) return

      if (result.aborted) return

      if (result.error) {
        setChatError(`小漫没有完成：${result.error}`)
        setRetryDraft(content)
        return
      }

      if (shouldAutoApplyAssistantDraft(content, result)) {
        await applyAssistantDraft(result.content ?? null, content, targetChapter, {
          projectId: requestProjectId,
          contextVersion: requestContextVersion,
          conversationId: convId,
          chapterId: requestChapterId
        })
      }
    } catch (err) {
      // 失败也要从库里刷一次：否则本地临时用户消息残留，重试时指令会重复发送
      await refreshMessagesFromDb().catch(() => {})
      if (!isCurrentRequestContext()) return
      const message = err instanceof Error ? err.message : String(err)
      setChatError(message ? `小漫没有完成：${message}` : '小漫没有完成本次请求。')
      setRetryDraft(content)
      setInput(content)
    }
  }

  if (!defaultProvider) {
    return (
      <div className="chat-panel">
        <div className="panel-header chat-panel-header">
          <h3>AI 对话</h3>
        </div>
        <div className="chat-empty-state">
          <div className="chat-empty-icon">AI</div>
          <h2>配置 AI 后开始写作</h2>
          <p>添加一个可用的模型配置，就可以围绕章节续写、润色、祛味和拆解问题。</p>
          <button onClick={() => onOpenSettings('api')}>配置 API</button>
        </div>
      </div>
    )
  }

  if (!projectId) {
    return (
      <div className="chat-panel">
        <div className="panel-header chat-panel-header">
          <h3>AI 对话</h3>
          <button onClick={() => onOpenSettings('appearance')} title="设置">设置</button>
        </div>
        <div className="chat-empty-state">
          <div className="chat-empty-icon">AI</div>
          <h2>与 AI 协作</h2>
          <p>打开项目后，AI 会围绕当前章节提供写作协助。</p>
        </div>
      </div>
    )
  }

  return (
    <div className="chat-panel">
      <div className="panel-header chat-panel-header">
        <h3>AI 对话</h3>
        <div className="panel-header-actions">
          {conversations.length > 0 && (
            <div className="chat-history-dropdown" ref={historyRef}>
              <button
                type="button"
                className="chat-history-trigger"
                onClick={() => setHistoryOpen(prev => !prev)}
                title="切换历史对话"
              >
                {(() => {
                  const current = conversations.find(conv => conv.id === currentConversationId)
                  return current ? formatConversationLabel(current) : '新对话'
                })()} ▾
              </button>
              {historyOpen && (
                <div className="chat-history-menu">
                  <div
                    className={`chat-history-item${!currentConversationId ? ' active' : ''}`}
                    onClick={() => { setHistoryOpen(false); startFreshConversation() }}
                  >
                    <span className="chat-history-label">新对话</span>
                  </div>
                  {conversations.map(conversation => (
                    <div
                      key={conversation.id}
                      className={`chat-history-item${conversation.id === currentConversationId ? ' active' : ''}`}
                      onClick={() => { setHistoryOpen(false); switchConversation(conversation.id) }}
                    >
                      <span className="chat-history-label">{formatConversationLabel(conversation)}</span>
                      <button
                        type="button"
                        className="chat-history-delete"
                        title="删除该对话"
                        aria-label={`删除 ${formatConversationLabel(conversation)}`}
                        disabled={deletingConversation}
                        onClick={e => {
                          e.stopPropagation()
                          void deleteConversationById(conversation.id)
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <button onClick={startFreshConversation} title="新对话">＋</button>
          <button onClick={() => onOpenSettings('appearance')} title="设置">设置</button>
        </div>
      </div>

      <div className="chat-messages">
        {messages.length === 0 && !isStreaming && (
          <div className="chat-empty-state chat-empty-state-inline">
            <div className="chat-empty-icon">AI</div>
            <h2>与 AI 协作</h2>
            <p>{chapterId ? '围绕当前章节续写、润色、祛味、挑刺或设计下一场戏。' : '先聊项目设定、开篇钩子和前三章节奏。'}</p>
          </div>
        )}
        {messages.map(msg => {
          const savedThinking = msg.role === 'assistant' ? readMessageThinking(msg.metadata) : ''
          const savedActions = msg.role === 'assistant' ? readMessageActions(msg.metadata) : []
          return (
            <div key={msg.id} className={`chat-message chat-message-${msg.role}`}>
              <div className="message-meta-row">
                <div className="message-role">{msg.role === 'user' ? '你' : '小漫'}</div>
              </div>
              {savedThinking && showThinking && (
                <>
                  <button
                    type="button"
                    className="chat-thinking-toggle"
                    onClick={() => setExpandedThinkingIds(prev => ({ ...prev, [msg.id]: !prev[msg.id] }))}
                  >
                    {expandedThinkingIds[msg.id] ? '▾' : '▸'} 思考过程（{savedThinking.length} 字符）
                  </button>
                  {expandedThinkingIds[msg.id] && (
                    <div className="message-content chat-thinking-content">{savedThinking}</div>
                  )}
                </>
              )}
              <div className="message-content">{msg.content}</div>
              {savedActions.length > 0 && (
                <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  {savedActions.map((action, index) => (
                    <div key={index}>{action.ok ? '✓' : '✗'} {action.message}</div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {isStreaming && streamingThinking && showThinking && (
          <div className="chat-message chat-message-assistant">
            <div className="message-meta-row">
              <button
                type="button"
                className="chat-thinking-toggle"
                onClick={() => setThinkingExpanded(prev => !prev)}
              >
                {thinkingExpanded ? '▾' : '▸'} 思考过程（{streamingThinking.length} 字符）
              </button>
            </div>
            {thinkingExpanded && (
              <div className="message-content chat-thinking-content">{streamingThinking}</div>
            )}
          </div>
        )}
        {isStreaming && !streamingContent && (!streamingThinking || !showThinking) && (
          <div className="chat-pending-message">
            <div className="chat-pending-agent">
              <span className="chat-pending-icon">AI</span>
              <span>小漫</span>
            </div>
            <div className="chat-pending-pill">
              <span className="chat-pending-spark">✦</span>
              <span>正在回应中 ...</span>
            </div>
          </div>
        )}
        {isStreaming && streamingContent && (
          <div className="chat-message chat-message-assistant">
            <div className="message-meta-row">
              <div className="message-role">小漫</div>
            </div>
            <div className="message-content streaming">{streamingContent}</div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area">
        {(chatError || agentActionStatus || planStatus) && (
          <div className="chat-status-stack">
            {chatError && (
              <div className="chat-agent-action-status chat-agent-action-status-error">
                <span className="chat-agent-action-dot" />
                <span>{chatError}</span>
                {retryDraft && (
                  <button type="button" onClick={() => void handleSend(retryDraft)} disabled={isStreaming || isLoadingMessages}>
                    重试
                  </button>
                )}
                <button type="button" onClick={() => setChatError(null)} disabled={isStreaming}>
                  关闭
                </button>
              </div>
            )}
            {agentActionStatus && (
              <div className="chat-agent-action-status">
                <span className="chat-agent-action-dot" />
                <span>{agentActionStatus}</span>
              </div>
            )}
            {planStatus && (
              <div className="chat-agent-action-status">
                <span className="chat-agent-action-dot" />
                <span>{planStatus}</span>
              </div>
            )}
          </div>
        )}
        <div className="chat-prompt-row">
          <span className="chat-agent-chip">@小漫</span>
          {quickPrompts.map(prompt => (
            <button
              key={prompt.label}
              type="button"
              title={prompt.title}
              onClick={() => setInput(prompt.prompt)}
              disabled={isStreaming}
            >
              {prompt.label}
            </button>
          ))}
        </div>
        <div className="chat-input-row">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            disabled={isLoadingMessages}
            placeholder={chapterId ? '输入要求，AI 会围绕当前章节协助...' : '输入项目构思或开篇要求...'}
            rows={3}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (isStreaming && !input.trim()) {
                  void handleAbort()
                } else {
                  void handleSend()
                }
              }
            }}
          />
          <div className="chat-input-footer">
            <div className="chat-model-menu" ref={modelMenuRef}>
              <button
                type="button"
                ref={modelTriggerRef}
                className="chat-model-trigger"
                onClick={() => {
                  const rect = modelTriggerRef.current?.getBoundingClientRect()
                  if (rect) {
                    setModelMenuPos({
                      left: Math.max(8, Math.min(rect.left, window.innerWidth - 268)),
                      bottom: window.innerHeight - rect.top + 6
                    })
                  }
                  setModelMenuOpen(prev => !prev)
                  setEffortOpen(false)
                }}
                disabled={isStreaming}
                title="选择模型与思考努力程度"
              >
                <span className="chat-model-trigger-name">{selectedProvider?.name ?? '选择模型'}</span>
                {thinkingEffort !== 'default' && (
                  <span className="chat-model-trigger-effort">{THINKING_EFFORT_LABELS[thinkingEffort]}</span>
                )}
                <span className="chat-model-trigger-caret">˅</span>
              </button>
              {modelMenuOpen && createPortal(
                <div
                  ref={modelPopoverRef}
                  className="chat-model-popover"
                  style={modelMenuPos ? { left: modelMenuPos.left, bottom: modelMenuPos.bottom } : undefined}
                >
                  {providers.map(provider => (
                    <div
                      key={provider.id}
                      className={`chat-model-option${provider.id === selectedProvider?.id ? ' active' : ''}`}
                      onClick={() => { setSelectedProviderId(provider.id); setEffortOpen(false) }}
                    >
                      <div className="chat-model-option-main">
                        <div className="chat-model-option-name">{provider.name}</div>
                        <div className="chat-model-option-desc">{provider.model}</div>
                      </div>
                      {provider.id === selectedProvider?.id && <span className="chat-model-check">✓</span>}
                    </div>
                  ))}
                  <div className="chat-model-divider" />
                  <div
                    ref={effortRowRef}
                    className={`chat-effort-row${thinkingCapability.adjustable ? '' : ' disabled'}`}
                    title={thinkingCapability.adjustable
                      ? '更高的档位思考更充分，但更慢、更耗 token'
                      : '当前模型不支持调节思考努力程度，已固定为默认'}
                    onMouseEnter={() => {
                      if (!thinkingCapability.adjustable) return
                      if (effortCloseTimer.current) { clearTimeout(effortCloseTimer.current); effortCloseTimer.current = null }
                      const rect = effortRowRef.current?.getBoundingClientRect()
                      if (rect) {
                        setEffortSubPos({
                          left: rect.right + 6,
                          bottom: window.innerHeight - rect.bottom
                        })
                      }
                      setEffortOpen(true)
                    }}
                    onMouseLeave={() => {
                      effortCloseTimer.current = setTimeout(() => setEffortOpen(false), 120)
                    }}
                    onClick={() => {
                      if (!thinkingCapability.adjustable) return
                      if (effortCloseTimer.current) { clearTimeout(effortCloseTimer.current); effortCloseTimer.current = null }
                      const rect = effortRowRef.current?.getBoundingClientRect()
                      if (rect) {
                        setEffortSubPos({
                          left: rect.right + 6,
                          bottom: window.innerHeight - rect.bottom
                        })
                      }
                      setEffortOpen(prev => !prev)
                    }}
                  >
                    <span>Effort</span>
                    <span className="chat-effort-value">
                      {THINKING_EFFORT_LABELS[thinkingEffort]} <span style={{ fontSize: 10 }}>›</span>
                    </span>
                  </div>
                  {effortOpen && thinkingCapability.adjustable && createPortal(
                    <div
                      ref={effortOptionsRef}
                      className="chat-effort-options"
                      style={effortSubPos ? { left: effortSubPos.left, bottom: effortSubPos.bottom } : undefined}
                      onMouseEnter={() => {
                        if (effortCloseTimer.current) { clearTimeout(effortCloseTimer.current); effortCloseTimer.current = null }
                      }}
                      onMouseLeave={() => {
                        effortCloseTimer.current = setTimeout(() => setEffortOpen(false), 120)
                      }}
                    >
                      {getEffortOptions(thinkingCapability.kind).map(effort => (
                        <div
                          key={effort}
                          className={`chat-model-option${effort === thinkingEffort ? ' active' : ''}`}
                          onClick={() => { setThinkingEffort(effort); setEffortOpen(false) }}
                        >
                          <div className="chat-model-option-main">
                            <div className="chat-model-option-name">{THINKING_EFFORT_LABELS[effort]}</div>
                          </div>
                          {effort === thinkingEffort && <span className="chat-model-check">✓</span>}
                        </div>
                      ))}
                    </div>,
                    document.body
                  )}
                  <div className="chat-model-divider" />
                  <div className="chat-thinking-row" title="是否在对话中显示模型的思考过程">
                    <div className="chat-model-option-main">
                      <div className="chat-model-option-name">Thinking</div>
                      <div className="chat-model-option-desc">显示思考过程</div>
                    </div>
                    <button
                      type="button"
                      className={`chat-toggle${showThinking ? ' on' : ''}`}
                      aria-label="切换思考过程显示"
                      onClick={() => setShowThinking(prev => !prev)}
                    >
                      <span className="chat-toggle-knob" />
                    </button>
                  </div>
                </div>,
                document.body
              )}
            </div>
            <button
              className="chat-send-btn"
              onClick={() => {
                if (isStreaming && !input.trim()) {
                  void handleAbort()
                } else {
                  void handleSend()
                }
              }}
              disabled={isLoadingMessages || (!isStreaming && (!input.trim() || !projectId))}
              title={isLoadingMessages ? '正在加载对话' : isStreaming && !input.trim() ? '终止生成' : '发送'}
            >
              {isStreaming && !input.trim() ? '■' : '↑'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function readMessageActions(metadata: string): Array<{ name: string; ok: boolean; message: string }> {
  try {
    const parsed = JSON.parse(metadata || '{}') as { actions?: unknown }
    if (!Array.isArray(parsed.actions)) return []
    return parsed.actions.filter((action): action is { name: string; ok: boolean; message: string } =>
      !!action && typeof action === 'object' &&
      typeof (action as { name?: unknown }).name === 'string' &&
      typeof (action as { message?: unknown }).message === 'string'
    )
  } catch {
    return []
  }
}

function readMessageThinking(metadata: string): string {
  try {
    const parsed = JSON.parse(metadata || '{}')
    return parsed && typeof parsed === 'object' && typeof (parsed as { thinking?: unknown }).thinking === 'string'
      ? (parsed as { thinking: string }).thinking
      : ''
  } catch {
    return ''
  }
}

function buildChapterPromptExcerpt(text: string, maxChars: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed

  const headSize = Math.floor(maxChars * 0.58)
  const tailSize = maxChars - headSize - 80
  return [
    trimmed.slice(0, headSize).trim(),
    `\n\n……中间约 ${Math.max(0, trimmed.length - headSize - tailSize)} 字已省略，请保持前后文一致……\n\n`,
    trimmed.slice(-tailSize).trim()
  ].join('')
}

function formatCharTarget(chars: number, minRate: number, maxRate: number): string {
  if (!chars || chars <= 0) return ''
  const min = Math.max(1, Math.round(chars * minRate))
  const max = Math.max(min, Math.round(chars * maxRate))
  return `约 ${min}-${max} 字`
}

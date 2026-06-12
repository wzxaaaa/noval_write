import React, { useState, useEffect, useRef, useMemo } from 'react'
import { useAIStore } from '../../stores/ai.store'
import { useAIStream } from '../../hooks/useAIStream'
import { useEditorStore } from '../../stores/editor.store'
import { htmlToPlainText } from '../../../shared/textMetrics'
import { emitAgentChapterProposal, extractAgentDrafts } from '../../lib/agentProposal'
import { resolveTargetChapter } from '../../lib/chapterTarget'
import { shouldAutoApplyAssistantDraft } from '../../lib/autoDraftIntent'
import type { AppAgentActionEvent, AppPanel } from '../../../shared/appActions'
import type { ChapterData } from '../../../preload/types'
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
  const [isPlanningEdit, setIsPlanningEdit] = useState(false)
  const [planStatus, setPlanStatus] = useState<string | null>(null)
  const [agentActionStatus, setAgentActionStatus] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const {
    providers,
    conversations,
    currentConversationId,
    messages,
    streamingContent,
    isStreaming,
    setProviders,
    setConversations,
    setCurrentConversation,
    setMessages,
    addConversation
  } = useAIStore()
  const { sendMessage } = useAIStream()
  const chapterTitle = useEditorStore(s => s.title)
  const chapterContent = useEditorStore(s => s.content)
  const selectedText = useEditorStore(s => s.selectedText)

  useEffect(() => {
    window.electronAPI.ai.listProviders().then(setProviders)
  }, [])

  useEffect(() => {
    let cancelled = false

    if (!projectId) {
      setConversations([])
      setCurrentConversation(null)
      setMessages([])
      return
    }

    window.electronAPI.ai.listConversations(projectId).then(rows => {
      if (cancelled) return
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
  }, [projectId, setConversations, setCurrentConversation, setMessages])

  useEffect(() => {
    if (!currentConversationId) {
      setMessages([])
      return
    }

    let cancelled = false
    if (currentConversationId) {
      window.electronAPI.ai.getMessages(currentConversationId).then(rows => {
        if (!cancelled) setMessages(rows)
      })
    }
    return () => {
      cancelled = true
    }
  }, [currentConversationId, setMessages])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingContent, isStreaming])

  const defaultProvider = providers.find(p => p.is_default === 1) || providers[0]
  const selectedProvider = providers.find(p => p.id === selectedProviderId) || defaultProvider
  const chapterText = useMemo(() => htmlToPlainText(chapterContent), [chapterContent])
  const chapterTail = useMemo(() => chapterText.slice(-1200), [chapterText])
  const chapterBrief = useMemo(() => chapterText.slice(0, 3000), [chapterText])
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
        prompt: `请续写《${safeTitle}》800-1200 字。保持现有叙述视角、人物语气和节奏，不要总结，不要改写已发生内容。\n\n当前章节末尾：\n${chapterTail || '(当前章节还没有正文)'}`
      },
      {
        label: '润色',
        title: '润色当前章节',
        prompt: `请润色《${safeTitle}》。保留剧情走向和人物关系，增强画面感、动作连贯性和对白潜台词。请先给修改原则，再给可直接替换的正文。\n\n当前章节：\n${chapterBrief || '(当前章节还没有正文)'}`
      },
      {
        label: '挑刺',
        title: '检查章节问题',
        prompt: `请以资深网文主编角度检查《${safeTitle}》的问题，只关注会影响追读的点：钩子、冲突、爽点、信息密度、人物动机、伏笔兑现。最后给 3 条最该优先修改的建议。\n\n当前章节：\n${chapterBrief || '(当前章节还没有正文)'}`
      },
      {
        label: '下一场',
        title: '设计下一场戏',
        prompt: `请基于《${safeTitle}》设计下一场戏：场景目标、冲突升级、角色选择、结尾钩子，并给出一个 6 拍细纲。\n\n当前章节末尾：\n${chapterTail || '(当前章节还没有正文)'}`
      }
    ]
  }, [chapterBrief, chapterId, chapterTail, chapterTitle])

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
    setCurrentConversation(null)
    setMessages([])
  }

  useEffect(() => {
    const unsubscribe = window.electronAPI.appAgent.onAction((event: AppAgentActionEvent) => {
      if (event.conversationId !== useAIStore.getState().currentConversationId) return

      setAgentActionStatus(
        event.status === 'started'
          ? event.message
          : event.result?.ok === false
            ? `小漫没有完成：${event.message}`
            : event.message
      )

      if (event.status !== 'started') {
        setTimeout(() => setAgentActionStatus(null), 3500)
      }
    })

    return unsubscribe
  }, [])

  const resolveInstructionTarget = async (userInstruction: string): Promise<ChapterData | null> => {
    if (!projectId) return null

    const chapters = await window.electronAPI.file.listChapters(projectId)
    return resolveTargetChapter(chapters, userInstruction, chapterId)
  }

  const applyAssistantDraft = async (
    assistantContent: string | null,
    userInstruction = latestUserInstruction,
    targetChapter?: ChapterData | null
  ) => {
    if (!projectId || !selectedProvider || !assistantContent || isPlanningEdit) return

    const drafts = extractAgentDrafts(assistantContent)
    if (drafts.length === 0) return
    const draftContent = drafts.map(draft => draft.content).join('\n\n')
    const target = targetChapter ?? await resolveInstructionTarget(userInstruction)
    if (!target) return

    setIsPlanningEdit(true)
    setPlanStatus('AI 正在判断正文位置...')
    try {
      const result = await window.electronAPI.ai.planChapterEdit({
        providerConfigId: selectedProvider.id,
        chapterTitle: target.title,
        chapterHtml: target.content,
        assistantContent: draftContent,
        userInstruction,
        selectedText: target.id === chapterId ? selectedText : ''
      })

      emitAgentChapterProposal({
        chapterId: target.id,
        html: result.proposedHtml,
        oldHtml: target.content,
        sourceName: result.summary || 'AI 对话编辑计划'
      })
      if (target.id !== chapterId) {
        onChapterSelect(target.id)
      }
      setPlanStatus(result.warnings[0] || result.summary || `已放入「${target.title}」正文区，等待确认`)
    } catch (err) {
      setPlanStatus((err as Error).message || '生成编辑计划失败')
    } finally {
      setIsPlanningEdit(false)
      setTimeout(() => setPlanStatus(null), 5000)
    }
  }

  const handleSend = async () => {
    const content = input.trim()
    if (!content || !projectId || !selectedProvider) return
    const targetChapter = await resolveInstructionTarget(content)
    const contextChapterId = targetChapter?.id ?? chapterId

    let convId = currentConversationId
    if (!convId) {
      const conv = await window.electronAPI.ai.createConversation(
        projectId,
        undefined,
        undefined,
        selectedProvider.id
      )
      addConversation(conv)
      setCurrentConversation(conv.id)
      convId = conv.id
    }

    setInput('')
    const result = await sendMessage(convId, selectedProvider.id, content, undefined, {
      projectId,
      chapterId: contextChapterId,
      currentPanel
    })
    const updatedMessages = await window.electronAPI.ai.getMessages(convId)
    setMessages(updatedMessages)

    if (!result.error && shouldAutoApplyAssistantDraft(content, result)) {
      await applyAssistantDraft(result.content ?? null, content, targetChapter)
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
          <p>添加一个可用的模型配置，就可以围绕章节续写、润色和拆解问题。</p>
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
          <button onClick={startFreshConversation} title="新对话">＋</button>
          <button onClick={() => onOpenSettings('appearance')} title="设置">设置</button>
        </div>
      </div>

      <div className="chat-messages">
        {messages.length === 0 && !isStreaming && (
          <div className="chat-empty-state chat-empty-state-inline">
            <div className="chat-empty-icon">AI</div>
            <h2>与 AI 协作</h2>
            <p>{chapterId ? '围绕当前章节续写、润色、挑刺或设计下一场戏。' : '先聊项目设定、开篇钩子和前三章节奏。'}</p>
          </div>
        )}
        {messages.map(msg => (
          <div key={msg.id} className={`chat-message chat-message-${msg.role}`}>
            <div className="message-meta-row">
              <div className="message-role">{msg.role === 'user' ? '你' : '小漫'}</div>
            </div>
            <div className="message-content">{msg.content}</div>
          </div>
        ))}
        {isStreaming && !streamingContent && (
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
        {(agentActionStatus || planStatus) && (
          <div className="chat-agent-action-status">
            <span className="chat-agent-action-dot" />
            <span>{agentActionStatus || planStatus}</span>
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
            placeholder={chapterId ? '输入要求，AI 会围绕当前章节协助...' : '输入项目构思或开篇要求...'}
            rows={3}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleSend()
              }
            }}
            disabled={isStreaming}
          />
          <div className="chat-input-footer">
            <select
              className="chat-model-select"
              value={selectedProvider?.id ?? ''}
              onChange={e => setSelectedProviderId(e.target.value)}
              disabled={isStreaming}
              title="选择本次对话使用的模型配置"
            >
              {providers.map(provider => (
                <option key={provider.id} value={provider.id}>
                  {provider.name} · {provider.model}
                </option>
              ))}
            </select>
            <button
              className="chat-send-btn"
              onClick={() => void handleSend()}
              disabled={isStreaming || !input.trim() || !projectId}
              title="发送"
            >
              {isStreaming ? '...' : '↑'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

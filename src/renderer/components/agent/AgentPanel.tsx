import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAgentStore } from '../../stores/agent.store'
import { useAIStore } from '../../stores/ai.store'
import { useProjectStore } from '../../stores/project.store'
import { agentOutputToHtml, emitAgentChapterProposal, extractAgentDrafts, type AgentDraft } from '../../lib/agentProposal'
import { normalizeChapterTitle } from '../../../shared/chapterFormat'
import { WRITING_AGENT_DEFINITIONS } from '../../../shared/writingAgents'
import type { AppUIEffect } from '../../../shared/appActions'

interface AgentPanelProps {
  projectId: string | null
  chapterId: string | null
  onChapterSelect: (id: string) => void
  onOpenConfig: () => void
}

export function AgentPanel({ projectId, chapterId, onChapterSelect, onOpenConfig }: AgentPanelProps) {
  const {
    agents,
    workflowEvents,
    isRunning,
    inputContext,
    runtimeInput,
    agentTokenBuffer,
    agentThinkingBuffer,
    completedSnapshots,
    expandedThinking,
    proposalStatus,
    setAgents,
    addWorkflowEvent,
    setRunning,
    setInputContext,
    setRuntimeInput,
    setAgentTokenBuffer,
    setAgentThinkingBuffer,
    setCompletedSnapshots,
    setExpandedThinking,
    setProposalStatus,
    resetRuntimeState,
    resetBuffers
  } = useAgentStore()
  const { providers, setProviders } = useAIStore()
  const { addChapter } = useProjectStore()
  const [isStopping, setIsStopping] = useState(false)
  const [runtimeNotice, setRuntimeNotice] = useState<string | null>(null)
  const runtimeNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const chapterIdRef = useRef<string | null>(chapterId)
  const projectIdRef = useRef<string | null>(projectId)
  const agentNameMapRef = useRef<Record<string, string>>({})
  const chapterToolTouchedRef = useRef(false)
  const workflowRequestSeqRef = useRef(0)
  const completeSeqRef = useRef(0)
  const prevProjectIdRef = useRef<string | null>(null)
  const pendingTokensRef = useRef<Record<string, string>>({})
  const pendingThinkingRef = useRef<Record<string, string>>({})
  const pendingBufferScopeRef = useRef<{ projectId: string | null; runId: number | null } | null>(null)
  const bufferFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentWorkflowRunIdRef = useRef<number | null>(null)
  chapterIdRef.current = chapterId
  projectIdRef.current = projectId

  const clearPendingOutputBuffers = useCallback(() => {
    if (bufferFlushTimerRef.current) clearTimeout(bufferFlushTimerRef.current)
    bufferFlushTimerRef.current = null
    pendingTokensRef.current = {}
    pendingThinkingRef.current = {}
    pendingBufferScopeRef.current = null
  }, [])

  const team = useMemo(() => {
    const order = new Map(WRITING_AGENT_DEFINITIONS.map(definition => [definition.role, definition.order]))
    return agents
      .filter(agent => agent.pipeline_role)
      .slice()
      .sort((a, b) => (order.get(a.pipeline_role!) ?? 999) - (order.get(b.pipeline_role!) ?? 999))
  }, [agents])

  const providerNameById = useMemo(() => {
    return new Map(providers.map(provider => [provider.id, `${provider.name} · ${provider.model}`]))
  }, [providers])

  const agentNameMap = useMemo(() => {
    return Object.fromEntries(team.map(agent => [agent.id, agent.name]))
  }, [team])

  const eventSnapshots = useMemo(() => {
    const map: Record<number, { tokens: string; thinking: string }> = {}
    let seq = 0
    for (let idx = 0; idx < workflowEvents.length; idx++) {
      if (workflowEvents[idx].type === 'agentComplete') {
        map[idx] = completedSnapshots[seq] || { tokens: '', thinking: '' }
        seq++
      }
    }
    return map
  }, [workflowEvents, completedSnapshots])

  const visibleThinkingSnapshots = useMemo(() => {
    const result: Record<number, { tokens: string; thinking: string }> = {}
    for (const [index, snap] of Object.entries(eventSnapshots)) {
      result[Number(index)] = {
        tokens: snap.tokens,
        thinking: formatVisibleThinking(snap.thinking)
      }
    }
    return result
  }, [eventSnapshots])

  useEffect(() => {
    void refreshTeam()
  }, [])

  useEffect(() => {
    chapterIdRef.current = chapterId
  }, [chapterId])

  useEffect(() => {
    projectIdRef.current = projectId
  }, [projectId])

  useEffect(() => {
    agentNameMapRef.current = agentNameMap
  }, [agentNameMap])

  useEffect(() => {
    const flushBuffers = () => {
      if (bufferFlushTimerRef.current) clearTimeout(bufferFlushTimerRef.current)
      bufferFlushTimerRef.current = null
      const scope = pendingBufferScopeRef.current
      if (
        !scope ||
        scope.projectId !== projectIdRef.current ||
        scope.runId !== currentWorkflowRunIdRef.current
      ) {
        clearPendingOutputBuffers()
        return
      }

      const pendingTokens = pendingTokensRef.current
      const pendingThinking = pendingThinkingRef.current
      pendingTokensRef.current = {}
      pendingThinkingRef.current = {}
      pendingBufferScopeRef.current = null
      if (Object.keys(pendingTokens).length > 0) {
        const previous = useAgentStore.getState().agentTokenBuffer
        const next = { ...previous }
        for (const [agentId, text] of Object.entries(pendingTokens)) {
          next[agentId] = (next[agentId] || '') + text
        }
        setAgentTokenBuffer(next)
      }
      if (Object.keys(pendingThinking).length > 0) {
        const previous = useAgentStore.getState().agentThinkingBuffer
        const next = { ...previous }
        for (const [agentId, text] of Object.entries(pendingThinking)) {
          next[agentId] = (next[agentId] || '') + text
        }
        setAgentThinkingBuffer(next)
      }
    }
    const scheduleFlush = () => {
      if (!bufferFlushTimerRef.current) bufferFlushTimerRef.current = setTimeout(flushBuffers, 50)
    }

    const unsubscribe = window.electronAPI.agent.onWorkflowEvent((event) => {
      if (event.projectId && event.projectId !== projectIdRef.current) return

      const eventRunId = event.runId ?? null
      if (event.type === 'agentStart' && eventRunId !== currentWorkflowRunIdRef.current) {
        clearPendingOutputBuffers()
        currentWorkflowRunIdRef.current = eventRunId
      } else if (eventRunId !== null) {
        if (currentWorkflowRunIdRef.current !== null && eventRunId !== currentWorkflowRunIdRef.current) return
        currentWorkflowRunIdRef.current ??= eventRunId
      }

      if (event.type === 'agentToken') {
        const scope = { projectId: projectIdRef.current, runId: currentWorkflowRunIdRef.current }
        const pendingScope = pendingBufferScopeRef.current
        if (pendingScope && (pendingScope.projectId !== scope.projectId || pendingScope.runId !== scope.runId)) {
          clearPendingOutputBuffers()
        }
        pendingBufferScopeRef.current = scope
        const pendingTokens = pendingTokensRef.current
        pendingTokens[event.agentId] = (pendingTokens[event.agentId] || '') + event.token
        scheduleFlush()
        return
      }
      if (event.type === 'agentThinking') {
        const scope = { projectId: projectIdRef.current, runId: currentWorkflowRunIdRef.current }
        const pendingScope = pendingBufferScopeRef.current
        if (pendingScope && (pendingScope.projectId !== scope.projectId || pendingScope.runId !== scope.runId)) {
          clearPendingOutputBuffers()
        }
        pendingBufferScopeRef.current = scope
        const pendingThinking = pendingThinkingRef.current
        pendingThinking[event.agentId] = (pendingThinking[event.agentId] || '') + event.thinking
        scheduleFlush()
        return
      }
      if (event.type === 'agentComplete') flushBuffers()
      addWorkflowEvent(event)
      if (event.type === 'agentStart') {
        const tokenPrev = useAgentStore.getState().agentTokenBuffer
        const thinkPrev = useAgentStore.getState().agentThinkingBuffer
        const expandPrev = useAgentStore.getState().expandedThinking
        setAgentTokenBuffer({ ...tokenPrev, [event.agentId]: '' })
        setAgentThinkingBuffer({ ...thinkPrev, [event.agentId]: '' })
        setExpandedThinking({ ...expandPrev, [event.agentId]: true })
      }
      if (event.type === 'agentComplete') {
        const snapIdx = completeSeqRef.current
        completeSeqRef.current += 1
        const storeState = useAgentStore.getState()
        const snapPrev = useAgentStore.getState().completedSnapshots
        setCompletedSnapshots({
          ...snapPrev,
          [snapIdx]: {
            tokens: storeState.agentTokenBuffer[event.agentId] || '',
            thinking: storeState.agentThinkingBuffer[event.agentId] || ''
          }
        })
        applyToolUIEffects(event.result.toolCalls.flatMap(tc => tc.uiEffects ?? []))
        if (event.result.toolCalls.some(tc => (tc.tool === 'create_chapter' || tc.tool === 'write_chapter') && tc.ok !== false)) {
          chapterToolTouchedRef.current = true
        }
      }
      if (event.type === 'workflowComplete' || event.type === 'error') {
        setRunning(false)
        setIsStopping(false)
      }
      if (event.type === 'workflowComplete') {
        if (event.summary === '工作流已停止。可以重新启动新的任务。') {
          setProposalStatus('工作流已停止')
          return
        }
        if (chapterToolTouchedRef.current) {
          setProposalStatus('章节已由固定写作团队写入，并完成记忆回写')
          return
        }
        // 不再自动把"最长的输出"塞进当前选中章节——目标章节可能根本不是
        // 当前章节，误放正文比不放危害更大。留给用户手动"应用到正文"。
        setProposalStatus('流水线完成但未写入章节。可在上方各岗位输出中手动「应用到正文」')
      }
    })
    return () => {
      unsubscribe()
      clearPendingOutputBuffers()
    }
  }, [
    addWorkflowEvent,
    clearPendingOutputBuffers,
    setAgentThinkingBuffer,
    setAgentTokenBuffer,
    setCompletedSnapshots,
    setExpandedThinking,
    setProposalStatus,
    setRunning
  ])

  useEffect(() => {
    const unsubscribe = window.electronAPI.agent.onChapterCreated((chapter) => {
      if (chapter.project_id !== projectIdRef.current) return
      addChapter(chapter)
      if (!chapterIdRef.current) {
        chapterIdRef.current = chapter.id
        onChapterSelect(chapter.id)
      }
    })
    return unsubscribe
  }, [addChapter, onChapterSelect])

  useEffect(() => {
    if (prevProjectIdRef.current !== null && prevProjectIdRef.current !== projectId) {
      clearPendingOutputBuffers()
      currentWorkflowRunIdRef.current = null
      workflowRequestSeqRef.current += 1
      if (useAgentStore.getState().isRunning) {
        void window.electronAPI.agent.stopWorkflow()
      }
      resetRuntimeState()
      chapterToolTouchedRef.current = false
      completeSeqRef.current = 0
    }
    prevProjectIdRef.current = projectId
  }, [clearPendingOutputBuffers, projectId, resetRuntimeState])

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [workflowEvents, agentTokenBuffer, agentThinkingBuffer])

  const refreshTeam = async () => {
    const [teamRows, providerRows] = await Promise.all([
      window.electronAPI.agent.getWritingTeam(),
      window.electronAPI.ai.listProviders()
    ])
    setAgents(teamRows)
    setProviders(providerRows)
  }

  const runWorkflow = async () => {
    if (!projectId || !inputContext.trim()) return
    const requestSeq = ++workflowRequestSeqRef.current
    clearPendingOutputBuffers()
    currentWorkflowRunIdRef.current = null
    resetBuffers()
    chapterToolTouchedRef.current = false
    completeSeqRef.current = 0
    setRuntimeInput('')
    setIsStopping(false)
    setRunning(true)
    try {
      const result = await window.electronAPI.agent.runWritingWorkflow(projectId, inputContext, chapterIdRef.current)
      if (workflowRequestSeqRef.current !== requestSeq) return
      if (!result.ok) {
        addWorkflowEvent({ type: 'error', message: result.message || '固定写作团队启动失败' })
        setRunning(false)
        setIsStopping(false)
      }
    } catch (err) {
      if (workflowRequestSeqRef.current !== requestSeq) return
      addWorkflowEvent({ type: 'error', message: (err as Error).message || '固定写作团队启动失败' })
      setRunning(false)
      setIsStopping(false)
    }
  }

  const stopWorkflow = async () => {
    if (isStopping) return
    workflowRequestSeqRef.current += 1
    setIsStopping(true)
    setProposalStatus('正在停止工作流...')
    try {
      const result = await window.electronAPI.agent.stopWorkflow()
      setRunning(false)
      setProposalStatus(result.ok ? '工作流已停止' : (result.message || '停止工作流失败'))
      if (!result.ok) {
        addWorkflowEvent({ type: 'error', message: result.message || '停止工作流失败' })
      }
    } catch (err) {
      addWorkflowEvent({ type: 'error', message: (err as Error).message || '停止工作流失败' })
    } finally {
      setIsStopping(false)
    }
  }

  const sendRuntimeMessage = async () => {
    if (isStopping || !runtimeInput.trim()) return
    const msg = runtimeInput.trim()
    setRuntimeInput('')
    const result = await window.electronAPI.agent.sendWorkflowMessage(msg)
    if (!result.ok) {
      addWorkflowEvent({ type: 'error', message: result.message || '发送运行中指令失败' })
      return
    }
    // 注入指令在下一个岗位开始时才被消费，明确告知生效点，避免用户以为立即生效
    if (runtimeNoticeTimerRef.current) clearTimeout(runtimeNoticeTimerRef.current)
    setRuntimeNotice('指令已加入队列，将从下一个岗位开始生效（正在输出的岗位本轮不受影响）')
    runtimeNoticeTimerRef.current = setTimeout(() => {
      runtimeNoticeTimerRef.current = null
      setRuntimeNotice(null)
    }, 8000)
  }

  useEffect(() => {
    return () => {
      if (runtimeNoticeTimerRef.current) clearTimeout(runtimeNoticeTimerRef.current)
    }
  }, [])

  const handleClearContext = () => {
    if (isRunning) {
      if (!confirm('固定写作团队正在运行中，清除上下文将停止当前工作流。确定要继续吗？')) return
      void stopWorkflow()
    }

    resetRuntimeState()
    clearPendingOutputBuffers()
    currentWorkflowRunIdRef.current = null
    chapterToolTouchedRef.current = false
    completeSeqRef.current = 0
    workflowRequestSeqRef.current += 1
  }

  const ensureTargetChapter = async (draft: AgentDraft, expectedProjectId: string): Promise<string | null> => {
    if (projectIdRef.current !== expectedProjectId) return null
    if (chapterIdRef.current) return chapterIdRef.current

    const created = await window.electronAPI.file.createChapter({
      projectId: expectedProjectId,
      title: normalizeChapterTitle(draft.title, 'AI 生成章节')
    })
    if (projectIdRef.current !== expectedProjectId || created.project_id !== expectedProjectId) return null
    addChapter(created)
    onChapterSelect(created.id)
    chapterIdRef.current = created.id
    return created.id
  }

  const applyDrafts = async (agentId: string, drafts: AgentDraft[]) => {
    if (drafts.length === 0) {
      setProposalStatus('未识别到可放入正文的章节正文')
      return
    }

    const activeProjectId = projectIdRef.current
    if (drafts.length > 1 && activeProjectId) {
      let firstCreatedId: string | null = null
      for (const draft of drafts) {
        const created = await window.electronAPI.file.createChapter({
          projectId: activeProjectId,
          title: normalizeChapterTitle(draft.title, 'AI 生成章节'),
          content: agentOutputToHtml(draft.content)
        })
        if (projectIdRef.current !== activeProjectId || created.project_id !== activeProjectId) return
        firstCreatedId ??= created.id
        addChapter(created)
      }
      if (projectIdRef.current !== activeProjectId) return
      if (firstCreatedId) onChapterSelect(firstCreatedId)
      setProposalStatus(`已自动创建 ${drafts.length} 个章节`)
      return
    }

    const draft = drafts[0]
    if (!activeProjectId) return
    const targetChapterId = await ensureTargetChapter(draft, activeProjectId)
    if (projectIdRef.current !== activeProjectId) return
    if (!targetChapterId) {
      setProposalStatus('请先选择或创建一个项目')
      return
    }

    const sourceName = agentNameMapRef.current[agentId] || agentId
    emitAgentChapterProposal({
      chapterId: targetChapterId,
      html: agentOutputToHtml(draft.content),
      sourceName
    })
    setProposalStatus('已放入正文，等待确认')
  }

  return (
    <div className="agent-panel">
      <div className="panel-header">
        <h3>固定写作团队</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          {(workflowEvents.length > 0 || isRunning) && (
            <button
              onClick={handleClearContext}
              title="清除上下文，开始新任务"
              style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)', fontSize: 13 }}
            >
              清除
            </button>
          )}
          <button onClick={onOpenConfig} title="配置各岗位模型">设置</button>
        </div>
      </div>

      {!projectId ? (
        <div className="agent-empty">
          <p>打开项目后，固定写作团队会按单章流水线协作写作。</p>
        </div>
      ) : (
        <>
          <div className="agent-members" style={{ padding: '12px 16px 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4 style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>默认岗位</h4>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>不可切换 · 单章流水线</span>
            </div>
            {team.map(agent => (
              <div key={agent.id} className="agent-member-card" style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) auto',
                gap: 8,
                alignItems: 'center',
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-color)'
              }}>
                <div style={{ minWidth: 0 }}>
                  <span className="member-name" style={{ fontWeight: 700 }}>{agent.name}</span>
                  <span className="member-role" style={{ fontSize: 11, marginLeft: 8 }}>{agent.role}</span>
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {providerNameById.get(agent.provider_config_id || agent.model) || '未绑定模型'}
                </span>
              </div>
            ))}
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
              Chapter Orchestrator 会固定调度这 9 个岗位，并维护 Story Bible、Timeline、角色卡和伏笔账本。
            </div>
          </div>

          <div className="agent-workflow-input" style={{ padding: '12px 16px 0' }}>
            {!isRunning ? (
              <>
                <textarea
                  value={inputContext}
                  onChange={e => setInputContext(e.target.value)}
                  placeholder="输入本章意图 / 修改要求。也可以写：自动写下一章，目标2500字，结尾留钩子。"
                  rows={3}
                  disabled={isRunning}
                />
                <button onClick={runWorkflow} disabled={isRunning || !inputContext.trim() || providers.length === 0}>
                  启动固定写作团队
                </button>
                {providers.length === 0 && (
                  <div style={{ marginTop: 8, color: 'var(--accent-danger)', fontSize: 12 }}>
                    请先在设置里添加模型配置。
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="workflow-runtime-controls">
                  <button className="stop-workflow-btn" onClick={stopWorkflow} disabled={isStopping}>
                    {isStopping ? '正在停止...' : '停止工作流'}
                  </button>
                  <span className="runtime-status">{isStopping ? '正在停止...' : '运行中...'}</span>
                </div>
                {runtimeNotice && (
                  <div style={{ fontSize: 11, color: 'var(--accent-primary)', margin: '6px 0', lineHeight: 1.5 }}>
                    {runtimeNotice}
                  </div>
                )}
                <div className="runtime-message-area">
                  <textarea
                    value={runtimeInput}
                    onChange={e => setRuntimeInput(e.target.value)}
                    placeholder="发送新指令引导当前章节方向，例如：结尾反转更冷一点。"
                    rows={2}
                    disabled={isStopping}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !isStopping) {
                        e.preventDefault()
                        void sendRuntimeMessage()
                      }
                    }}
                  />
                  <button
                    onClick={() => void sendRuntimeMessage()}
                    disabled={isStopping || !runtimeInput.trim()}
                    className="send-runtime-msg-btn"
                  >
                    发送
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="agent-workflow-log" ref={logRef} style={{ padding: '12px 16px', flex: 1, overflowY: 'auto' }}>
            {workflowEvents.map((event, i) => {
              if (event.type === 'agentToken' || event.type === 'agentThinking') return null

              const snap = visibleThinkingSnapshots[i] || null
              const outputText = event.type === 'agentComplete'
                ? (event.result.content || snap?.tokens || '')
                : ''
              const outputDrafts = event.type === 'agentComplete' ? extractAgentDrafts(outputText) : []
              const outputBlockReason = event.type === 'agentComplete'
                ? getDraftOutputBlockReason(event.result.quality, outputText, outputDrafts.length)
                : null

              return (
                <div key={i} className={`workflow-event workflow-${event.type}`}>
                  {event.type === 'agentStart' && (
                    <div style={{ padding: '10px 0 4px', borderTop: '1px solid var(--border-color)' }}>
                      <span style={{ fontWeight: 600, color: 'var(--accent-primary)' }}>
                        {event.agentName} 开始工作
                      </span>
                    </div>
                  )}

                  {event.type === 'agentComplete' && (
                    <div className="agent-output-block">
                      <div style={{ fontWeight: 600, color: 'var(--accent-success)', marginBottom: 6 }}>
                        {agentNameMap[event.agentId] || event.agentId} 完成
                        {event.result.toolCalls.length > 0 && (
                          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>
                            调用了 {event.result.toolCalls.length} 个工具
                          </span>
                        )}
                      </div>

                      <div className="agent-output-actions">
                        {outputDrafts.length > 0 ? (
                          <button
                            className="agent-apply-output-btn"
                            onClick={() => void applyDrafts(event.agentId, outputDrafts)}
                            title="自动识别这段输出中的正文并放入正文区"
                          >
                            应用到正文
                          </button>
                        ) : outputBlockReason ? (
                          <span className="agent-output-guard" title={outputBlockReason}>
                            未通过正文检查
                          </span>
                        ) : null}
                      </div>

                      {snap?.thinking && (
                        <div className="thinking-block">
                          <div
                            className="thinking-header"
                            onClick={() => {
                              const prev = useAgentStore.getState().expandedThinking
                              setExpandedThinking({
                                ...prev,
                                [event.agentId]: !prev[event.agentId]
                              })
                            }}
                          >
                            <span>{expandedThinking[event.agentId] !== false ? '展开中' : '已折叠'}</span>
                            <span>思考过程</span>
                            <span className="thinking-chars">{snap.thinking.length} 字符</span>
                          </div>
                          {(expandedThinking[event.agentId] !== false) && (
                            <div className="thinking-content">{snap.thinking}</div>
                          )}
                        </div>
                      )}

                      <div className="agent-output-content">
                        {formatVisibleAgentOutput(outputText) || '(无输出)'}
                      </div>

                      {event.result.toolCalls.map((tc, ti) => (
                        <div key={ti} className="tool-call-block">
                          <div className="tool-call-header">
                            工具调用: <strong>{tc.tool}</strong>
                            <span style={{
                              marginLeft: 8,
                              fontSize: 11,
                              color: tc.ok === false ? 'var(--accent-danger)' : 'var(--accent-success)'
                            }}>
                              {tc.ok === false ? '失败' : '成功'}
                            </span>
                          </div>
                          <div className="tool-call-input">输入: {tc.input.slice(0, 200)}</div>
                          <div className="tool-call-output">{tc.output.slice(0, 500)}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {event.type === 'roundComplete' && (
                    <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 11, padding: '8px 0' }}>
                      第 {event.round + 1} 步完成
                    </div>
                  )}

                  {event.type === 'workflowComplete' && (
                    <div style={{ padding: '12px', background: 'rgba(72,187,120,0.1)', borderRadius: 'var(--radius)', marginTop: 8 }}>
                      <div style={{ fontWeight: 600, color: 'var(--accent-success)', marginBottom: 4 }}>工作流完成</div>
                      {proposalStatus && <div className="agent-proposal-status">{proposalStatus}</div>}
                      {event.summary && <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{event.summary}</div>}
                    </div>
                  )}

                  {event.type === 'error' && (
                    <div style={{ padding: '8px 12px', background: 'rgba(252,129,129,0.1)', borderRadius: 'var(--radius)', color: 'var(--accent-danger)', fontSize: 12 }}>
                      {event.message}
                    </div>
                  )}
                </div>
              )
            })}

            {isRunning && Object.keys(agentTokenBuffer).length > 0 && (
              <div className="live-stream-section">
                {Object.entries(agentTokenBuffer).map(([agentId, tokens]) => (
                  <div key={agentId} className="live-agent-block">
                    <div className="live-agent-label">
                      {agentNameMap[agentId] || agentId} 输出中...
                    </div>
                    {formatVisibleThinking(agentThinkingBuffer[agentId]) && (
                      <div className="thinking-block live">
                        <div
                          className="thinking-header"
                          onClick={() => {
                            const prev = useAgentStore.getState().expandedThinking
                            setExpandedThinking({
                              ...prev,
                              [agentId]: !prev[agentId]
                            })
                          }}
                        >
                          <span>正在思考... ({formatVisibleThinking(agentThinkingBuffer[agentId]).length} 字符)</span>
                        </div>
                        {(expandedThinking[agentId] !== false) && (
                          <div className="thinking-content streaming">
                            {formatVisibleThinking(agentThinkingBuffer[agentId])}
                          </div>
                        )}
                      </div>
                    )}
                    {tokens && (
                      <div className="agent-output-content streaming">{formatVisibleAgentOutput(tokens)}</div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {isRunning && workflowEvents.length === 0 && (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: 20 }}>
                等待固定写作团队响应...
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function applyToolUIEffects(effects: AppUIEffect[]): void {
  for (const effect of effects) {
    window.dispatchEvent(new CustomEvent('noval:agent-ui-effect', { detail: effect }))
  }
}

function formatVisibleAgentOutput(content: string): string {
  const cleaned = content
    .replace(/\[\s*TOOL\s*:\s*[\w-]+\s*\]\s*[\s\S]*?\[\s*\/\s*TOOL\s*\]/gi, '\n正在调用工具...\n')
    .replace(/\[\s*TOOL\s*:\s*[\w-]*\s*\][\s\S]*$/i, '\n正在调用工具...\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return cleaned || (/\[\s*TOOL\s*:/i.test(content) ? '正在调用工具...' : '')
}

function formatVisibleThinking(content: string): string {
  const cleaned = formatVisibleAgentOutput(content || '')
  if (!cleaned) return ''

  const statusLines = cleaned
    .split(/\n+/)
    .map(line => line.trim())
    .filter(line => /^\[(质量监控|交付保护|调度保护|入库确认|警告|上下文压缩|用户注入指令|工具调用|工具结果|运行保护)\]/.test(line))

  if (hasLongUnpunctuatedChineseRun(cleaned)) {
    return [...statusLines, '模型正在思考，原始推理内容已折叠。'].filter(Boolean).join('\n')
  }

  return cleaned
}

function hasLongUnpunctuatedChineseRun(content: string): boolean {
  const runs = content
    .split(/[，。！？；：、,.!?;:…—\-\n\r\t\s"“”'‘’（）()《》<>【】\[\]]+/)
    .map(segment => segment.match(/[\u3400-\u9fff]/g)?.length ?? 0)
  return Math.max(0, ...runs) >= 52
}

function getDraftOutputBlockReason(
  quality: { hallucinationRisk: 'low' | 'medium' | 'high'; issues: string[]; tokenCount: number } | undefined,
  content: string,
  draftCount: number
): string | null {
  if (draftCount > 0) return null
  const issues = quality?.issues ?? []
  const blockingIssue = issues.find(issue =>
    /中文标点密度异常|输出重复退化|工作总结|章节工具调用失败|没有对应章节工具调用/.test(issue)
  )
  if (blockingIssue) return blockingIssue
  if (hasLongUnpunctuatedChineseRun(content)) return '存在过长无标点中文段落'
  return null
}

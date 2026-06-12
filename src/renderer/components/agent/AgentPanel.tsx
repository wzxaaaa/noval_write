import React, { useState, useEffect, useRef, useMemo } from 'react'
import { useAgentStore } from '../../stores/agent.store'
import { useProjectStore } from '../../stores/project.store'
import { agentOutputToHtml, emitAgentChapterProposal, extractAgentDrafts, type AgentDraft } from '../../lib/agentProposal'
import { normalizeChapterTitle } from '../../../shared/chapterFormat'
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
    groups,
    groupMembers,
    workflowEvents,
    isRunning,
    inputContext,
    runtimeInput,
    selectedGroupId,
    agentTokenBuffer,
    agentThinkingBuffer,
    completedSnapshots,
    expandedThinking,
    proposalStatus,
    setAgents,
    setGroups,
    setGroupMembers,
    addWorkflowEvent,
    clearWorkflowEvents,
    setRunning,
    setInputContext,
    setRuntimeInput,
    setSelectedGroupId,
    setAgentTokenBuffer,
    setAgentThinkingBuffer,
    setCompletedSnapshots,
    setExpandedThinking,
    setProposalStatus,
    resetRuntimeState,
    resetBuffers
  } = useAgentStore()
  const { addChapter } = useProjectStore()
  const logRef = useRef<HTMLDivElement>(null)
  const chapterIdRef = useRef<string | null>(chapterId)
  const agentNameMapRef = useRef<Record<string, string>>({})
  const latestCompletedOutputRef = useRef<{ agentId: string; content: string } | null>(null)
  const bestDraftRef = useRef<{ agentId: string; drafts: AgentDraft[]; score: number } | null>(null)
  const chapterToolTouchedRef = useRef(false)
  const workflowRequestSeqRef = useRef(0)

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
  const completeSeqRef = useRef(0)
  const prevProjectIdRef = useRef<string | null>(null)

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
    window.electronAPI.agent.list().then(setAgents)
    if (projectId) {
      window.electronAPI.agent.listGroups(projectId).then(setGroups)
    }
  }, [projectId])

  useEffect(() => {
    const handleBindingChange = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string }>).detail
      if (projectId && detail.projectId === projectId) {
        window.electronAPI.agent.listGroups(projectId).then(setGroups)
      }
    }
    window.addEventListener('noval:project-agent-group-changed', handleBindingChange)
    return () => window.removeEventListener('noval:project-agent-group-changed', handleBindingChange)
  }, [projectId, setGroups])

  useEffect(() => {
    chapterIdRef.current = chapterId
  }, [chapterId])

  useEffect(() => {
    const unsubscribe = window.electronAPI.agent.onWorkflowEvent((event) => {
      addWorkflowEvent(event)

      if (event.type === 'agentToken') {
        const prev = useAgentStore.getState().agentTokenBuffer
        setAgentTokenBuffer({
          ...prev,
          [event.agentId]: (prev[event.agentId] || '') + event.token
        })
      }
      if (event.type === 'agentThinking') {
        const prev = useAgentStore.getState().agentThinkingBuffer
        setAgentThinkingBuffer({
          ...prev,
          [event.agentId]: (prev[event.agentId] || '') + event.thinking
        })
      }
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
        latestCompletedOutputRef.current = { agentId: event.agentId, content: event.result.content }
        applyToolUIEffects(event.result.toolCalls.flatMap(tc => tc.uiEffects ?? []))
        if (event.result.toolCalls.some(tc => (tc.tool === 'create_chapter' || tc.tool === 'write_chapter') && tc.ok !== false)) {
          chapterToolTouchedRef.current = true
        }
        rememberDraftCandidate(event.agentId, event.result.content || storeState.agentTokenBuffer[event.agentId] || '')
      }
      if (event.type === 'workflowComplete' || event.type === 'error') {
        setRunning(false)
      }
      if (event.type === 'workflowComplete') {
        if (event.summary === '工作流已停止。可以重新启动新的任务。') {
          setProposalStatus('工作流已停止')
          return
        }
        if (chapterToolTouchedRef.current) {
          setProposalStatus('章节已由 Agent 工具写入，已跳过重复自动创建')
          return
        }
        const candidate = bestDraftRef.current ?? (
          latestCompletedOutputRef.current
            ? {
                agentId: latestCompletedOutputRef.current.agentId,
                drafts: extractAgentDrafts(latestCompletedOutputRef.current.content),
                score: latestCompletedOutputRef.current.content.length
              }
            : null
        )
        if (candidate && candidate.drafts.length > 0) {
          void applyDrafts(candidate.agentId, candidate.drafts, true)
        } else {
          setProposalStatus('未识别到可放入正文的章节正文')
        }
      }
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribe = window.electronAPI.agent.onChapterCreated((chapter) => {
      addChapter(chapter)
      if (!chapterIdRef.current) {
        chapterIdRef.current = chapter.id
        onChapterSelect(chapter.id)
      }
    })
    return unsubscribe
  }, [addChapter, onChapterSelect])

  useEffect(() => {
    if (selectedGroupId) {
      window.electronAPI.agent.getGroupMembers(selectedGroupId).then(members => {
        setGroupMembers(selectedGroupId, members)
      })
    }
  }, [selectedGroupId])

  useEffect(() => {
    if (prevProjectIdRef.current !== null && prevProjectIdRef.current !== projectId) {
      if (useAgentStore.getState().isRunning) {
        void window.electronAPI.agent.stopWorkflow()
      }
      resetRuntimeState()
      latestCompletedOutputRef.current = null
      bestDraftRef.current = null
      chapterToolTouchedRef.current = false
      completeSeqRef.current = 0
    }
    prevProjectIdRef.current = projectId
  }, [projectId])

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [workflowEvents, agentTokenBuffer, agentThinkingBuffer])

  const runWorkflow = async () => {
    if (!selectedGroupId || !projectId || !inputContext.trim()) return
    const requestSeq = ++workflowRequestSeqRef.current
    resetBuffers()
    latestCompletedOutputRef.current = null
    bestDraftRef.current = null
    chapterToolTouchedRef.current = false
    completeSeqRef.current = 0
    setRuntimeInput('')
    setRunning(true)
    try {
      const result = await window.electronAPI.agent.runWorkflow(selectedGroupId, projectId, inputContext)
      if (workflowRequestSeqRef.current !== requestSeq) return
      if (!result.ok) {
        addWorkflowEvent({ type: 'error', message: result.message || '工作流启动失败' })
        setRunning(false)
      }
    } catch (err) {
      if (workflowRequestSeqRef.current !== requestSeq) return
      addWorkflowEvent({ type: 'error', message: (err as Error).message || '工作流启动失败' })
      setRunning(false)
    }
  }

  const stopWorkflow = async () => {
    workflowRequestSeqRef.current += 1
    const result = await window.electronAPI.agent.stopWorkflow()
    if (result.ok) {
      setRunning(false)
    } else {
      addWorkflowEvent({ type: 'error', message: result.message || '停止工作流失败' })
    }
  }

  const sendRuntimeMessage = async () => {
    if (!runtimeInput.trim()) return
    const msg = runtimeInput.trim()
    setRuntimeInput('')
    const result = await window.electronAPI.agent.sendWorkflowMessage(msg)
    if (!result.ok) {
      addWorkflowEvent({ type: 'error', message: result.message || '发送运行中指令失败' })
    }
  }

  const handleClearContext = () => {
    if (isRunning) {
      if (!confirm('工作流正在运行中，清除上下文将停止当前工作流。确定要继续吗？')) {
        return
      }
      void stopWorkflow()
    }

    resetRuntimeState()
    latestCompletedOutputRef.current = null
    bestDraftRef.current = null
    chapterToolTouchedRef.current = false
    completeSeqRef.current = 0
    workflowRequestSeqRef.current += 1
  }

  const selectedGroup = groups.find(g => g.id === selectedGroupId)
  const currentMembers = selectedGroupId ? (groupMembers[selectedGroupId] || []) : []
  const moderator = currentMembers.find(m => m.is_moderator === 1)

  const agentNameMap: Record<string, string> = {}
  currentMembers.forEach(m => { agentNameMap[m.agent_id] = m.name })

  useEffect(() => {
    agentNameMapRef.current = agentNameMap
  }, [currentMembers])

  const rememberDraftCandidate = (agentId: string, content: string) => {
    const drafts = extractAgentDrafts(content)
    if (drafts.length === 0) return

    const score = drafts.reduce((sum, draft) => sum + draft.content.length, 0) + drafts.length * 1000
    if (!bestDraftRef.current || score > bestDraftRef.current.score) {
      bestDraftRef.current = { agentId, drafts, score }
    }
  }

  const ensureTargetChapter = async (draft: AgentDraft): Promise<string | null> => {
    if (chapterIdRef.current) return chapterIdRef.current
    if (!projectId) return null

    const created = await window.electronAPI.file.createChapter({
      projectId,
      title: normalizeChapterTitle(draft.title, 'AI 生成章节')
    })
    addChapter(created)
    onChapterSelect(created.id)
    chapterIdRef.current = created.id
    return created.id
  }

  const applyDrafts = async (agentId: string, drafts: AgentDraft[], automatic = false) => {
    if (drafts.length === 0) {
      setProposalStatus('未识别到可放入正文的章节正文')
      return
    }

    if (drafts.length > 1 && projectId) {
      let firstCreatedId: string | null = null
      for (const draft of drafts) {
        const created = await window.electronAPI.file.createChapter({
          projectId,
          title: normalizeChapterTitle(draft.title, 'AI 生成章节'),
          content: agentOutputToHtml(draft.content)
        })
        firstCreatedId ??= created.id
        addChapter(created)
      }
      if (firstCreatedId) onChapterSelect(firstCreatedId)
      setProposalStatus(`已自动创建 ${drafts.length} 个章节`)
      return
    }

    const draft = drafts[0]
    const targetChapterId = await ensureTargetChapter(draft)
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
    setProposalStatus(automatic ? '已自动放入正文，等待确认' : '已放入正文，等待确认')
  }

  return (
    <div className="agent-panel">
      <div className="panel-header">
        <h3>Agent 协作</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          {(workflowEvents.length > 0 || isRunning) && (
            <button
              onClick={handleClearContext}
              title="清除上下文，开始新对话"
              style={{
                background: 'var(--bg-hover)',
                color: 'var(--text-secondary)',
                fontSize: 13
              }}
            >
              🗑️ 清除
            </button>
          )}
          <button onClick={onOpenConfig} title="管理 Agent">+</button>
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="agent-empty">
          <p>没有 Agent 组</p>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            提示: 需要先创建 Agent，再创建 Agent 组并添加成员
          </p>
          <button onClick={onOpenConfig}>管理 Agent 和组</button>
        </div>
      ) : (
        <>
          <div className="agent-group-select" style={{ padding: '12px 16px 0' }}>
            <select value={selectedGroupId || ''} onChange={e => setSelectedGroupId(e.target.value || null)}>
              <option value="">选择 Agent 组...</option>
              {groups.map(g => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.collaboration_mode === 'moderator' ? '主编模式' : '轮询模式'})
                </option>
              ))}
            </select>
          </div>

          {selectedGroup && (
            <div className="agent-members" style={{ padding: '12px 16px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h4 style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>Agent 成员</h4>
                <span style={{
                  fontSize: 11, padding: '2px 8px', borderRadius: 10,
                  background: selectedGroup.collaboration_mode === 'moderator' ? 'rgba(72,187,120,0.2)' : 'rgba(99,102,241,0.2)',
                  color: selectedGroup.collaboration_mode === 'moderator' ? 'var(--accent-success)' : 'var(--accent-primary)'
                }}>
                  {selectedGroup.collaboration_mode === 'moderator' ? '主编调度模式' : '轮询模式'}
                </span>
              </div>
              {currentMembers.map(m => (
                <div key={m.agent_id} className="agent-member-card" style={{
                  display: 'flex', gap: 8, alignItems: 'center',
                  background: m.is_moderator === 1 ? 'rgba(99,102,241,0.15)' : 'var(--bg-surface)',
                  border: m.is_moderator === 1 ? '1px solid var(--accent-primary)' : '1px solid var(--border-color)'
                }}>
                  <span className="member-name" style={{ fontWeight: m.is_moderator === 1 ? 700 : 500 }}>
                    {m.is_moderator === 1 ? '⭐ ' : ''}{m.name}
                  </span>
                  <span className="member-role" style={{ fontSize: 11 }}>{m.role}</span>
                  {m.is_moderator === 1 && (
                    <span style={{ fontSize: 10, color: 'var(--accent-primary)', marginLeft: 'auto' }}>主编</span>
                  )}
                </div>
              ))}

              {selectedGroup.collaboration_mode === 'moderator' && moderator && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
                  主编 <strong>{moderator.name}</strong> 将接收你的任务，然后调用其他 Agent 协作完成。
                </div>
              )}
            </div>
          )}

          {selectedGroupId && (
            <div className="agent-workflow-input" style={{ padding: '12px 16px 0' }}>
              {!isRunning ? (
                <>
                  <textarea
                    value={inputContext}
                    onChange={e => setInputContext(e.target.value)}
                    placeholder={
                      selectedGroup?.collaboration_mode === 'moderator'
                        ? '输入给主编的指令...'
                        : '输入给 Agent 组的任务描述...'
                    }
                    rows={3}
                    disabled={isRunning}
                  />
                  <button onClick={runWorkflow} disabled={isRunning || !inputContext.trim()}>
                    ▶ 启动工作流
                  </button>
                </>
              ) : (
                <>
                  <div className="workflow-runtime-controls">
                    <button className="stop-workflow-btn" onClick={stopWorkflow}>
                      ⏹ 停止工作流
                    </button>
                    <span className="runtime-status">运行中...</span>
                  </div>
                  <div className="runtime-message-area">
                    <textarea
                      value={runtimeInput}
                      onChange={e => setRuntimeInput(e.target.value)}
                      placeholder="发送新指令引导工作流方向（如：把第三章改成第一人称视角）..."
                      rows={2}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          void sendRuntimeMessage()
                        }
                      }}
                    />
                    <button
                      onClick={() => void sendRuntimeMessage()}
                      disabled={!runtimeInput.trim()}
                      className="send-runtime-msg-btn"
                    >
                      发送
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

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
                        🤖 {event.agentName} 开始工作
                      </span>
                    </div>
                  )}

                  {event.type === 'agentComplete' && (
                    <div className="agent-output-block">
                      <div style={{ fontWeight: 600, color: 'var(--accent-success)', marginBottom: 6 }}>
                        ✅ {agentNameMap[event.agentId] || event.agentId} 完成
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
                            onClick={() => {
                              void applyDrafts(event.agentId, outputDrafts)
                            }}
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

                      {/* Thinking section */}
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
                            <span className="thinking-icon">
                              {expandedThinking[event.agentId] !== false ? '🔽' : '▶️'}
                            </span>
                            <span>💭 思考过程</span>
                            <span className="thinking-chars">
                              {snap.thinking.length} 字符
                            </span>
                          </div>
                          {(expandedThinking[event.agentId] !== false) && (
                            <div className="thinking-content">
                              {snap.thinking}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Output */}
                      <div className="agent-output-content">
                        {formatVisibleAgentOutput(outputText) || '(无输出)'}
                      </div>

                      {/* Tool calls */}
                      {event.result.toolCalls.map((tc, ti) => (
                        <div key={ti} className="tool-call-block">
                          <div className="tool-call-header">
                            🔧 工具调用: <strong>{tc.tool}</strong>
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
                      --- 第 {event.round + 1} 轮 ---
                    </div>
                  )}

                  {event.type === 'workflowComplete' && (
                    <div style={{ padding: '12px', background: 'rgba(72,187,120,0.1)', borderRadius: 'var(--radius)', marginTop: 8 }}>
                      <div style={{ fontWeight: 600, color: 'var(--accent-success)', marginBottom: 4 }}>🎉 工作流完成</div>
                      {proposalStatus && <div className="agent-proposal-status">{proposalStatus}</div>}
                      {event.summary && <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{event.summary}</div>}
                    </div>
                  )}

                  {event.type === 'error' && (
                    <div style={{ padding: '8px 12px', background: 'rgba(252,129,129,0.1)', borderRadius: 'var(--radius)', color: 'var(--accent-danger)', fontSize: 12 }}>
                      ❌ {event.message}
                    </div>
                  )}
                </div>
              )
            })}

            {/* Live streaming during execution */}
            {isRunning && Object.keys(agentTokenBuffer).length > 0 && (
              <div className="live-stream-section">
                {Object.entries(agentTokenBuffer).map(([agentId, tokens]) => (
                  <div key={agentId} className="live-agent-block">
                    <div className="live-agent-label">
                      ⏳ {agentNameMap[agentId] || agentId} 输出中...
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
                          <span>💭 正在思考... ({formatVisibleThinking(agentThinkingBuffer[agentId]).length} 字符)</span>
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
                等待 Agent 响应...
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
    .replace(/\[\s*TOOL\s*:\s*[\w-]+\s*\]\s*[\s\S]*?\[\s*\/\s*TOOL\s*\]/gi, '\n🔧 正在调用工具...\n')
    .replace(/\[\s*TOOL\s*:\s*[\w-]*\s*\][\s\S]*$/i, '\n🔧 正在调用工具...\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return cleaned || (/\[\s*TOOL\s*:/i.test(content) ? '🔧 正在调用工具...' : '')
}

function formatVisibleThinking(content: string): string {
  const cleaned = formatVisibleAgentOutput(content)
  if (!cleaned) return ''

  const statusLines = cleaned
    .split(/\n+/)
    .map(line => line.trim())
    .filter(line => /^\[(质量监控|交付保护|调度保护|入库确认|警告|上下文压缩|用户注入指令|工具调用|工具结果|运行保护)\]/.test(line))

  if (hasLongUnpunctuatedChineseRun(cleaned)) {
    return [
      ...statusLines,
      '模型正在思考，原始推理内容已折叠。'
    ].filter(Boolean).join('\n')
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

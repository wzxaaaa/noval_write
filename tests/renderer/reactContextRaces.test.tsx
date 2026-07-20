import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ChapterData,
  ConversationData,
  MessageData,
  ProviderConfig,
  WorkflowEvent
} from '../../src/preload/types'
import type { AppAgentActionEvent } from '../../src/shared/appActions'
import { ChatPanel } from '../../src/renderer/components/ai/ChatPanel'
import { AgentPanel } from '../../src/renderer/components/agent/AgentPanel'
import { AGENT_CHAPTER_PROPOSAL_EVENT } from '../../src/renderer/lib/agentProposal'
import { isConversationStreaming, useAIStore } from '../../src/renderer/stores/ai.store'
import { useAgentStore } from '../../src/renderer/stores/agent.store'
import { useProjectStore } from '../../src/renderer/stores/project.store'

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value: vi.fn()
})

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const provider: ProviderConfig = {
  id: 'provider-1',
  name: 'Provider',
  provider: 'openai',
  api_key: 'secret',
  base_url: null,
  model: 'model',
  parameters: '{}',
  is_default: 1,
  created_at: '2026-01-01T00:00:00.000Z'
}

function conversation(id: string, projectId: string): ConversationData {
  return {
    id,
    project_id: projectId,
    chapter_id: null,
    title: `${projectId} conversation`,
    provider_config_id: provider.id,
    created_at: '2026-01-01T00:00:00.000Z'
  }
}

function message(id: string, conversationId: string, content: string): MessageData {
  return {
    id,
    conversation_id: conversationId,
    role: 'assistant',
    content,
    token_count: null,
    agent_id: null,
    metadata: '{}',
    created_at: '2026-01-01T00:00:00.000Z'
  }
}

function chapter(id: string, projectId: string): ChapterData {
  return {
    id,
    project_id: projectId,
    parent_id: null,
    title: 'Generated chapter',
    content: '<p>content</p>',
    sort_order: 0,
    word_count: 7,
    status: 'draft',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z'
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('renderer context race guards', () => {
  beforeEach(() => {
    useAIStore.setState({
      providers: [],
      conversations: [],
      messages: [],
      currentConversationId: null,
      streamingContent: '',
      streamingConversations: {}
    })
    useAgentStore.getState().resetRuntimeState()
    useAgentStore.getState().setAgents([])
    useProjectStore.getState().setChapters([])
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('clears chat state on project switch and ignores stale messages and status timers', async () => {
    const projectAMessages = deferred<MessageData[]>()
    const projectBConversations = deferred<ConversationData[]>()
    let actionListener: ((event: AppAgentActionEvent) => void) | null = null

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        ai: {
          listProviders: vi.fn(async () => [provider]),
          listConversations: vi.fn((projectId: string) => (
            projectId === 'project-a'
              ? Promise.resolve([conversation('conversation-a', projectId)])
              : projectBConversations.promise
          )),
          getMessages: vi.fn((conversationId: string) => (
            conversationId === 'conversation-a' ? projectAMessages.promise : Promise.resolve([])
          )),
          onToken: vi.fn(() => () => {}),
          onThinking: vi.fn(() => () => {})
        },
        file: { listChapters: vi.fn(async () => []) },
        appAgent: {
          onAction: vi.fn((listener: (event: AppAgentActionEvent) => void) => {
            actionListener = listener
            return () => { actionListener = null }
          })
        }
      }
    })

    const view = render(
      <ChatPanel
        projectId="project-a"
        chapterId={null}
        currentPanel="chat"
        onOpenSettings={vi.fn()}
        onChapterSelect={vi.fn()}
      />
    )
    await act(flushPromises)
    expect(useAIStore.getState().currentConversationId).toBe('conversation-a')

    act(() => {
      useAIStore.getState().setMessages([message('stale', 'conversation-a', 'stale project A message')])
      useAIStore.getState().appendStreamToken('stale stream')
      useAIStore.getState().setConversationStreaming('conversation-a', true)
    })

    vi.useFakeTimers()
    act(() => {
      actionListener?.({
        projectId: 'project-a',
        conversationId: 'conversation-a',
        status: 'completed',
        action: 'read_chapter',
        message: 'project A status'
      })
      vi.advanceTimersByTime(1000)
    })

    view.rerender(
      <ChatPanel
        projectId="project-b"
        chapterId={null}
        currentPanel="chat"
        onOpenSettings={vi.fn()}
        onChapterSelect={vi.fn()}
      />
    )

    expect(useAIStore.getState()).toMatchObject({
      conversations: [],
      messages: [],
      currentConversationId: null,
      streamingContent: ''
    })
    // 旧会话的流式标记按会话隔离，不再影响新项目的当前会话
    const switchedState = useAIStore.getState()
    expect(isConversationStreaming(switchedState.streamingConversations, switchedState.currentConversationId)).toBe(false)
    expect(view.queryByText('stale project A message')).toBeNull()
    expect(view.queryByText('project A status')).toBeNull()

    await act(async () => {
      projectAMessages.resolve([message('late-a', 'conversation-a', 'late project A message')])
      projectBConversations.resolve([conversation('conversation-b', 'project-b')])
      await flushPromises()
    })
    expect(useAIStore.getState().currentConversationId).toBe('conversation-b')
    expect(view.queryByText('late project A message')).toBeNull()

    act(() => {
      actionListener?.({
        projectId: 'project-b',
        conversationId: 'conversation-b',
        status: 'completed',
        action: 'read_chapter',
        message: 'project B status'
      })
      vi.advanceTimersByTime(2500)
    })
    expect(view.getByText('project B status')).toBeTruthy()
  })

  it('does not let an unresolved send from the old project keep the new project streaming', async () => {
    const projectASend = deferred<{
      content?: string
      conversationId: string
      actionResults: []
    }>()
    const sendMessage = vi.fn((params: { projectId: string; conversationId: string }) => (
      params.projectId === 'project-a'
        ? projectASend.promise
        : Promise.resolve({ content: 'project B reply', conversationId: params.conversationId, actionResults: [] as [] })
    ))

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        ai: {
          listProviders: vi.fn(async () => [provider]),
          listConversations: vi.fn(async (projectId: string) => [conversation(`conversation-${projectId}`, projectId)]),
          getMessages: vi.fn(async () => []),
          onToken: vi.fn(() => () => {}),
          onThinking: vi.fn(() => () => {})
        },
        file: { listChapters: vi.fn(async () => []) },
        appAgent: {
          sendMessage,
          onAction: vi.fn(() => () => {})
        }
      }
    })

    const view = render(
      <ChatPanel
        projectId="project-a"
        chapterId={null}
        currentPanel="chat"
        onOpenSettings={vi.fn()}
        onChapterSelect={vi.fn()}
      />
    )
    await act(flushPromises)

    fireEvent.change(view.container.querySelector('.chat-input-row textarea')!, { target: { value: 'project A request' } })
    fireEvent.click(view.container.querySelector('.chat-send-btn')!)
    await act(flushPromises)
    expect(isConversationStreaming(useAIStore.getState().streamingConversations, 'conversation-project-a')).toBe(true)

    view.rerender(
      <ChatPanel
        projectId="project-b"
        chapterId={null}
        currentPanel="chat"
        onOpenSettings={vi.fn()}
        onChapterSelect={vi.fn()}
      />
    )
    await act(flushPromises)
    // 旧项目未完成的请求只挂在自己的会话上，不影响新项目当前会话
    expect(isConversationStreaming(useAIStore.getState().streamingConversations, 'conversation-project-b')).toBe(false)

    fireEvent.change(view.container.querySelector('.chat-input-row textarea')!, { target: { value: 'project B request' } })
    fireEvent.click(view.container.querySelector('.chat-send-btn')!)
    await act(flushPromises)

    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(isConversationStreaming(useAIStore.getState().streamingConversations, 'conversation-project-b')).toBe(false)
  })

  it('does not apply a Chat draft after its project context changed', async () => {
    const editPlan = deferred<{
      plan: { summary: string; confidence: number; operations: [] }
      proposedText: string
      proposedHtml: string
      summary: string
      appliedOperations: []
      warnings: string[]
    }>()
    const planChapterEdit = vi.fn(() => editPlan.promise)
    const onChapterSelect = vi.fn()
    const proposalListener = vi.fn()
    const projectAChapter = chapter('chapter-a', 'project-a')

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        ai: {
          listProviders: vi.fn(async () => [provider]),
          listConversations: vi.fn(async (projectId: string) => (
            projectId === 'project-a' ? [conversation('conversation-a', projectId)] : []
          )),
          getMessages: vi.fn(async () => []),
          planChapterEdit,
          onToken: vi.fn(() => () => {}),
          onThinking: vi.fn(() => () => {})
        },
        file: {
          listChapters: vi.fn(async (projectId: string) => (
            projectId === 'project-a' ? [projectAChapter] : []
          ))
        },
        appAgent: {
          sendMessage: vi.fn(async (params: { conversationId: string }) => ({
            conversationId: params.conversationId,
            content: '暴雨越过空城，写作者推开了那扇锁住多年的门。门后没有灯，只有脚步声一步步逼近。'.repeat(3),
            actionResults: []
          })),
          onAction: vi.fn(() => () => {})
        }
      }
    })
    window.addEventListener(AGENT_CHAPTER_PROPOSAL_EVENT, proposalListener)

    const view = render(
      <ChatPanel
        projectId="project-a"
        chapterId="chapter-a"
        currentPanel="chat"
        onOpenSettings={vi.fn()}
        onChapterSelect={onChapterSelect}
      />
    )
    await act(flushPromises)
    fireEvent.change(view.container.querySelector('.chat-input-row textarea')!, { target: { value: '续写当前章' } })
    fireEvent.click(view.container.querySelector('.chat-send-btn')!)
    await act(flushPromises)
    expect(planChapterEdit).toHaveBeenCalledTimes(1)

    view.rerender(
      <ChatPanel
        projectId="project-b"
        chapterId={null}
        currentPanel="chat"
        onOpenSettings={vi.fn()}
        onChapterSelect={onChapterSelect}
      />
    )
    await act(async () => {
      editPlan.resolve({
        plan: { summary: 'rewrite', confidence: 1, operations: [] },
        proposedText: 'new text',
        proposedHtml: '<p>new text</p>',
        summary: 'rewrite',
        appliedOperations: [],
        warnings: []
      })
      await flushPromises()
    })

    expect(proposalListener).not.toHaveBeenCalled()
    expect(onChapterSelect).not.toHaveBeenCalled()
    window.removeEventListener(AGENT_CHAPTER_PROPOSAL_EVENT, proposalListener)
  })

  it('drops pending Agent token buffers when the project or run changes', async () => {
    let workflowListener: ((event: WorkflowEvent) => void) | null = null
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        ai: { listProviders: vi.fn(async () => [provider]) },
        file: { createChapter: vi.fn() },
        agent: {
          getWritingTeam: vi.fn(async () => []),
          onWorkflowEvent: vi.fn((listener: (event: WorkflowEvent) => void) => {
            workflowListener = listener
            return () => { workflowListener = null }
          }),
          onChapterCreated: vi.fn(() => () => {}),
          stopWorkflow: vi.fn(async () => ({ ok: true }))
        }
      }
    })

    vi.useFakeTimers()
    const view = render(
      <AgentPanel projectId="project-a" chapterId={null} onChapterSelect={vi.fn()} onOpenConfig={vi.fn()} />
    )
    await act(flushPromises)

    act(() => {
      workflowListener?.({ type: 'agentStart', agentId: 'writer', agentName: 'Writer', projectId: 'project-a', runId: 1 })
      workflowListener?.({ type: 'agentToken', agentId: 'writer', token: 'old run', projectId: 'project-a', runId: 1 })
      workflowListener?.({ type: 'agentStart', agentId: 'writer', agentName: 'Writer', projectId: 'project-a', runId: 2 })
      workflowListener?.({ type: 'agentToken', agentId: 'writer', token: 'new run', projectId: 'project-a', runId: 2 })
      workflowListener?.({
        type: 'agentComplete',
        agentId: 'writer',
        result: { agentId: 'writer', content: '', toolCalls: [] },
        projectId: 'project-a',
        runId: 2
      })
    })
    expect(useAgentStore.getState().agentTokenBuffer.writer).toBe('new run')

    act(() => vi.advanceTimersByTime(50))
    expect(useAgentStore.getState().agentTokenBuffer.writer).toBe('new run')

    act(() => {
      workflowListener?.({ type: 'agentToken', agentId: 'writer', token: 'stale project', projectId: 'project-a', runId: 2 })
    })
    view.rerender(
      <AgentPanel projectId="project-b" chapterId={null} onChapterSelect={vi.fn()} onOpenConfig={vi.fn()} />
    )
    act(() => vi.advanceTimersByTime(50))
    expect(useAgentStore.getState().agentTokenBuffer).toEqual({})
  })

  it('does not add or select a chapter created after the Agent project changed', async () => {
    const chapterCreation = deferred<ChapterData>()
    const createChapter = vi.fn(() => chapterCreation.promise)
    const onChapterSelect = vi.fn()
    let workflowListener: ((event: WorkflowEvent) => void) | null = null

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        ai: { listProviders: vi.fn(async () => [provider]) },
        file: { createChapter },
        agent: {
          getWritingTeam: vi.fn(async () => []),
          onWorkflowEvent: vi.fn((listener: (event: WorkflowEvent) => void) => {
            workflowListener = listener
            return () => { workflowListener = null }
          }),
          onChapterCreated: vi.fn(() => () => {}),
          stopWorkflow: vi.fn(async () => ({ ok: true }))
        }
      }
    })

    const view = render(
      <AgentPanel projectId="project-a" chapterId={null} onChapterSelect={onChapterSelect} onOpenConfig={vi.fn()} />
    )
    await act(flushPromises)

    const draft = '暴雨越过空城，写作者推开了那扇锁住多年的门。门后没有灯，只有脚步声一步步逼近。'.repeat(3)
    act(() => {
      workflowListener?.({
        type: 'agentStart',
        agentId: 'writer',
        agentName: 'Writer',
        projectId: 'project-a',
        runId: 3
      })
      workflowListener?.({
        type: 'agentComplete',
        agentId: 'writer',
        result: { agentId: 'writer', content: draft, toolCalls: [] },
        projectId: 'project-a',
        runId: 3
      })
      workflowListener?.({
        type: 'workflowComplete',
        summary: 'done',
        projectId: 'project-a',
        runId: 3
      })
    })
    // 工作流完成后不再自动写入章节，需要用户手动点击"应用到正文"
    expect(createChapter).not.toHaveBeenCalled()
    fireEvent.click(view.getByText('应用到正文'))
    expect(createChapter).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-a' }))

    view.rerender(
      <AgentPanel projectId="project-b" chapterId={null} onChapterSelect={onChapterSelect} onOpenConfig={vi.fn()} />
    )
    await act(async () => {
      chapterCreation.resolve(chapter('chapter-a', 'project-a'))
      await flushPromises()
    })

    expect(useProjectStore.getState().chapters).toEqual([])
    expect(onChapterSelect).not.toHaveBeenCalled()
  })
})

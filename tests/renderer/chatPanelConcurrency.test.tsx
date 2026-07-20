import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChapterData, ConversationData, MessageData, ProviderConfig } from '../../src/preload/types'
import { ChatPanel } from '../../src/renderer/components/ai/ChatPanel'
import { AGENT_CHAPTER_PROPOSAL_EVENT, type AgentChapterProposalDetail } from '../../src/renderer/lib/agentProposal'
import { useAIStore } from '../../src/renderer/stores/ai.store'
import { useEditorStore } from '../../src/renderer/stores/editor.store'

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

function conversation(id: string, createdAt: string): ConversationData {
  return {
    id,
    project_id: 'project-1',
    chapter_id: null,
    title: id,
    provider_config_id: provider.id,
    created_at: createdAt
  }
}

function assistantMessage(id: string, conversationId: string, content: string): MessageData {
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

function chapter(content: string): ChapterData {
  return {
    id: 'chapter-1',
    project_id: 'project-1',
    parent_id: null,
    title: 'Chapter one',
    content,
    sort_order: 0,
    word_count: content.length,
    status: 'draft',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z'
  }
}

describe('ChatPanel concurrency guards', () => {
  beforeEach(() => {
    useAIStore.setState({
      providers: [],
      conversations: [],
      messages: [],
      currentConversationId: null,
      streamingContent: '',
      streamingThinking: '',
      streamingConversations: {}
    })
    useEditorStore.getState().reset()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('disables sending while historical messages load and ignores the stale response', async () => {
    const conversationBMessages = deferred<MessageData[]>()
    const sendMessage = vi.fn()
    const conversationA = conversation('conversation-a', '2026-01-02T00:00:00.000Z')
    const conversationB = conversation('conversation-b', '2026-01-01T00:00:00.000Z')
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        ai: {
          listProviders: vi.fn(async () => [provider]),
          listConversations: vi.fn(async () => [conversationA, conversationB]),
          getMessages: vi.fn((conversationId: string) => conversationId === conversationB.id
            ? conversationBMessages.promise
            : Promise.resolve([assistantMessage('message-a', conversationA.id, 'conversation A message')])),
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
        projectId="project-1"
        chapterId={null}
        currentPanel="chat"
        onOpenSettings={vi.fn()}
        onChapterSelect={vi.fn()}
      />
    )
    await waitFor(() => expect(view.getByText('conversation A message')).toBeTruthy())
    fireEvent.change(view.container.querySelector('.chat-input-row textarea')!, { target: { value: 'draft request' } })

    act(() => useAIStore.getState().setCurrentConversation(conversationB.id))
    await waitFor(() => expect(view.container.querySelector<HTMLButtonElement>('.chat-send-btn')?.disabled).toBe(true))
    fireEvent.click(view.container.querySelector('.chat-send-btn')!)
    expect(sendMessage).not.toHaveBeenCalled()

    act(() => useAIStore.getState().setCurrentConversation(conversationA.id))
    await waitFor(() => expect(view.getByText('conversation A message')).toBeTruthy())
    await act(async () => {
      conversationBMessages.resolve([assistantMessage('message-b', conversationB.id, 'late conversation B message')])
      await conversationBMessages.promise
    })

    expect(useAIStore.getState().currentConversationId).toBe(conversationA.id)
    expect(view.queryByText('late conversation B message')).toBeNull()
    expect(view.getByText('conversation A message')).toBeTruthy()
  })

  it('plans and emits a proposal against the latest live chapter content', async () => {
    const agentReply = deferred<{ conversationId: string; content: string; actionResults: [] }>()
    const oldChapter = chapter('<p>old persisted content</p>')
    const liveContent = '<p>new unsaved content written during generation</p>'
    const planChapterEdit = vi.fn(async () => ({
      plan: { summary: 'append', confidence: 1, operations: [] },
      proposedText: 'proposal',
      proposedHtml: '<p>new unsaved content written during generation</p><p>proposal</p>',
      summary: 'append',
      appliedOperations: [],
      warnings: []
    }))
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        ai: {
          listProviders: vi.fn(async () => [provider]),
          listConversations: vi.fn(async () => [conversation('conversation-a', '2026-01-01T00:00:00.000Z')]),
          getMessages: vi.fn(async () => []),
          planChapterEdit,
          abortStream: vi.fn(async () => {}),
          onToken: vi.fn(() => () => {}),
          onThinking: vi.fn(() => () => {})
        },
        file: { listChapters: vi.fn(async () => [oldChapter]) },
        appAgent: {
          sendMessage: vi.fn(() => agentReply.promise),
          abortMessage: vi.fn(async () => {}),
          onAction: vi.fn(() => () => {})
        }
      }
    })
    useEditorStore.getState().loadChapter(oldChapter.id, oldChapter.title, oldChapter.content)
    let proposal: AgentChapterProposalDetail | null = null
    const onProposal = (event: Event) => {
      proposal = (event as CustomEvent<AgentChapterProposalDetail>).detail
    }
    window.addEventListener(AGENT_CHAPTER_PROPOSAL_EVENT, onProposal)

    const view = render(
      <ChatPanel
        projectId="project-1"
        chapterId="chapter-1"
        currentPanel="chat"
        onOpenSettings={vi.fn()}
        onChapterSelect={vi.fn()}
      />
    )
    await waitFor(() => expect(useAIStore.getState().currentConversationId).toBe('conversation-a'))
    const textarea = view.container.querySelector('.chat-input-row textarea')!
    fireEvent.change(textarea, { target: { value: '续写正文' } })
    fireEvent.click(view.container.querySelector('.chat-send-btn')!)
    await waitFor(() => expect(window.electronAPI.appAgent.sendMessage).toHaveBeenCalledTimes(1))

    act(() => useEditorStore.getState().setContent(liveContent))
    await act(async () => {
      agentReply.resolve({
        conversationId: 'conversation-a',
        content: '雨落在青石街上。林晚推开那扇旧门，风从幽暗的走廊深处迎面而来。她握紧手中的信，听见楼上传来缓慢的脚步声。多年未解的秘密，终于在这个夜晚露出了第一道裂缝。',
        actionResults: []
      })
      await agentReply.promise
    })

    await waitFor(() => expect(planChapterEdit).toHaveBeenCalledWith(expect.objectContaining({
      chapterHtml: liveContent
    })))
    await waitFor(() => expect(proposal).not.toBeNull())
    expect(proposal).toMatchObject({
      chapterId: 'chapter-1',
      oldHtml: liveContent
    })
    window.removeEventListener(AGENT_CHAPTER_PROPOSAL_EVENT, onProposal)
  })
})

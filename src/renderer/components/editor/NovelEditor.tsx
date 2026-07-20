import React, { useEffect, useCallback, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { useEditorStore } from '../../stores/editor.store'
import { useProjectStore } from '../../stores/project.store'
import { useAutoSave } from '../../hooks/useAutoSave'
import { EditorToolbar } from './EditorToolbar'
import { computeDiff, diffSummary } from '../../lib/diffEngine'
import { AGENT_CHAPTER_PROPOSAL_EVENT, storePendingAgentChapterProposal, takePendingAgentChapterProposal, type AgentChapterProposalDetail } from '../../lib/agentProposal'
import { useUIStore } from '../../stores/ui.store'
import { getChapterSaveSnapshot, registerPendingWriteFlusher } from './editorPersistence'

interface NovelEditorProps {
  chapterId: string | null
  projectId: string
  onSelectChapter: (id: string) => void
}

export function NovelEditor({ chapterId, projectId, onSelectChapter }: NovelEditorProps) {
  const {
    loadedChapterId, content, title, agentProposal, agentProposalConflict,
    setContent, setTitle, setSelectedText, loadChapter, applyAgentContent, acceptAgentChange, rejectAgentChange
  } = useEditorStore()
  const [agentDiffSummary, setAgentDiffSummary] = React.useState<{ additions: number; deletions: number } | null>(null)
  const [quickChapterTitle, setQuickChapterTitle] = React.useState('第一章')
  const suppressingSync = useRef(false)
  const loadSequenceRef = useRef(0)
  const titleSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingTitleRef = useRef<{ chapterId: string; title: string } | null>(null)
  const contentWrapperRef = useRef<HTMLDivElement>(null)
  const updateChapter = useProjectStore(s => s.updateChapter)
  const addChapter = useProjectStore(s => s.addChapter)
  const fontSize = useUIStore(s => s.fontSize)

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({
        placeholder: '开始书写你的故事...'
      })
    ],
    content,
    onUpdate: ({ editor }) => {
      if (suppressingSync.current) return
      const html = editor.getHTML()
      setContent(html)
    },
    onSelectionUpdate: ({ editor }) => {
      const { from, to } = editor.state.selection
      setSelectedText(from === to ? '' : editor.state.doc.textBetween(from, to, '\n'))
    },
    editorProps: {
      attributes: {
        class: 'novel-editor-content'
      }
    }
  })

  const saveChapterContent = useCallback(async (id: string, content: string) => {
    const saved = await window.electronAPI.file.saveChapter(id, content)
    if (saved) {
      updateChapter(id, {
        content: saved.content,
        word_count: saved.word_count,
        updated_at: saved.updated_at
      })
    }
  }, [updateChapter])

  const { saveNow, flush: flushContent } = useAutoSave(loadedChapterId, saveChapterContent)

  const persistChapterTitle = useCallback(async (id: string, nextTitle: string, normalize = false) => {
    const titleToSave = normalize ? (nextTitle.trim() || '未命名章节') : nextTitle
    if (!titleToSave.trim()) return

    await window.electronAPI.file.renameChapter(id, titleToSave)
    updateChapter(id, { title: titleToSave })
    if (
      normalize &&
      titleToSave !== nextTitle &&
      useEditorStore.getState().loadedChapterId === id &&
      useEditorStore.getState().title === nextTitle
    ) {
      setTitle(titleToSave)
    }
  }, [setTitle, updateChapter])

  const flushPendingTitle = useCallback(async (normalize = false): Promise<void> => {
    if (titleSaveTimerRef.current) {
      clearTimeout(titleSaveTimerRef.current)
      titleSaveTimerRef.current = null
    }

    const pending = pendingTitleRef.current
    if (!pending) return
    await persistChapterTitle(pending.chapterId, pending.title, normalize)
    if (pendingTitleRef.current === pending) {
      pendingTitleRef.current = null
    }
  }, [persistChapterTitle])

  useEffect(() => registerPendingWriteFlusher(async () => {
    await Promise.all([flushContent(), flushPendingTitle(true)])
  }), [flushContent, flushPendingTitle])

  const showAgentProposal = useCallback((newContent: string, oldContent?: string) => {
    const state = useEditorStore.getState()
    const currentContent = state.content
    const conflictsWithCurrent = oldContent !== undefined && currentContent !== oldContent && currentContent !== newContent
    const previousContent = conflictsWithCurrent ? currentContent : (oldContent ?? currentContent)
    const oldText = stripHtml(previousContent)
    const newText = stripHtml(newContent)
    const diff = computeDiff(oldText, newText)
    const summary = diffSummary(diff)
    if (summary.additions === 0 && summary.deletions === 0) return

    setAgentDiffSummary(summary)
    if (editor && !conflictsWithCurrent) {
      suppressingSync.current = true
      editor.commands.setContent(newContent)
      suppressingSync.current = false
    }
    applyAgentContent(newContent, previousContent, conflictsWithCurrent)
  }, [editor, applyAgentContent])

  useEffect(() => {
    const sequence = ++loadSequenceRef.current
    let cancelled = false

    const loadSelectedChapter = async (): Promise<void> => {
      const state = useEditorStore.getState()
      if (state.loadedChapterId && state.loadedChapterId !== chapterId) {
        if (state.agentProposal && state.agentProposedContent) {
          storePendingAgentChapterProposal({
            chapterId: state.loadedChapterId,
            html: state.agentProposedContent,
            oldHtml: state.agentOldContent ?? state.content,
            sourceName: '待确认正文提案'
          })
        }

        const saveSnapshot = getChapterSaveSnapshot(state, chapterId)
        await Promise.all([
          saveSnapshot ? saveNow(saveSnapshot.chapterId, saveSnapshot.content) : Promise.resolve(),
          flushPendingTitle(true)
        ])
      }

      if (cancelled || sequence !== loadSequenceRef.current) return
      if (!chapterId) {
        useEditorStore.getState().reset()
        setAgentDiffSummary(null)
        return
      }

      const chapters = await window.electronAPI.file.listChapters(projectId)
      if (cancelled || sequence !== loadSequenceRef.current) return
      const chapter = chapters.find(c => c.id === chapterId)
      if (!chapter) return

      loadChapter(chapter.id, chapter.title, chapter.content)
      setAgentDiffSummary(null)
      if (editor) {
        suppressingSync.current = true
        editor.commands.setContent(chapter.content)
        suppressingSync.current = false
      }
      // 切换章节后把正文滚动区复位到顶部，回到本章开头。
      requestAnimationFrame(() => contentWrapperRef.current?.scrollTo({ top: 0 }))

      const pendingProposal = takePendingAgentChapterProposal(chapter.id)
      if (pendingProposal) {
        showAgentProposal(pendingProposal.html, pendingProposal.oldHtml ?? chapter.content)
      }
    }

    void loadSelectedChapter().catch((err) => {
      if (!cancelled && sequence === loadSequenceRef.current) {
        console.error('Chapter load failed:', err)
      }
    })
    return () => { cancelled = true }
  }, [chapterId, projectId, editor, flushPendingTitle, loadChapter, saveNow, showAgentProposal])

  // Sync content changes from store back to editor (e.g. after accept/reject)
  useEffect(() => {
    if (!editor || suppressingSync.current) return
    const editorHTML = editor.getHTML()
    if (editorHTML !== content) {
      suppressingSync.current = true
      editor.commands.setContent(content)
      suppressingSync.current = false
    }
  }, [content])

  // Listen for agent chapter updates
  useEffect(() => {
    const unsubscribe = window.electronAPI.agent.onChapterUpdate((event) => {
      if (event.chapterId === chapterId && useEditorStore.getState().loadedChapterId === event.chapterId) {
        showAgentProposal(event.newContent, event.oldContent)
        return
      }
      // 写作团队改写的不是当前章节：库里已经是新稿，不能静默丢事件。
      // 挂起 diff，等用户切到该章节时再弹确认条（拒绝会恢复旧稿并回存）。
      storePendingAgentChapterProposal({
        chapterId: event.chapterId,
        html: event.newContent,
        oldHtml: event.oldContent,
        sourceName: '写作团队改写'
      })
    })
    return unsubscribe
  }, [chapterId, showAgentProposal])

  useEffect(() => {
    const handleProposal = (event: Event) => {
      const detail = (event as CustomEvent<AgentChapterProposalDetail>).detail
      if (detail.chapterId === chapterId && useEditorStore.getState().loadedChapterId === detail.chapterId) {
        takePendingAgentChapterProposal(detail.chapterId)
        showAgentProposal(detail.html, detail.oldHtml)
      }
    }

    window.addEventListener(AGENT_CHAPTER_PROPOSAL_EVENT, handleProposal)
    return () => window.removeEventListener(AGENT_CHAPTER_PROPOSAL_EVENT, handleProposal)
  }, [chapterId, showAgentProposal])

  useEffect(() => {
    const handleChapterUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; chapterId?: string; title?: string; content?: string }>).detail
      if (detail.projectId !== projectId || detail.chapterId !== chapterId || !detail.content) return
      const state = useEditorStore.getState()
      if (state.loadedChapterId !== detail.chapterId || state.isDirty || state.agentProposal) return

      loadChapter(detail.chapterId, detail.title ?? title, detail.content)
      if (editor) {
        suppressingSync.current = true
        editor.commands.setContent(detail.content)
        suppressingSync.current = false
      }
    }

    window.addEventListener('noval:chapter-updated', handleChapterUpdated)
    return () => window.removeEventListener('noval:chapter-updated', handleChapterUpdated)
  }, [chapterId, editor, loadChapter, projectId, title])

  const handleTitleChange = useCallback(async (newTitle: string) => {
    setTitle(newTitle)
    if (loadedChapterId) {
      updateChapter(loadedChapterId, { title: newTitle })
      pendingTitleRef.current = { chapterId: loadedChapterId, title: newTitle }
      if (titleSaveTimerRef.current) clearTimeout(titleSaveTimerRef.current)
      titleSaveTimerRef.current = setTimeout(() => {
        void flushPendingTitle().catch(err => console.error('Chapter title save failed:', err))
      }, 600)
    }
  }, [flushPendingTitle, loadedChapterId, setTitle, updateChapter])

  const handleTitleBlur = useCallback(() => {
    if (!loadedChapterId) return
    pendingTitleRef.current = { chapterId: loadedChapterId, title }
    void flushPendingTitle(true).catch(err => console.error('Chapter title save failed:', err))
  }, [flushPendingTitle, loadedChapterId, title])

  const createChapterFromEditor = useCallback(async () => {
    const trimmedTitle = quickChapterTitle.trim()
    if (!trimmedTitle) return

    const chapter = await window.electronAPI.file.createChapter({
      projectId,
      title: trimmedTitle
    })
    addChapter(chapter)
    setQuickChapterTitle('下一章')
    onSelectChapter(chapter.id)
  }, [addChapter, onSelectChapter, projectId, quickChapterTitle])

  useEffect(() => {
    return () => {
      if (titleSaveTimerRef.current) clearTimeout(titleSaveTimerRef.current)
    }
  }, [])

  const handleAccept = useCallback(async () => {
    const activeChapterId = useEditorStore.getState().loadedChapterId
    if (activeChapterId) takePendingAgentChapterProposal(activeChapterId)
    acceptAgentChange()
    setAgentDiffSummary(null)
    if (activeChapterId) {
      await saveNow(activeChapterId, useEditorStore.getState().content)
    }
  }, [acceptAgentChange, saveNow])

  const handleReject = useCallback(async () => {
    const activeChapterId = useEditorStore.getState().loadedChapterId
    if (activeChapterId) takePendingAgentChapterProposal(activeChapterId)
    // rejectAgentChange restores content from agentOldContent
    rejectAgentChange()
    setAgentDiffSummary(null)
    if (activeChapterId) {
      await saveNow(activeChapterId, useEditorStore.getState().content)
    }
  }, [rejectAgentChange, saveNow])

  if (!chapterId) {
    return (
      <div className="editor-empty">
        <div className="editor-empty-content">
          <p>选择章节，或直接新建一章开始写作</p>
          <div className="editor-empty-create">
            <input
              value={quickChapterTitle}
              onChange={e => setQuickChapterTitle(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && void createChapterFromEditor()}
              placeholder="章节标题"
            />
            <button onClick={() => void createChapterFromEditor()} disabled={!quickChapterTitle.trim()}>
              新建章节
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="novel-editor">
      <div className="editor-header">
        <input
          type="text"
          value={title}
          onChange={e => handleTitleChange(e.target.value)}
          onBlur={handleTitleBlur}
          placeholder="章节标题..."
          className="editor-title-input"
        />
      </div>
      <EditorToolbar editor={editor} />
      <div
        ref={contentWrapperRef}
        className="editor-content-wrapper"
        style={{ '--editor-font-size': `${fontSize}px` } as React.CSSProperties}
      >
        <EditorContent editor={editor} />
      </div>

      {/* Agent proposal confirmation bar */}
      {agentProposal && agentDiffSummary && (
        <div className="agent-proposal-bar">
          <div className="agent-proposal-info">
            <span className="agent-proposal-icon">🤖</span>
            <span className="agent-proposal-text">
              {agentProposalConflict
                ? '生成期间正文已变化；接受将使用提案，撤销将保留当前正文'
                : 'Agent 输出已放入正文，等待确认'}
            </span>
            <span className="agent-proposal-stats">
              <span className="diff-stat-add">+{agentDiffSummary.additions}</span>
              <span className="diff-stat-del">-{agentDiffSummary.deletions}</span>
            </span>
          </div>
          <div className="agent-proposal-actions">
            <button className="proposal-accept-btn" onClick={handleAccept}>
              接受并保存
            </button>
            <button className="proposal-reject-btn" onClick={handleReject}>
              撤销
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function stripHtml(html: string): string {
  if (!html) return ''
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

import React, { useEffect, useCallback, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { useEditorStore } from '../../stores/editor.store'
import { useProjectStore } from '../../stores/project.store'
import { useAutoSave } from '../../hooks/useAutoSave'
import { EditorToolbar } from './EditorToolbar'
import { computeDiff, diffSummary } from '../../lib/diffEngine'
import { AGENT_CHAPTER_PROPOSAL_EVENT, takePendingAgentChapterProposal, type AgentChapterProposalDetail } from '../../lib/agentProposal'
import { useUIStore } from '../../stores/ui.store'

interface NovelEditorProps {
  chapterId: string | null
  projectId: string
  onSelectChapter: (id: string) => void
}

export function NovelEditor({ chapterId, projectId, onSelectChapter }: NovelEditorProps) {
  const {
    content, title, agentProposal,
    setContent, setTitle, setSelectedText, loadChapter, applyAgentContent, acceptAgentChange, rejectAgentChange, markClean
  } = useEditorStore()
  const [agentDiffSummary, setAgentDiffSummary] = React.useState<{ additions: number; deletions: number } | null>(null)
  const [quickChapterTitle, setQuickChapterTitle] = React.useState('第一章')
  const suppressingSync = useRef(false)
  const previousChapterIdRef = useRef<string | null>(null)
  const titleSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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

  const persistChapterTitle = useCallback(async (id: string, nextTitle: string, normalize = false) => {
    const titleToSave = normalize ? (nextTitle.trim() || '未命名章节') : nextTitle
    if (!titleToSave.trim()) return

    await window.electronAPI.file.renameChapter(id, titleToSave)
    updateChapter(id, { title: titleToSave })
    if (normalize && titleToSave !== nextTitle) {
      setTitle(titleToSave)
    }
  }, [setTitle, updateChapter])

  const showAgentProposal = useCallback((newContent: string, oldContent?: string) => {
    const previousContent = oldContent ?? useEditorStore.getState().content
    const oldText = stripHtml(previousContent)
    const newText = stripHtml(newContent)
    const diff = computeDiff(oldText, newText)
    const summary = diffSummary(diff)
    if (summary.additions === 0 && summary.deletions === 0) return

    setAgentDiffSummary(summary)
    if (editor) {
      suppressingSync.current = true
      editor.commands.setContent(newContent)
      suppressingSync.current = false
    }
    applyAgentContent(newContent)
  }, [editor, applyAgentContent])

  useEffect(() => {
    const previousChapterId = previousChapterIdRef.current
    if (previousChapterId && previousChapterId !== chapterId) {
      const state = useEditorStore.getState()
      if (state.isDirty) {
        void saveChapterContent(previousChapterId, state.content)
      }
    }
    previousChapterIdRef.current = chapterId

    if (chapterId) {
      let cancelled = false
      window.electronAPI.file.listChapters(projectId).then(chapters => {
        if (cancelled) return
        const chapter = chapters.find(c => c.id === chapterId)
        if (chapter) {
          loadChapter(chapter.title, chapter.content)
          if (editor) {
            suppressingSync.current = true
            editor.commands.setContent(chapter.content)
            suppressingSync.current = false
          }

          const pendingProposal = takePendingAgentChapterProposal(chapter.id)
          if (pendingProposal) {
            showAgentProposal(pendingProposal.html, pendingProposal.oldHtml ?? chapter.content)
          }
        }
      })
      return () => { cancelled = true }
    }
  }, [chapterId, projectId, editor, loadChapter, saveChapterContent, showAgentProposal])

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
      if (event.chapterId === chapterId) {
        showAgentProposal(event.newContent, event.oldContent)
      }
    })
    return unsubscribe
  }, [chapterId, showAgentProposal])

  useEffect(() => {
    const handleProposal = (event: Event) => {
      const detail = (event as CustomEvent<AgentChapterProposalDetail>).detail
      if (detail.chapterId === chapterId) {
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
      if (useEditorStore.getState().isDirty) return

      loadChapter(detail.title ?? title, detail.content)
      if (editor) {
        suppressingSync.current = true
        editor.commands.setContent(detail.content)
        suppressingSync.current = false
      }
    }

    window.addEventListener('noval:chapter-updated', handleChapterUpdated)
    return () => window.removeEventListener('noval:chapter-updated', handleChapterUpdated)
  }, [chapterId, editor, loadChapter, projectId, title])

  useAutoSave(
    chapterId,
    async (id, content) => {
      await saveChapterContent(id, content)
    }
  )

  const handleTitleChange = useCallback(async (newTitle: string) => {
    setTitle(newTitle)
    if (chapterId) {
      updateChapter(chapterId, { title: newTitle })
      if (titleSaveTimerRef.current) clearTimeout(titleSaveTimerRef.current)
      titleSaveTimerRef.current = setTimeout(() => {
        void persistChapterTitle(chapterId, newTitle)
      }, 600)
    }
  }, [chapterId, persistChapterTitle, setTitle, updateChapter])

  const handleTitleBlur = useCallback(() => {
    if (!chapterId) return
    if (titleSaveTimerRef.current) clearTimeout(titleSaveTimerRef.current)
    void persistChapterTitle(chapterId, title, true)
  }, [chapterId, persistChapterTitle, title])

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
    acceptAgentChange()
    setAgentDiffSummary(null)
    if (chapterId) {
      await saveChapterContent(chapterId, content)
      markClean()
    }
  }, [chapterId, content, saveChapterContent, markClean])

  const handleReject = useCallback(() => {
    // rejectAgentChange restores content from agentOldContent
    rejectAgentChange()
    setAgentDiffSummary(null)
  }, [])

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
              Agent 输出已放入正文，等待确认
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

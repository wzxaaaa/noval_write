import React, { useEffect, useState, useCallback } from 'react'
import { useProjectStore } from '../../stores/project.store'
import { normalizeChapterTitle } from '../../../shared/chapterFormat'
import type { ChapterData } from '../../../preload/types'
import { flushPendingEditorWrites } from '../editor/editorPersistence'

type DropPosition = 'before' | 'after'

interface SidebarProps {
  activePanel: string
  onPanelChange: (panel: any) => void
  projectId: string | null
  onChapterSelect: (id: string | null) => void
  currentChapterId: string | null
  onNewProject: () => void
  onOpenSettings: () => void
}

export function Sidebar({
  activePanel,
  onPanelChange,
  projectId,
  onChapterSelect,
  currentChapterId,
  onNewProject,
  onOpenSettings
}: SidebarProps) {
  const { chapters, setChapters } = useProjectStore()
  const [chapterTitle, setChapterTitle] = useState('')
  const [isLoadingChapters, setIsLoadingChapters] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState<{ percent: number; text: string } | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; chapterId: string; title: string } | null>(null)
  const [hoveredChapterId, setHoveredChapterId] = useState<string | null>(null)
  const [draggedChapterId, setDraggedChapterId] = useState<string | null>(null)
  const [dragOverChapterId, setDragOverChapterId] = useState<string | null>(null)
  const [dragOverPosition, setDragOverPosition] = useState<DropPosition>('before')

  useEffect(() => {
    let cancelled = false

    if (!projectId) {
      setChapters([])
      setIsLoadingChapters(false)
      return
    }

    setIsLoadingChapters(true)
    setChapters([])
    window.electronAPI.file.listChapters(projectId)
      .then(rows => {
        if (!cancelled) {
          const sortedRows = rows.slice().sort((a, b) => a.sort_order - b.sort_order)
          setChapters(sortedRows)
          if (sortedRows.length > 0 && (!currentChapterId || !sortedRows.some(ch => ch.id === currentChapterId))) {
            onChapterSelect(sortedRows[0].id)
          }
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingChapters(false)
      })

    return () => {
      cancelled = true
    }
  }, [projectId, currentChapterId, onChapterSelect, setChapters])

  useEffect(() => {
    const handleChaptersUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail
      if (!projectId || (detail?.projectId && detail.projectId !== projectId)) return

      setIsLoadingChapters(true)
      window.electronAPI.file.listChapters(projectId)
        .then(rows => {
          const sortedRows = rows.slice().sort((a, b) => a.sort_order - b.sort_order)
          setChapters(sortedRows)
          if (sortedRows.length > 0 && (!currentChapterId || !sortedRows.some(ch => ch.id === currentChapterId))) {
            onChapterSelect(sortedRows[0].id)
          }
        })
        .finally(() => setIsLoadingChapters(false))
    }

    window.addEventListener('noval:chapters-updated', handleChaptersUpdated)
    return () => window.removeEventListener('noval:chapters-updated', handleChaptersUpdated)
  }, [projectId, currentChapterId, onChapterSelect, setChapters])

  useEffect(() => {
    const unsubscribe = window.electronAPI.file.onExportProgress((progress) => {
      if (progress.projectId !== projectId) return
      if (progress.status === 'error') {
        setExportProgress({ percent: 0, text: progress.message || '导出失败' })
        return
      }
      setExportProgress({
        percent: progress.percent,
        text: progress.status === 'done' ? '导出完成' : `导出中 ${progress.done}/${progress.total}`
      })
    })
    return unsubscribe
  }, [projectId])

  useEffect(() => {
    if (!contextMenu) return
    const closeMenu = () => setContextMenu(null)
    document.addEventListener('click', closeMenu)
    document.addEventListener('contextmenu', closeMenu)
    return () => {
      document.removeEventListener('click', closeMenu)
      document.removeEventListener('contextmenu', closeMenu)
    }
  }, [contextMenu])

  const visibleChapters = projectId
    ? chapters.filter(ch => ch.project_id === projectId).slice().sort(compareChapterOrder)
    : []

  const addChapter = async () => {
    if (!projectId || !chapterTitle.trim()) return
    const chapter = await window.electronAPI.file.createChapter({
      projectId,
      title: chapterTitle.trim()
    })
    setChapterTitle('')
    setChapters([...visibleChapters, chapter])
    onChapterSelect(chapter.id)
  }

  const deleteChapter = useCallback(async (chapterId: string, chapterTitle: string) => {
    setContextMenu(null)
    const confirmed = await new Promise<boolean>((resolve) => {
      const ok = window.confirm(`确定要删除「${chapterTitle}」吗？此操作不可撤销。`)
      resolve(ok)
    })
    if (!confirmed) return

    await window.electronAPI.file.deleteChapter(chapterId)
    const remainingChapters = visibleChapters.filter(ch => ch.id !== chapterId)
    setChapters(remainingChapters)

    if (currentChapterId === chapterId) {
      const deletedIndex = visibleChapters.findIndex(ch => ch.id === chapterId)
      const nextChapter = remainingChapters[Math.min(deletedIndex, remainingChapters.length - 1)]
      onChapterSelect(nextChapter?.id ?? null)
    }
  }, [visibleChapters, currentChapterId, onChapterSelect, setChapters])

  const handleContextMenu = useCallback((e: React.MouseEvent, chapterId: string, title: string) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, chapterId, title })
  }, [])

  const handleDragStart = useCallback((e: React.DragEvent, chapterId: string) => {
    setDraggedChapterId(chapterId)
    e.dataTransfer.setData('text/plain', chapterId)
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, chapterId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverChapterId(chapterId)
    setDragOverPosition(getDropPosition(e))
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOverChapterId(null)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent, targetChapterId: string) => {
    e.preventDefault()
    const sourceChapterId = draggedChapterId || e.dataTransfer.getData('text/plain')
    setDragOverChapterId(null)

    if (!sourceChapterId || sourceChapterId === targetChapterId) {
      setDraggedChapterId(null)
      return
    }

    const reorderedChapters = reorderChaptersForDrop(
      visibleChapters,
      sourceChapterId,
      targetChapterId,
      dragOverPosition
    )
    const changed = reorderedChapters.map(ch => ch.id).join('|') !== visibleChapters.map(ch => ch.id).join('|')
    if (!changed) {
      setDraggedChapterId(null)
      return
    }

    setChapters(reorderedChapters)

    try {
      const persistedChapters = await window.electronAPI.file.updateChapterOrder(reorderedChapters.map(ch => ch.id))
      setChapters(persistedChapters.slice().sort(compareChapterOrder))
    } catch (err) {
      setChapters(visibleChapters)
      window.alert((err as Error).message || '章节排序保存失败')
    }

    setDraggedChapterId(null)
  }, [dragOverPosition, draggedChapterId, visibleChapters, setChapters])

  const handleDragEnd = useCallback(() => {
    setDraggedChapterId(null)
    setDragOverChapterId(null)
    setDragOverPosition('before')
  }, [])

  const exportProject = async () => {
    if (!projectId || exporting || visibleChapters.length === 0) return
    setExporting(true)
    setExportProgress({ percent: 0, text: '准备导出' })

    try {
      await flushPendingEditorWrites()
      const result = await window.electronAPI.file.exportProjectTxt(projectId)
      if (result.canceled) {
        setExportProgress({ percent: 0, text: '已取消导出' })
      } else {
        setExportProgress({ percent: 100, text: `已导出 ${result.chapterCount} 章` })
      }
    } catch (err) {
      setExportProgress({ percent: 0, text: (err as Error).message || '导出失败' })
    } finally {
      setExporting(false)
    }
  }

  const panelIcons = [
    { id: 'chat', icon: 'AI', title: 'AI 对话' },
    { id: 'agent', icon: 'AG', title: 'Agent 协作' },
    { id: 'outline', icon: '纲', title: '大纲 / 细纲' },
    { id: 'knowledge', icon: '库', title: '知识库' },
  ]

  return (
    <div className="sidebar" onClick={() => setContextMenu(null)}>
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <span className="sidebar-brand-mark">漫</span>
          <div>
            <h2>二维漫写</h2>
            <span>AI 小说创作工作台</span>
          </div>
        </div>
        <button onClick={onNewProject} title="项目管理" className="sidebar-project-btn">项目</button>
      </div>

      {projectId ? (
        <div className="chapter-tree">
          <div className="chapter-tree-header">
            <span>章节列表</span>
            <button
              className="chapter-export-btn"
              onClick={exportProject}
              disabled={isLoadingChapters || exporting || visibleChapters.length === 0}
              title="导出全部章节为 TXT"
            >
              {exporting ? '导出中' : '导出 TXT'}
            </button>
          </div>

          {exportProgress && (
            <div className="chapter-export-status">
              <div className="chapter-export-progress" style={{ width: `${exportProgress.percent}%` }} />
              <span>{exportProgress.text}</span>
            </div>
          )}

          <div className="chapter-list">
            {isLoadingChapters ? (
              <div className="chapter-list-loading">章节加载中...</div>
            ) : visibleChapters.map(ch => (
              <div
                key={ch.id}
                className={`chapter-item ${ch.id === currentChapterId ? 'active' : ''} ${draggedChapterId === ch.id ? 'dragging' : ''} ${dragOverChapterId === ch.id ? `drag-over drag-over-${dragOverPosition}` : ''}`}
                onClick={() => onChapterSelect(ch.id)}
                onContextMenu={(e) => handleContextMenu(e, ch.id, formatChapterTitle(ch.title))}
                onMouseEnter={() => setHoveredChapterId(ch.id)}
                onMouseLeave={() => setHoveredChapterId(null)}
                draggable
                onDragStart={(e) => handleDragStart(e, ch.id)}
                onDragOver={(e) => handleDragOver(e, ch.id)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, ch.id)}
                onDragEnd={handleDragEnd}
              >
                <span className="chapter-drag-handle" title="拖动排序">⋮⋮</span>
                <span className="chapter-title">{formatChapterTitle(ch.title)}</span>
                <div className="chapter-item-right">
                  <span className="chapter-words">{ch.word_count} 字</span>
                  {hoveredChapterId === ch.id && (
                    <button
                      className="chapter-delete-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteChapter(ch.id, formatChapterTitle(ch.title))
                      }}
                      title="删除此章节"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="add-chapter">
            <input
              type="text"
              value={chapterTitle}
              onChange={e => setChapterTitle(e.target.value)}
              placeholder="新章节标题..."
              onKeyDown={e => e.key === 'Enter' && addChapter()}
            />
            <button onClick={addChapter}>+</button>
          </div>
        </div>
      ) : (
        <div className="sidebar-empty">
          <p>创建或打开一个项目开始写作</p>
          <button onClick={onNewProject}>创建项目</button>
        </div>
      )}

      <div className="sidebar-panel-toggles">
        {panelIcons.map(p => (
          <button
            key={p.id}
            className={`panel-toggle-btn ${activePanel === p.id ? 'active' : ''}`}
            onClick={() => onPanelChange(p.id)}
            title={p.title}
            aria-label={p.title}
          >
            {p.icon}
          </button>
        ))}
        <button
          className="panel-toggle-btn sidebar-settings-toggle"
          onClick={onOpenSettings}
          title="设置"
          aria-label="设置"
        >
          ⚙
        </button>
      </div>

      {contextMenu && (
        <div
          className="chapter-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="ctx-menu-item ctx-menu-danger"
            onClick={() => deleteChapter(contextMenu.chapterId, contextMenu.title)}
          >
            🗑 删除「{contextMenu.title}」
          </button>
        </div>
      )}
    </div>
  )
}

function formatChapterTitle(title: string): string {
  return normalizeChapterTitle(title)
}

function getDropPosition(e: React.DragEvent): DropPosition {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  return e.clientY >= rect.top + rect.height / 2 ? 'after' : 'before'
}

export function reorderChaptersForDrop(
  chapters: ChapterData[],
  draggedChapterId: string,
  targetChapterId: string,
  position: DropPosition
): ChapterData[] {
  const ordered = chapters.slice().sort(compareChapterOrder)
  const draggedIndex = ordered.findIndex(chapter => chapter.id === draggedChapterId)
  if (draggedIndex === -1 || !ordered.some(chapter => chapter.id === targetChapterId)) return ordered

  const [draggedChapter] = ordered.splice(draggedIndex, 1)
  const targetIndex = ordered.findIndex(chapter => chapter.id === targetChapterId)
  if (targetIndex === -1) return chapters.slice().sort(compareChapterOrder)

  const insertIndex = position === 'after' ? targetIndex + 1 : targetIndex
  ordered.splice(insertIndex, 0, draggedChapter)

  return ordered.map((chapter, index) => ({
    ...chapter,
    sort_order: index
  }))
}

function compareChapterOrder(a: ChapterData, b: ChapterData): number {
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
  const createdDiff = Date.parse(a.created_at) - Date.parse(b.created_at)
  if (Number.isFinite(createdDiff) && createdDiff !== 0) return createdDiff
  return a.id.localeCompare(b.id)
}

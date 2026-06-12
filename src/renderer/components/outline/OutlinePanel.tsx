import React, { useState, useEffect, useCallback } from 'react'
import type { ProjectOutline, OutlineType } from '../../../preload/types'

interface OutlinePanelProps {
  projectId: string | null
}

interface OutlineUpdatedDetail {
  projectId?: string
  types?: OutlineType[]
}

export function OutlinePanel({ projectId }: OutlinePanelProps) {
  const [outlines, setOutlines] = useState<ProjectOutline[]>([])
  const [activeTab, setActiveTab] = useState<OutlineType>('outline')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')

  const loadOutlines = useCallback(async () => {
    if (!projectId) {
      setOutlines([])
      return
    }
    const list = await window.electronAPI.outline.list(projectId)
    setOutlines(list)
  }, [projectId])

  useEffect(() => {
    void loadOutlines()
  }, [loadOutlines])

  useEffect(() => {
    const handleOutlineUpdated = (event: Event) => {
      const detail = (event as CustomEvent<OutlineUpdatedDetail>).detail
      if (detail?.projectId && detail.projectId !== projectId) return

      if (detail?.types?.length === 1) {
        setActiveTab(detail.types[0])
      } else if (detail?.types?.includes('outline')) {
        setActiveTab('outline')
      }

      setEditingId(null)
      setIsCreating(false)
      void loadOutlines()
    }

    window.addEventListener('noval:outline-updated', handleOutlineUpdated)
    return () => window.removeEventListener('noval:outline-updated', handleOutlineUpdated)
  }, [loadOutlines, projectId])

  const filteredOutlines = outlines.filter(o => o.type === activeTab)

  const startCreate = () => {
    setIsCreating(true)
    setNewTitle('')
  }

  const handleCreate = async () => {
    if (!projectId || !newTitle.trim()) return
    await window.electronAPI.outline.create({
      projectId,
      type: activeTab,
      title: newTitle.trim(),
      content: ''
    })
    setIsCreating(false)
    setNewTitle('')
    loadOutlines()
  }

  const startEdit = (outline: ProjectOutline) => {
    setEditingId(outline.id)
    setEditContent(outline.content)
    setEditTitle(outline.title)
  }

  const saveEdit = async () => {
    if (!editingId) return
    await window.electronAPI.outline.update(editingId, { title: editTitle, content: editContent })
    setEditingId(null)
    loadOutlines()
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditContent('')
    setEditTitle('')
  }

  const deleteOutline = async (id: string, title: string) => {
    const confirmed = await new Promise<boolean>((resolve) => {
      resolve(window.confirm(`确定要删除「${title}」吗？`))
    })
    if (!confirmed) return
    await window.electronAPI.outline.delete(id)
    if (editingId === id) cancelEdit()
    loadOutlines()
  }

  if (!projectId) {
    return (
      <div className="outline-panel">
        <div className="panel-header">
          <h3>大纲 / 细纲</h3>
        </div>
        <div className="outline-empty">
          <p>请先选择一个项目</p>
        </div>
      </div>
    )
  }

  return (
    <div className="outline-panel">
      <div className="panel-header">
        <h3>大纲 / 细纲</h3>
      </div>

      <div className="outline-tabs">
        <button
          className={`outline-tab ${activeTab === 'outline' ? 'active' : ''}`}
          onClick={() => { setActiveTab('outline'); setEditingId(null); setIsCreating(false) }}
        >
          大纲
        </button>
        <button
          className={`outline-tab ${activeTab === 'detailed' ? 'active' : ''}`}
          onClick={() => { setActiveTab('detailed'); setEditingId(null); setIsCreating(false) }}
        >
          细纲
        </button>
      </div>

      {isCreating && (
        <div className="outline-create-bar">
          <input
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            placeholder={`${activeTab === 'outline' ? '大纲' : '细纲'}标题...`}
            onKeyDown={e => e.key === 'Enter' && void handleCreate()}
            autoFocus
          />
          <button className="create-confirm-btn" onClick={handleCreate} disabled={!newTitle.trim()}>
            创建
          </button>
          <button className="create-cancel-btn" onClick={() => setIsCreating(false)}>
            取消
          </button>
        </div>
      )}

      {!isCreating && (
        <div className="outline-toolbar">
          <button className="outline-add-btn" onClick={startCreate}>
            + 新建{activeTab === 'outline' ? '大纲' : '细纲'}
          </button>
          <span className="outline-count">{filteredOutlines.length} 个</span>
        </div>
      )}

      <div className="outline-list">
        {filteredOutlines.length === 0 && !isCreating && (
          <div className="outline-empty">
            <p>暂无{activeTab === 'outline' ? '大纲' : '细纲'}</p>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              点击上方按钮创建
            </p>
          </div>
        )}

        {filteredOutlines.map(outline => (
          <div key={outline.id} className="outline-card">
            {editingId === outline.id ? (
              <div className="outline-editor">
                <input
                  className="outline-title-input"
                  value={editTitle}
                  onChange={e => setEditTitle(e.target.value)}
                  placeholder="标题"
                />
                <textarea
                  className="outline-content-textarea"
                  value={editContent}
                  onChange={e => setEditContent(e.target.value)}
                  placeholder="在此编写内容..."
                  rows={12}
                />
                <div className="outline-editor-actions">
                  <button className="save-btn" onClick={saveEdit}>保存</button>
                  <button className="cancel-btn" onClick={cancelEdit}>取消</button>
                </div>
              </div>
            ) : (
              <>
                <div className="outline-card-header">
                  <span className="outline-card-title">{outline.title}</span>
                  <div className="outline-card-actions">
                    <button
                      className="outline-edit-btn"
                      onClick={() => startEdit(outline)}
                      title="编辑"
                    >
                      ✎
                    </button>
                    <button
                      className="outline-delete-btn"
                      onClick={() => deleteOutline(outline.id, outline.title)}
                      title="删除"
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <div className="outline-card-preview">
                  {outline.content.slice(0, 200) || '(空)'}
                  {outline.content.length > 200 && '...'}
                </div>
                <div className="outline-card-meta">
                  {new Date(outline.updated_at).toLocaleString()}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

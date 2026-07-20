import React, { useState, useEffect, useCallback } from 'react'
import { useProjectStore } from '../../stores/project.store'
import type { ProjectSummary } from '../../../preload/types'
import { ModalDialog } from '../common/ModalDialog'

interface ProjectManagerProps {
  onSelectProject: (id: string, chapterId?: string | null) => void
  onProjectDeleted?: (id: string) => void
  onClose: () => void
  canClose?: boolean
}

export function ProjectManager({ onSelectProject, onProjectDeleted, onClose, canClose = true }: ProjectManagerProps) {
  const { projects, setProjects } = useProjectStore()
  const [name, setName] = useState('')
  const [rootPath, setRootPath] = useState('')
  const [targetWords, setTargetWords] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [creatingProject, setCreatingProject] = useState(false)
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null)

  const handleTargetChange = useCallback(async (projectId: string, raw: string) => {
    const trimmed = raw.trim()
    const parsed = trimmed === '' ? null : Number(trimmed)
    const value = parsed !== null && Number.isFinite(parsed) ? parsed : null
    try {
      const saved = await window.electronAPI.file.setChapterWordTarget(projectId, value)
      setProjects(projects.map(p => (p.id === projectId ? { ...p, target_chapter_words: saved } : p)))
    } catch (error) {
      setStatus(error instanceof Error ? `保存每章字数失败：${error.message}` : '保存每章字数失败')
    }
  }, [projects, setProjects])

  const refresh = useCallback(async () => {
    const projectRows = await window.electronAPI.file.listProjects()
    setProjects(projectRows)
  }, [setProjects])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleCreate = async () => {
    if (!name.trim() || creatingProject) return
    setCreatingProject(true)
    setStatus(null)
    try {
      const path = rootPath || name.trim()
      const project = await window.electronAPI.file.createProject(name.trim(), path)
      const summary: ProjectSummary = {
        id: project.id,
        name: project.name,
        root_path: project.root_path,
        updated_at: project.updated_at
      }
      const desiredTarget = targetWords.trim() === '' ? null : Number(targetWords)
      if (desiredTarget !== null && Number.isFinite(desiredTarget)) {
        const saved = await window.electronAPI.file.setChapterWordTarget(project.id, desiredTarget).catch(() => null)
        summary.target_chapter_words = saved
      }
      setProjects([...projects, summary])
      setName('')
      setRootPath('')
      setTargetWords('')
      const firstChapter = await window.electronAPI.file.createChapter({
        projectId: project.id,
        title: '第一章'
      })
      onSelectProject(project.id, firstChapter.id)
    } catch (error) {
      await refresh().catch(() => undefined)
      setStatus(error instanceof Error ? `创建项目失败：${error.message}` : '创建项目失败，请重试')
    } finally {
      setCreatingProject(false)
    }
  }

  const handleDeleteProject = async (project: ProjectSummary) => {
    const confirmed = window.confirm(
      `确定删除项目「${project.name}」吗？\n\n这会删除该项目的章节、大纲、AI 对话和知识库记录，无法撤销。`
    )
    if (!confirmed) return

    setDeletingProjectId(project.id)
    try {
      await window.electronAPI.file.deleteProject(project.id)
      const nextProjects = projects.filter(p => p.id !== project.id)
      setProjects(nextProjects)
      setStatus(`项目「${project.name}」已删除`)
      onProjectDeleted?.(project.id)
      window.dispatchEvent(new CustomEvent('noval:project-deleted', { detail: { projectId: project.id } }))
    } finally {
      setDeletingProjectId(null)
    }
  }

  const handleSelectFolder = async () => {
    setStatus(null)
    try {
      const paths = await window.electronAPI.file.openFileDialog({
        properties: ['openDirectory']
      })
      if (paths && paths.length > 0) {
        setRootPath(paths[0])
      }
    } catch (error) {
      setStatus(error instanceof Error ? `选择文件夹失败：${error.message}` : '选择文件夹失败，请重试')
    }
  }

  return (
    <ModalDialog title="项目管理" onClose={onClose} canClose={canClose} className="project-manager-modal">
      <div className="modal-body">
          {projects.length > 0 && (
            <div className="project-list">
              <h3>最近项目</h3>
              {projects.map(p => (
                <div key={p.id} className="project-card">
                  <button
                    type="button"
                    className="project-card-main"
                    aria-label={`打开项目 ${p.name}`}
                    onClick={() => onSelectProject(p.id)}
                  >
                    <span className="project-name">{p.name}</span>
                    <span className="project-path">{p.root_path}</span>
                    <span className="project-date">{new Date(p.updated_at).toLocaleDateString('zh-CN')}</span>
                  </button>
                  <label
                    className="project-target"
                    title="每章目标字数，留空使用默认 3500 字。上限约为目标的 1.35 倍，超出会自动压缩。"
                    style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}
                  >
                    每章约
                    <input
                      type="number"
                      min={300}
                      max={20000}
                      step={100}
                      defaultValue={p.target_chapter_words ?? ''}
                      placeholder="3500"
                      onBlur={e => void handleTargetChange(p.id, e.target.value)}
                      style={{ width: 72 }}
                    />
                    字
                  </label>
                  <button
                    className="project-delete-btn"
                    title="删除项目"
                    aria-label={`删除项目 ${p.name}`}
                    disabled={deletingProjectId === p.id}
                    onClick={() => void handleDeleteProject(p)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {status && <div className="project-binding-status">{status}</div>}

          <div className="create-project">
            <h3>新建项目</h3>
            <label>
              项目名称
              <input value={name} onChange={e => setName(e.target.value)} placeholder="我的小说" />
            </label>
            <label>
              存储路径
              <div className="path-input">
                <input
                  value={rootPath}
                  readOnly
                  placeholder="可留空，或点击“选择”授权一个文件夹"
                  title="为保护本地文件安全，自定义目录必须通过“选择”按钮授权；留空时使用应用管理的目录。"
                />
                <button type="button" onClick={handleSelectFolder}>选择</button>
              </div>
            </label>
            <label>
              每章目标字数（可选）
              <input
                type="number"
                min={300}
                max={20000}
                step={100}
                value={targetWords}
                onChange={e => setTargetWords(e.target.value)}
                placeholder="留空默认 3500，范围 300–20000"
              />
            </label>
            <div style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.6 }}>
              新项目会自动使用唯一的固定写作团队，不再需要绑定 Agent 组。
            </div>
            <button onClick={handleCreate} disabled={!name.trim() || creatingProject}>
              {creatingProject ? '创建中…' : '创建项目'}
            </button>
          </div>
      </div>
    </ModalDialog>
  )
}

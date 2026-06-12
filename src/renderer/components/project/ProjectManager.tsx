import React, { useState, useEffect, useCallback } from 'react'
import { useProjectStore } from '../../stores/project.store'
import type { AgentGroup, ProjectSummary } from '../../../preload/types'

interface ProjectManagerProps {
  onSelectProject: (id: string, chapterId?: string | null) => void
  onProjectDeleted?: (id: string) => void
  onClose: () => void
}

export function ProjectManager({ onSelectProject, onProjectDeleted, onClose }: ProjectManagerProps) {
  const { projects, setProjects } = useProjectStore()
  const [name, setName] = useState('')
  const [rootPath, setRootPath] = useState('')
  const [selectedAgentGroupId, setSelectedAgentGroupId] = useState('')
  const [agentGroups, setAgentGroups] = useState<AgentGroup[]>([])
  const [projectGroupIds, setProjectGroupIds] = useState<Record<string, string>>({})
  const [bindingStatus, setBindingStatus] = useState<string | null>(null)
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null)

  const refreshBindings = useCallback(async (nextProjects: ProjectSummary[]) => {
    const entries = await Promise.all(nextProjects.map(async project => {
      const groups = await window.electronAPI.agent.listGroups(project.id)
      return [project.id, groups[0]?.id ?? ''] as const
    }))
    setProjectGroupIds(Object.fromEntries(entries))
  }, [])

  const refresh = useCallback(async () => {
    const [projectRows, groupRows] = await Promise.all([
      window.electronAPI.file.listProjects(),
      window.electronAPI.agent.listAllGroups()
    ])
    setProjects(projectRows)
    setAgentGroups(groupRows)
    await refreshBindings(projectRows)
  }, [refreshBindings, setProjects])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleCreate = async () => {
    if (!name.trim()) return
    const path = rootPath || `${name.trim()}`
    const project = await window.electronAPI.file.createProject(name.trim(), path, selectedAgentGroupId || null)
    const summary = {
      id: project.id,
      name: project.name,
      root_path: project.root_path,
      updated_at: project.updated_at,
      default_agent_group_id: project.default_agent_group_id
    }
    const nextProjects = [...projects, summary]
    setProjects(nextProjects)
    setProjectGroupIds(prev => ({ ...prev, [project.id]: selectedAgentGroupId }))
    setName('')
    setRootPath('')
    setSelectedAgentGroupId('')
    const firstChapter = await window.electronAPI.file.createChapter({
      projectId: project.id,
      title: '第一章'
    })
    onSelectProject(project.id, firstChapter.id)
  }

  const handleBindProjectGroup = async (projectId: string, groupId: string) => {
    await window.electronAPI.agent.bindProjectGroup(projectId, groupId || null)
    setProjectGroupIds(prev => ({ ...prev, [projectId]: groupId }))
    setBindingStatus(groupId ? 'Agent 组绑定已更新' : '已取消 Agent 组绑定')
    window.dispatchEvent(new CustomEvent('noval:project-agent-group-changed', { detail: { projectId } }))
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
      setProjectGroupIds(prev => {
        const next = { ...prev }
        delete next[project.id]
        return next
      })
      setBindingStatus(`项目「${project.name}」已删除`)
      onProjectDeleted?.(project.id)
      window.dispatchEvent(new CustomEvent('noval:project-deleted', { detail: { projectId: project.id } }))
    } finally {
      setDeletingProjectId(null)
    }
  }

  const handleSelectFolder = async () => {
    const paths = await window.electronAPI.file.openFileDialog({
      properties: ['openDirectory']
    })
    if (paths && paths.length > 0) {
      setRootPath(paths[0])
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal project-manager-modal">
        <div className="modal-header">
          <h2>项目管理</h2>
          <button onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {projects.length > 0 && (
            <div className="project-list">
              <h3>最近项目</h3>
              {projects.map(p => (
                <div key={p.id} className="project-card" onClick={() => onSelectProject(p.id)}>
                  <div className="project-card-main">
                    <span className="project-name">{p.name}</span>
                    <span className="project-path">{p.root_path}</span>
                    <span className="project-date">{new Date(p.updated_at).toLocaleDateString('zh-CN')}</span>
                  </div>
                  <label className="project-agent-binding" onClick={e => e.stopPropagation()}>
                    Agent 组
                    <select
                      value={projectGroupIds[p.id] ?? ''}
                      onChange={e => void handleBindProjectGroup(p.id, e.target.value)}
                    >
                      <option value="">不绑定</option>
                      {agentGroups.map(group => (
                        <option key={group.id} value={group.id}>{group.name}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="project-delete-btn"
                    title="删除项目"
                    aria-label={`删除项目 ${p.name}`}
                    disabled={deletingProjectId === p.id}
                    onClick={e => {
                      e.stopPropagation()
                      void handleDeleteProject(p)
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              {bindingStatus && <div className="project-binding-status">{bindingStatus}</div>}
            </div>
          )}

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
                  onChange={e => setRootPath(e.target.value)}
                  placeholder={name.trim() ? `例如：D:\\NovalWrite\\${name.trim()}（可留空）` : '例如：D:\\NovalWrite\\我的小说（可留空）'}
                  title="项目根目录：用于 TXT 导出的默认位置，也用于识别知识库文件是否属于当前项目。"
                />
                <button onClick={handleSelectFolder}>选择</button>
              </div>
            </label>
            <label>
              绑定 Agent 组
              <select value={selectedAgentGroupId} onChange={e => setSelectedAgentGroupId(e.target.value)}>
                <option value="">暂不绑定</option>
                {agentGroups.map(group => (
                  <option key={group.id} value={group.id}>{group.name}</option>
                ))}
              </select>
            </label>
            <button onClick={handleCreate} disabled={!name.trim()}>创建项目</button>
          </div>
        </div>
      </div>
    </div>
  )
}

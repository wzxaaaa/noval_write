import React, { useState, useEffect, useCallback } from 'react'
import { useAgentStore } from '../../stores/agent.store'
import { useAIStore } from '../../stores/ai.store'
import type { AgentGroup } from '../../../preload/types'

interface AgentConfigFormProps {
  projectId: string | null
  onClose: () => void
}

const AVAILABLE_TOOLS = [
  { value: 'search_knowledge_base', label: '搜索知识库' },
  { value: 'read_chapter', label: '读取章节' },
  { value: 'list_chapters', label: '列出章节' },
  { value: 'search_chapters', label: '搜索章节内容' },
  { value: 'fact_check_chapter', label: '事实核查' },
  { value: 'create_chapter', label: '创建章节' },
  { value: 'write_chapter', label: '写入章节' }
]

type Tab = 'agents' | 'groups'

interface GroupMemberForm {
  agent_id: string
  name: string
  role: string
  turn_order: number
  is_moderator: boolean
}

export function AgentConfigForm({ projectId, onClose }: AgentConfigFormProps) {
  const [activeTab, setActiveTab] = useState<Tab>(projectId ? 'groups' : 'agents')
  const { agents, categories, setAgents, addAgent, updateAgent, removeAgent, setCategories, addCategory, updateCategory, removeCategory, setGroups, addGroup, removeGroup } = useAgentStore()
  const { providers, setProviders } = useAIStore()
  const [managedGroups, setManagedGroups] = useState<AgentGroup[]>([])
  const [boundGroupId, setBoundGroupId] = useState<string>('')

  // Agent form
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null)
  const [agentForm, setAgentForm] = useState({
    name: '', description: '', role: '', system_prompt: '', model: '', tools: [] as string[], parameters: '{}', category_id: null as string | null
  })

  // Category management
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null)
  const [categoryForm, setCategoryForm] = useState({ name: '' })
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>({})
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<string | null>(null)

  // Group form
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [groupForm, setGroupForm] = useState({
    name: '', collaboration_mode: 'moderator' as 'round_robin' | 'moderator'
  })
  const [groupMembers, setGroupMembers] = useState<GroupMemberForm[]>([])

  useEffect(() => {
    window.electronAPI.agent.list().then(setAgents)
    window.electronAPI.agent.listCategories().then(setCategories)
    window.electronAPI.ai.listProviders().then(setProviders)
  }, [])

  const refreshManagedGroups = useCallback(async () => {
    const rows = await window.electronAPI.agent.listAllGroups()
    setManagedGroups(rows)
  }, [])

  const refreshProjectGroups = useCallback(async () => {
    if (!projectId) {
      setBoundGroupId('')
      return
    }
    const rows = await window.electronAPI.agent.listGroups(projectId)
    setGroups(rows)
    setBoundGroupId(rows[0]?.id ?? '')
  }, [projectId, setGroups])

  useEffect(() => {
    void refreshManagedGroups()
  }, [refreshManagedGroups])

  useEffect(() => {
    void refreshProjectGroups()
  }, [refreshProjectGroups])

  // --- Agent handlers ---
  const handleAgentSave = async () => {
    if (!agentForm.name || !agentForm.system_prompt || !agentForm.model) return
    const parsedParameters = parseAgentParameters(agentForm.parameters)
    if (!parsedParameters) return

    const params = {
      name: agentForm.name,
      description: agentForm.description,
      role: agentForm.role,
      system_prompt: agentForm.system_prompt,
      model: agentForm.model,
      tools: agentForm.tools,
      parameters: parsedParameters,
      category_id: agentForm.category_id
    }
    if (editingAgentId) {
      await window.electronAPI.agent.update(editingAgentId, params)
      // Reload agents list to get updated data from database
      const updatedAgents = await window.electronAPI.agent.list()
      setAgents(updatedAgents)
    } else {
      const created = await window.electronAPI.agent.create(params)
      addAgent(created)
    }
    resetAgentForm()
  }

  const resetAgentForm = () => {
    setEditingAgentId(null)
    setAgentForm({ name: '', description: '', role: '', system_prompt: '', model: '', tools: [], parameters: '{}', category_id: null })
  }

  const toggleTool = (tool: string) => {
    setAgentForm(f => ({
      ...f,
      tools: f.tools.includes(tool) ? f.tools.filter(t => t !== tool) : [...f.tools, tool]
    }))
  }

  // --- Category handlers ---
  const handleCategorySave = async () => {
    if (!categoryForm.name.trim()) return
    if (editingCategoryId) {
      await window.electronAPI.agent.updateCategory(editingCategoryId, categoryForm.name)
      updateCategory(editingCategoryId, categoryForm.name)
    } else {
      const created = await window.electronAPI.agent.createCategory(categoryForm.name)
      addCategory(created)
    }
    resetCategoryForm()
  }

  const resetCategoryForm = () => {
    setEditingCategoryId(null)
    setCategoryForm({ name: '' })
  }

  const handleCategoryDelete = async (id: string) => {
    if (!confirm('删除此分组？分组内的 Agent 不会被删除，只是移出分组。')) return
    await window.electronAPI.agent.deleteCategory(id)
    removeCategory(id)
  }

  const toggleCategoryCollapse = (categoryId: string) => {
    setCollapsedCategories(prev => ({ ...prev, [categoryId]: !prev[categoryId] }))
  }

  // --- Group handlers ---
  const handleGroupCreate = async () => {
    if (!groupForm.name) return
    const nextMembers = uniqueValidMembers(groupMembers)
    if (!validateGroupBeforeSave(groupForm.collaboration_mode, nextMembers)) return

    const created = await window.electronAPI.agent.createGroup(
      groupForm.name, projectId ?? null, groupForm.collaboration_mode
    )
    for (const m of nextMembers) {
      await window.electronAPI.agent.addGroupMember(
        created.id, m.agent_id, m.turn_order, true, m.is_moderator
      )
    }
    addGroup(created)
    resetGroupForm()
    await refreshManagedGroups()
    await refreshProjectGroups()
  }

  const handleGroupSave = async () => {
    if (!editingGroupId) return
    const nextMembers = uniqueValidMembers(groupMembers)
    if (!validateGroupBeforeSave(groupForm.collaboration_mode, nextMembers)) return

    await window.electronAPI.agent.updateGroup(editingGroupId, {
      name: groupForm.name,
      collaboration_mode: groupForm.collaboration_mode
    })
    const existingMembers = await window.electronAPI.agent.getGroupMembers(editingGroupId)
    const nextMemberIds = new Set(nextMembers.map(m => m.agent_id))
    for (const m of existingMembers) {
      if (!nextMemberIds.has(m.agent_id)) {
        await window.electronAPI.agent.removeGroupMember(editingGroupId, m.agent_id)
      }
    }
    for (const m of nextMembers) {
      await window.electronAPI.agent.addGroupMember(
        editingGroupId, m.agent_id, m.turn_order, true, m.is_moderator
      )
    }
    resetGroupForm()
    await refreshManagedGroups()
    await refreshProjectGroups()
  }

  const resetGroupForm = () => {
    setEditingGroupId(null)
    setGroupForm({ name: '', collaboration_mode: 'moderator' })
    setGroupMembers([])
  }

  const startEditGroup = async (groupId: string) => {
    setEditingGroupId(groupId)
    const group = managedGroups.find(g => g.id === groupId)
    if (!group) return
    setGroupForm({
      name: group.name,
      collaboration_mode: group.collaboration_mode
    })
    const members = await window.electronAPI.agent.getGroupMembers(groupId)
    setGroupMembers(members.map(m => ({
      agent_id: m.agent_id,
      name: m.name,
      role: m.role,
      turn_order: m.turn_order,
      is_moderator: m.is_moderator === 1
    })))
  }

  const addMemberToGroup = () => {
    setGroupMembers([...groupMembers, {
      agent_id: '', name: '', role: '', turn_order: groupMembers.length, is_moderator: false
    }])
  }

  const updateMember = (idx: number, field: string, value: any) => {
    setGroupMembers(prev => prev.map((m, i) => i === idx ? { ...m, [field]: value } : m))
  }

  const removeMemberFromGroup = (idx: number) => {
    setGroupMembers(prev => prev.filter((_, i) => i !== idx))
  }

  const bindGroupToCurrentProject = async (groupId: string | null) => {
    if (!projectId) return
    await window.electronAPI.agent.bindProjectGroup(projectId, groupId)
    await refreshProjectGroups()
    window.dispatchEvent(new CustomEvent('noval:project-agent-group-changed', { detail: { projectId } }))
  }

  const projectGroups = managedGroups

  // Group agents by category
  const agentsByCategory = React.useMemo(() => {
    const grouped: Record<string, typeof agents> = { uncategorized: [] }
    agents.forEach(agent => {
      const catId = agent.category_id || 'uncategorized'
      if (!grouped[catId]) grouped[catId] = []
      grouped[catId].push(agent)
    })
    return grouped
  }, [agents])

  // Filter agents by selected category
  const filteredAgents = React.useMemo(() => {
    if (!selectedCategoryFilter) return agents
    if (selectedCategoryFilter === 'uncategorized') {
      return agents.filter(a => !a.category_id)
    }
    return agents.filter(a => a.category_id === selectedCategoryFilter)
  }, [agents, selectedCategoryFilter])

  return (
    <div className="modal-overlay">
      <div className="modal agent-config-modal" style={{ maxWidth: 750 }}>
        <div className="modal-header">
          <h2>Agent 管理</h2>
          <button onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="tab-bar">
            <button className={`tab-btn ${activeTab === 'agents' ? 'active' : ''}`} onClick={() => setActiveTab('agents')}>
              Agent 列表
            </button>
            <button className={`tab-btn ${activeTab === 'groups' ? 'active' : ''}`} onClick={() => setActiveTab('groups')}>
              Agent 组
            </button>
          </div>

          {/* === AGENTS TAB === */}
          {activeTab === 'agents' && (
            <div className="tab-content">
              {/* Category Management Section */}
              <div style={{ marginBottom: 16, padding: '12px', background: 'var(--bg-surface)', borderRadius: 'var(--radius)', border: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <h4 style={{ fontSize: 13, margin: 0 }}>分组管理</h4>
                </div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <input
                    value={categoryForm.name}
                    onChange={e => setCategoryForm({ name: e.target.value })}
                    placeholder="输入分组名称..."
                    style={{ flex: 1, padding: '6px 8px', fontSize: 12 }}
                  />
                  <button onClick={handleCategorySave} disabled={!categoryForm.name.trim()} style={{ fontSize: 12, padding: '6px 12px' }}>
                    {editingCategoryId ? '更新' : '添加分组'}
                  </button>
                  {editingCategoryId && (
                    <button onClick={resetCategoryForm} style={{ fontSize: 12, padding: '6px 12px' }}>取消</button>
                  )}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  <button
                    onClick={() => setSelectedCategoryFilter(null)}
                    style={{
                      fontSize: 11, padding: '4px 10px', borderRadius: 12,
                      background: selectedCategoryFilter === null ? 'var(--accent-primary)' : 'var(--bg-hover)',
                      color: selectedCategoryFilter === null ? 'white' : 'var(--text-primary)',
                      border: '1px solid var(--border-color)'
                    }}
                  >
                    全部 ({agents.length})
                  </button>
                  <button
                    onClick={() => setSelectedCategoryFilter('uncategorized')}
                    style={{
                      fontSize: 11, padding: '4px 10px', borderRadius: 12,
                      background: selectedCategoryFilter === 'uncategorized' ? 'var(--accent-primary)' : 'var(--bg-hover)',
                      color: selectedCategoryFilter === 'uncategorized' ? 'white' : 'var(--text-primary)',
                      border: '1px solid var(--border-color)'
                    }}
                  >
                    未分组 ({agentsByCategory.uncategorized?.length || 0})
                  </button>
                  {categories.map(cat => (
                    <button
                      key={cat.id}
                      onClick={() => setSelectedCategoryFilter(cat.id)}
                      style={{
                        fontSize: 11, padding: '4px 10px', borderRadius: 12,
                        background: selectedCategoryFilter === cat.id ? 'var(--accent-primary)' : 'var(--bg-hover)',
                        color: selectedCategoryFilter === cat.id ? 'white' : 'var(--text-primary)',
                        border: '1px solid var(--border-color)',
                        display: 'flex', alignItems: 'center', gap: 4
                      }}
                    >
                      {cat.name} ({agentsByCategory[cat.id]?.length || 0})
                      <span
                        onClick={(e) => {
                          e.stopPropagation()
                          setEditingCategoryId(cat.id)
                          setCategoryForm({ name: cat.name })
                        }}
                        style={{ cursor: 'pointer', marginLeft: 2 }}
                        title="编辑分组"
                      >✏️</span>
                      <span
                        onClick={(e) => {
                          e.stopPropagation()
                          handleCategoryDelete(cat.id)
                        }}
                        style={{ cursor: 'pointer', color: 'var(--accent-danger)' }}
                        title="删除分组"
                      >✕</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Agent List - Grouped by Category */}
              <div className="agent-list">
                {filteredAgents.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>还没有 Agent，在下方创建</p>}

                {!selectedCategoryFilter && categories.map(cat => {
                  const categoryAgents = agentsByCategory[cat.id] || []
                  if (categoryAgents.length === 0) return null
                  const isCollapsed = collapsedCategories[cat.id]

                  return (
                    <div key={cat.id} style={{ marginBottom: 12 }}>
                      <div
                        onClick={() => toggleCategoryCollapse(cat.id)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                          background: 'var(--bg-surface)', borderRadius: 'var(--radius)',
                          cursor: 'pointer', fontWeight: 600, fontSize: 13,
                          border: '1px solid var(--border-color)'
                        }}
                      >
                        <span>{isCollapsed ? '▶' : '▼'}</span>
                        <span>{cat.name}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>({categoryAgents.length})</span>
                      </div>
                      {!isCollapsed && categoryAgents.map(a => (
                        <div key={a.id} className={`agent-card ${editingAgentId === a.id ? 'editing' : ''}`} style={{ marginLeft: 20, marginTop: 6 }}>
                          <div className="agent-info">
                            <span className="agent-name">{a.name}</span>
                            <span className="agent-role">{a.role}</span>
                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                              {parseAgentTools(a.tools).length} 工具
                            </span>
                          </div>
                          <div className="agent-actions">
                            <button onClick={() => {
                              setEditingAgentId(a.id)
                              setAgentForm({
                                name: a.name,
                                description: a.description || '',
                                role: a.role,
                                system_prompt: a.system_prompt,
                                model: a.model,
                                tools: parseAgentTools(a.tools),
                                parameters: a.parameters,
                                category_id: a.category_id
                              })
                            }}>编辑</button>
                            <button onClick={async () => {
                              await window.electronAPI.agent.delete(a.id)
                              removeAgent(a.id)
                            }}>删除</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                })}

                {!selectedCategoryFilter && agentsByCategory.uncategorized?.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div
                      onClick={() => toggleCategoryCollapse('uncategorized')}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                        background: 'var(--bg-surface)', borderRadius: 'var(--radius)',
                        cursor: 'pointer', fontWeight: 600, fontSize: 13,
                        border: '1px solid var(--border-color)'
                      }}
                    >
                      <span>{collapsedCategories.uncategorized ? '▶' : '▼'}</span>
                      <span>未分组</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>({agentsByCategory.uncategorized.length})</span>
                    </div>
                    {!collapsedCategories.uncategorized && agentsByCategory.uncategorized.map(a => (
                      <div key={a.id} className={`agent-card ${editingAgentId === a.id ? 'editing' : ''}`} style={{ marginLeft: 20, marginTop: 6 }}>
                        <div className="agent-info">
                          <span className="agent-name">{a.name}</span>
                          <span className="agent-role">{a.role}</span>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            {parseAgentTools(a.tools).length} 工具
                          </span>
                        </div>
                        <div className="agent-actions">
                          <button onClick={() => {
                            setEditingAgentId(a.id)
                            setAgentForm({
                              name: a.name,
                              description: a.description || '',
                              role: a.role,
                              system_prompt: a.system_prompt,
                              model: a.model,
                                tools: parseAgentTools(a.tools),
                              parameters: a.parameters,
                              category_id: a.category_id
                            })
                          }}>编辑</button>
                          <button onClick={async () => {
                            await window.electronAPI.agent.delete(a.id)
                            removeAgent(a.id)
                          }}>删除</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Filtered view */}
                {selectedCategoryFilter && filteredAgents.map(a => (
                  <div key={a.id} className={`agent-card ${editingAgentId === a.id ? 'editing' : ''}`}>
                    <div className="agent-info">
                      <span className="agent-name">{a.name}</span>
                      <span className="agent-role">{a.role}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {parseAgentTools(a.tools).length} 工具
                      </span>
                    </div>
                    <div className="agent-actions">
                      <button onClick={() => {
                        setEditingAgentId(a.id)
                        setAgentForm({
                          name: a.name,
                          description: a.description || '',
                          role: a.role,
                          system_prompt: a.system_prompt,
                          model: a.model,
                          tools: parseAgentTools(a.tools),
                          parameters: a.parameters,
                          category_id: a.category_id
                        })
                      }}>编辑</button>
                      <button onClick={async () => {
                        await window.electronAPI.agent.delete(a.id)
                        removeAgent(a.id)
                      }}>删除</button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="agent-form">
                <h3>{editingAgentId ? `编辑: ${agentForm.name}` : '新建 Agent'}</h3>
                <label>名称 <input value={agentForm.name} onChange={e => setAgentForm({ ...agentForm, name: e.target.value })} placeholder="例如: 创作编辑" /></label>
                <label>描述 <input value={agentForm.description} onChange={e => setAgentForm({ ...agentForm, description: e.target.value })} placeholder="职责简述" /></label>
                <label>角色 <input value={agentForm.role} onChange={e => setAgentForm({ ...agentForm, role: e.target.value })} placeholder="例如: 情节审稿人" /></label>
                <label>
                  所属分组
                  <select value={agentForm.category_id || ''} onChange={e => setAgentForm({ ...agentForm, category_id: e.target.value || null })}>
                    <option value="">未分组</option>
                    {categories.map(cat => (
                      <option key={cat.id} value={cat.id}>{cat.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  系统提示词
                  <textarea value={agentForm.system_prompt} onChange={e => setAgentForm({ ...agentForm, system_prompt: e.target.value })}
                    placeholder="定义此 Agent 的行为和写作风格..." rows={5} />
                </label>
                <label>
                  使用模型
                  <select value={agentForm.model} onChange={e => setAgentForm({ ...agentForm, model: e.target.value })}>
                    <option value="">选择模型配置...</option>
                    {providers.map(p => (
                      <option key={p.id} value={p.id}>{p.name} ({p.model})</option>
                    ))}
                  </select>
                </label>
                <label>
                  可用工具
                  <div className="tools-checkboxes">
                    {AVAILABLE_TOOLS.map(t => (
                      <label key={t.value} className="checkbox-label">
                        <input type="checkbox" checked={agentForm.tools.includes(t.value)} onChange={() => toggleTool(t.value)} />
                        {t.label}
                      </label>
                    ))}
                  </div>
                </label>
                <label>
                  参数 (JSON)
                  <textarea value={agentForm.parameters} onChange={e => setAgentForm({ ...agentForm, parameters: e.target.value })}
                    placeholder='{"temperature": 0.8, "max_tokens": 2048}' rows={2} style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }} />
                </label>
                <div className="form-actions">
                  <button onClick={handleAgentSave}>{editingAgentId ? '更新 Agent' : '创建 Agent'}</button>
                  {editingAgentId && <button onClick={resetAgentForm}>取消编辑</button>}
                </div>
              </div>
            </div>
          )}

          {/* === GROUPS TAB === */}
          {activeTab === 'groups' && (
            <div className="tab-content">
              {agents.length === 0 ? (
                <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>
                  <p>请先在「Agent 列表」中创建 Agent</p>
                </div>
              ) : (
                <>
                  <div className="group-list">
                    <h3>已有 Agent 组</h3>
                    {projectGroups.length === 0 && (
                      <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>还没有 Agent 组，在下方创建</p>
                    )}
                    {projectGroups.map(g => (
                      <div key={g.id} className={`agent-card ${editingGroupId === g.id ? 'editing' : ''}`}>
                        <div className="agent-info">
                          <span className="agent-name">{g.name}</span>
                          <span className={`provider-badge ${g.collaboration_mode === 'moderator' ? '' : ''}`}
                            style={{ background: g.collaboration_mode === 'moderator' ? 'var(--accent-success)' : 'var(--accent-primary)' }}>
                            {g.collaboration_mode === 'moderator' ? '主编模式' : '轮询模式'}
                          </span>
                        </div>
                        <div className="agent-actions">
                          {projectId && (
                            <button onClick={() => bindGroupToCurrentProject(boundGroupId === g.id ? null : g.id)}>
                              {boundGroupId === g.id ? '已绑定' : '绑定到项目'}
                            </button>
                          )}
                          <button onClick={() => startEditGroup(g.id)}>编辑</button>
                          <button onClick={async () => {
                            await window.electronAPI.agent.deleteGroup(g.id)
                            removeGroup(g.id)
                            await refreshManagedGroups()
                            await refreshProjectGroups()
                          }}>删除</button>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="agent-form" style={{ marginTop: 16, borderTop: '1px solid var(--border-color)', paddingTop: 16 }}>
                    <h3>{editingGroupId ? `编辑组: ${groupForm.name}` : '创建 Agent 组'}</h3>

                    <label>组名称 <input value={groupForm.name} onChange={e => setGroupForm({ ...groupForm, name: e.target.value })} placeholder="例如: 小说审稿团队" /></label>

                    <label>
                      协作模式
                      <select value={groupForm.collaboration_mode} onChange={e => setGroupForm({ ...groupForm, collaboration_mode: e.target.value as any })}>
                        <option value="moderator">主编模式 — 一个 Agent 调用其他 Agent 协作</option>
                        <option value="round_robin">轮询模式 — 按顺序轮流对话</option>
                      </select>
                    </label>

                    {!editingGroupId && (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                        {projectId
                          ? <>新建后会自动绑定到当前项目: <code style={{ background: 'var(--bg-surface)', padding: '2px 6px', borderRadius: 4 }}>{projectId}</code></>
                          : <span>将创建可被多个项目复用的独立 Agent 组</span>
                        }
                      </div>
                    )}

                    {/* Members */}
                    <div style={{ marginTop: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <h4 style={{ fontSize: 13, color: 'var(--text-secondary)' }}>组成员</h4>
                        <button onClick={addMemberToGroup} style={{ background: 'var(--bg-hover)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', padding: '4px 12px', borderRadius: 'var(--radius)', cursor: 'pointer', fontSize: 12 }}>+ 添加成员</button>
                      </div>

                      {groupMembers.map((m, i) => (
                        <div key={i} className="agent-member-card" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                          <select
                            value={m.agent_id}
                            onChange={e => {
                              const agent = agents.find(a => a.id === e.target.value)
                              updateMember(i, 'agent_id', e.target.value)
                              if (agent) {
                                updateMember(i, 'name', agent.name)
                                updateMember(i, 'role', agent.role)
                              }
                            }}
                            style={{ flex: 2, background: 'var(--bg-surface)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', padding: '6px 8px', borderRadius: 'var(--radius)', fontSize: 12 }}
                          >
                            <option value="">选择 Agent...</option>
                            {agents.map(a => (
                              <option key={a.id} value={a.id}>{a.name} ({a.role})</option>
                            ))}
                          </select>
                          <input type="number" value={m.turn_order} min={0}
                            onChange={e => updateMember(i, 'turn_order', parseInt(e.target.value) || 0)}
                            style={{ width: 60, background: 'var(--bg-surface)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', padding: '6px 8px', borderRadius: 'var(--radius)', fontSize: 12 }}
                            title="轮次顺序"
                          />
                          {groupForm.collaboration_mode === 'moderator' && (
                            <label className="checkbox-label" style={{ margin: 0, fontSize: 12, whiteSpace: 'nowrap' }}>
                              <input type="checkbox" checked={m.is_moderator}
                                onChange={e => {
                                  // Only one moderator allowed
                                  if (e.target.checked) {
                                    setGroupMembers(prev => prev.map((pm, pi) => ({ ...pm, is_moderator: pi === i })))
                                  } else {
                                    updateMember(i, 'is_moderator', false)
                                  }
                                }} />
                              主编
                            </label>
                          )}
                          <button onClick={() => removeMemberFromGroup(i)}
                            style={{ background: 'transparent', border: 'none', color: 'var(--accent-danger)', cursor: 'pointer', fontSize: 16 }}>✕</button>
                        </div>
                      ))}

                      {groupForm.collaboration_mode === 'moderator' && groupMembers.length > 0 && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                          提示: 勾选一个 Agent 作为「主编」，它将能调用组内其他 Agent 执行任务
                        </div>
                      )}
                    </div>

                    <div className="form-actions" style={{ marginTop: 16 }}>
                      <button onClick={editingGroupId ? handleGroupSave : handleGroupCreate}>
                        {editingGroupId ? '更新组' : '创建 Agent 组'}
                      </button>
                      {editingGroupId && <button onClick={resetGroupForm}>取消</button>}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function uniqueValidMembers(members: GroupMemberForm[]): GroupMemberForm[] {
  const seen = new Set<string>()
  const result: GroupMemberForm[] = []
  for (const member of members) {
    if (!member.agent_id || seen.has(member.agent_id)) continue
    seen.add(member.agent_id)
    result.push(member)
  }
  return result
}

function parseAgentTools(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((tool): tool is string => typeof tool === 'string') : []
  } catch {
    return []
  }
}

function parseAgentParameters(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      alert('参数 JSON 必须是对象，例如 {"temperature": 0.8}')
      return null
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    alert(`参数 JSON 格式错误：${(err as Error).message}`)
    return null
  }
}

function validateGroupBeforeSave(mode: 'round_robin' | 'moderator', members: GroupMemberForm[]): boolean {
  if (members.length === 0) {
    alert('请至少添加一个 Agent 成员')
    return false
  }

  if (mode !== 'moderator') return true

  const moderators = members.filter(member => member.is_moderator)
  if (moderators.length !== 1) {
    alert('主编模式必须且只能设置一个主编 Agent')
    return false
  }

  if (members.length < 2) {
    alert('主编模式除主编外还需要至少一个工作 Agent')
    return false
  }

  return true
}

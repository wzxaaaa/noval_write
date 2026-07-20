import React, { useEffect, useMemo, useState } from 'react'
import { useAgentStore } from '../../stores/agent.store'
import { useAIStore } from '../../stores/ai.store'
import { WRITING_AGENT_DEFINITIONS, type WritingAgentRole } from '../../../shared/writingAgents'
import type { AgentConfig } from '../../../preload/types'
import { ModalDialog } from '../common/ModalDialog'

interface AgentConfigFormProps {
  projectId: string | null
  onClose: () => void
}

interface AgentDraft {
  provider_config_id: string
  system_prompt: string
  parameters: string
}

export function AgentConfigForm({ onClose }: AgentConfigFormProps) {
  const { agents, setAgents } = useAgentStore()
  const { providers, setProviders } = useAIStore()
  const [drafts, setDrafts] = useState<Record<string, AgentDraft>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [savingRole, setSavingRole] = useState<WritingAgentRole | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    void refresh()
  }, [])

  const refresh = async () => {
    const [team, providerRows] = await Promise.all([
      window.electronAPI.agent.getWritingTeam(),
      window.electronAPI.ai.listProviders()
    ])
    setAgents(team)
    setProviders(providerRows)
    setDrafts(buildDrafts(team))
  }

  const agentByRole = useMemo(() => {
    return Object.fromEntries(
      agents
        .filter(agent => agent.pipeline_role)
        .map(agent => [agent.pipeline_role, agent])
    ) as Partial<Record<WritingAgentRole, AgentConfig>>
  }, [agents])

  const providerNameById = useMemo(() => {
    return new Map(providers.map(provider => [provider.id, `${provider.name} (${provider.model})`]))
  }, [providers])

  const updateDraft = (role: WritingAgentRole, patch: Partial<AgentDraft>) => {
    const current = prevDraftOrDefault(drafts[role])
    setDrafts(prev => ({
      ...prev,
      [role]: { ...current, ...(prev[role] ?? {}), ...patch }
    }))
  }

  const saveRole = async (role: WritingAgentRole) => {
    const draft = drafts[role]
    if (!draft) return
    const parameters = parseParameters(draft.parameters)
    if (!parameters) return

    setSavingRole(role)
    setStatus(null)
    try {
      const updated = await window.electronAPI.agent.updateWritingAgent(role, {
        provider_config_id: draft.provider_config_id || null,
        system_prompt: draft.system_prompt,
        parameters
      })
      const team = await window.electronAPI.agent.getWritingTeam()
      setAgents(team)
      setDrafts(buildDrafts(team))
      setStatus(`已保存「${updated.name}」`)
    } catch (err) {
      setStatus((err as Error).message || '保存失败')
    } finally {
      setSavingRole(null)
    }
  }

  const saveAll = async () => {
    for (const definition of WRITING_AGENT_DEFINITIONS) {
      await saveRole(definition.role)
    }
  }

  return (
    <ModalDialog title="固定写作团队" onClose={onClose} className="agent-config-modal" style={{ maxWidth: 820 }}>
      <div className="modal-body">
          <div style={{ marginBottom: 14, color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.7 }}>
            系统只使用这一组固定 Agent。每次运行都会按顺序完成：规划、连续性检查、角色校准、世界观细节、场景设计、初稿、文风编辑、质检、修订回写。
          </div>

          {providers.length === 0 && (
            <div style={{ marginBottom: 14, padding: 12, border: '1px solid rgba(239,68,68,0.35)', borderRadius: 8, color: 'var(--text-primary)', background: 'rgba(239,68,68,0.08)' }}>
              还没有可用模型配置。请先在设置里添加 API 模型，否则团队无法运行。
            </div>
          )}

          <div className="agent-list">
            {WRITING_AGENT_DEFINITIONS.map(definition => {
              const role = definition.role
              const agent = agentByRole[role]
              const draft = drafts[role] ?? {
                provider_config_id: agent?.provider_config_id || agent?.model || '',
                system_prompt: agent?.system_prompt || definition.systemPrompt,
                parameters: agent?.parameters || JSON.stringify(definition.defaultParameters, null, 2)
              }
              const isExpanded = expanded[role] ?? false

              return (
                <div key={role} className="agent-card" style={{ display: 'block' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr minmax(220px, 280px) auto', gap: 10, alignItems: 'center' }}>
                    <div className="agent-info">
                      <span className="agent-name">{definition.order + 1}. {agent?.name || definition.name}</span>
                      <span className="agent-role">{definition.title}</span>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>{definition.description}</span>
                    </div>

                    <select
                      value={draft.provider_config_id}
                      onChange={event => updateDraft(role, { provider_config_id: event.target.value })}
                      disabled={providers.length === 0 || savingRole === role}
                      title="绑定这个岗位使用的模型"
                    >
                      <option value="">选择模型...</option>
                      {providers.map(provider => (
                        <option key={provider.id} value={provider.id}>
                          {provider.name} ({provider.model})
                        </option>
                      ))}
                    </select>

                    <div className="agent-actions">
                      <button onClick={() => setExpanded(prev => ({ ...prev, [role]: !isExpanded }))}>
                        {isExpanded ? '收起' : '高级'}
                      </button>
                      <button onClick={() => void saveRole(role)} disabled={!draft.provider_config_id || savingRole === role}>
                        {savingRole === role ? '保存中' : '保存'}
                      </button>
                    </div>
                  </div>

                  <div style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 12 }}>
                    当前模型：{draft.provider_config_id ? providerNameById.get(draft.provider_config_id) || '未知模型配置' : '未绑定'}
                  </div>

                  {isExpanded && (
                    <div className="agent-form" style={{ marginTop: 12, borderTop: '1px solid var(--border-color)', paddingTop: 12 }}>
                      <label>
                        岗位提示词
                        <textarea
                          value={draft.system_prompt}
                          onChange={event => updateDraft(role, { system_prompt: event.target.value })}
                          rows={5}
                        />
                      </label>
                      <label>
                        参数 JSON
                        <textarea
                          value={draft.parameters}
                          onChange={event => updateDraft(role, { parameters: event.target.value })}
                          rows={3}
                          style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
                        />
                      </label>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {status && (
            <div style={{ marginTop: 12, color: 'var(--text-secondary)', fontSize: 13 }}>{status}</div>
          )}

          <div className="form-actions" style={{ marginTop: 16 }}>
            <button onClick={() => void saveAll()} disabled={providers.length === 0 || savingRole !== null}>
              保存全部岗位
            </button>
            <button onClick={onClose}>完成</button>
          </div>
      </div>
    </ModalDialog>
  )
}

function buildDrafts(team: AgentConfig[]): Record<string, AgentDraft> {
  const result: Record<string, AgentDraft> = {}
  for (const definition of WRITING_AGENT_DEFINITIONS) {
    const agent = team.find(row => row.pipeline_role === definition.role)
    result[definition.role] = {
      provider_config_id: agent?.provider_config_id || agent?.model || '',
      system_prompt: agent?.system_prompt || definition.systemPrompt,
      parameters: formatParameters(agent?.parameters, definition.defaultParameters)
    }
  }
  return result
}

function prevDraftOrDefault(draft: AgentDraft | undefined): AgentDraft {
  return draft ?? {
    provider_config_id: '',
    system_prompt: '',
    parameters: '{}'
  }
}

function formatParameters(raw: string | undefined, fallback: Record<string, unknown>): string {
  if (!raw) return JSON.stringify(fallback, null, 2)
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return JSON.stringify(fallback, null, 2)
  }
}

function parseParameters(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      alert('参数 JSON 必须是对象，例如 {"temperature": 0.7}')
      return null
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    alert(`参数 JSON 格式错误：${(err as Error).message}`)
    return null
  }
}

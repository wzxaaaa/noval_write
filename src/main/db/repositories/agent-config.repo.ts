import { getDb } from '../connection'
import { randomUUID } from 'crypto'
import { WRITING_AGENT_DEFINITIONS, type WritingAgentRole } from '../../../shared/writingAgents'

export interface AgentConfigRow {
  id: string
  name: string
  description: string | null
  role: string
  system_prompt: string
  model: string
  provider_config_id: string | null
  pipeline_role: WritingAgentRole | null
  is_system: number
  tools: string
  parameters: string
  category_id: string | null
  created_at: string
}

export interface AgentConfigCreate {
  name: string
  description?: string
  role: string
  system_prompt: string
  model: string
  provider_config_id?: string | null
  pipeline_role?: WritingAgentRole | null
  is_system?: boolean
  tools?: string[]
  parameters?: Record<string, unknown>
  category_id?: string | null
}

export interface WritingAgentUpdate {
  provider_config_id?: string | null
  system_prompt?: string
  parameters?: Record<string, unknown>
}

export class AgentConfigRepo {
  create(params: AgentConfigCreate): AgentConfigRow {
    const db = getDb()
    const id = randomUUID()
    const requestedProviderId = params.provider_config_id !== undefined
      ? params.provider_config_id
      : params.model
    const providerConfigId = resolveProviderConfigId(db, requestedProviderId)
    db.prepare(
      'INSERT INTO agent_configs (id, name, description, role, system_prompt, model, provider_config_id, pipeline_role, is_system, tools, parameters, category_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id,
      params.name,
      params.description ?? null,
      params.role,
      params.system_prompt,
      params.model,
      providerConfigId,
      params.pipeline_role ?? null,
      params.is_system ? 1 : 0,
      JSON.stringify(params.tools ?? []),
      JSON.stringify(params.parameters ?? {}),
      params.category_id ?? null
    )
    return this.getById(id)!
  }

  getById(id: string): AgentConfigRow | undefined {
    return getDb().prepare('SELECT * FROM agent_configs WHERE id = ?').get(id) as AgentConfigRow | undefined
  }

  list(): AgentConfigRow[] {
    return getDb().prepare('SELECT * FROM agent_configs ORDER BY created_at DESC').all() as AgentConfigRow[]
  }

  update(id: string, updates: Partial<AgentConfigCreate>): void {
    const db = getDb()
    const fields: string[] = []
    const values: unknown[] = []

    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name) }
    if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description) }
    if (updates.role !== undefined) { fields.push('role = ?'); values.push(updates.role) }
    if (updates.system_prompt !== undefined) { fields.push('system_prompt = ?'); values.push(updates.system_prompt) }
    if (updates.model !== undefined) {
      fields.push('model = ?')
      values.push(updates.model)
      if (updates.provider_config_id === undefined) {
        fields.push('provider_config_id = ?')
        values.push(resolveProviderConfigId(db, updates.model))
      }
    }
    if (updates.provider_config_id !== undefined) {
      fields.push('provider_config_id = ?')
      values.push(resolveProviderConfigId(db, updates.provider_config_id))
    }
    if (updates.pipeline_role !== undefined) { fields.push('pipeline_role = ?'); values.push(updates.pipeline_role) }
    if (updates.is_system !== undefined) { fields.push('is_system = ?'); values.push(updates.is_system ? 1 : 0) }
    if (updates.tools !== undefined) { fields.push('tools = ?'); values.push(JSON.stringify(updates.tools)) }
    if (updates.parameters !== undefined) { fields.push('parameters = ?'); values.push(JSON.stringify(updates.parameters)) }
    if (updates.category_id !== undefined) { fields.push('category_id = ?'); values.push(updates.category_id) }

    if (fields.length === 0) return
    values.push(id)
    db.prepare(`UPDATE agent_configs SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }

  delete(id: string): void {
    getDb().prepare('DELETE FROM agent_configs WHERE id = ?').run(id)
  }

  getWritingTeam(): AgentConfigRow[] {
    this.ensureWritingTeam()
    const roles = WRITING_AGENT_DEFINITIONS.map(definition => definition.role)
    const placeholders = roles.map(() => '?').join(', ')
    const rows = getDb()
      .prepare(`SELECT * FROM agent_configs WHERE pipeline_role IN (${placeholders})`)
      .all(...roles) as AgentConfigRow[]
    const order = new Map(WRITING_AGENT_DEFINITIONS.map(definition => [definition.role, definition.order]))
    return rows.sort((a, b) => (order.get(a.pipeline_role!) ?? 999) - (order.get(b.pipeline_role!) ?? 999))
  }

  updateWritingAgent(role: WritingAgentRole, updates: WritingAgentUpdate): AgentConfigRow {
    this.ensureWritingTeam()
    const agent = this.getByPipelineRole(role)
    if (!agent) throw new Error(`固定写作团队缺少岗位：${role}`)

    const nextParams = updates.parameters === undefined
      ? parseParameters(agent.parameters)
      : updates.parameters
    nextParams.pipeline_role = role

    this.update(agent.id, {
      provider_config_id: updates.provider_config_id,
      model: updates.provider_config_id === null ? '' : updates.provider_config_id ?? agent.model,
      system_prompt: updates.system_prompt,
      parameters: nextParams
    })

    return this.getById(agent.id)!
  }

  ensureWritingTeam(): AgentConfigRow[] {
    const db = getDb()
    const defaultProvider = db
      .prepare('SELECT id FROM provider_configs ORDER BY is_default DESC, datetime(created_at) ASC LIMIT 1')
      .get() as { id: string } | undefined
    const defaultProviderId = defaultProvider?.id ?? null

    for (const definition of WRITING_AGENT_DEFINITIONS) {
      const existing = this.getByPipelineRole(definition.role) ?? this.findLegacyPipelineAgent(definition.role)
      const existingProviderId = resolveProviderConfigId(
        db,
        existing?.provider_config_id || existing?.model || null
      )
      const providerId = existingProviderId ?? defaultProviderId
      const parameters = {
        ...definition.defaultParameters,
        ...parseParameters(existing?.parameters),
        pipeline_role: definition.role
      }

      if (existing) {
        this.update(existing.id, {
          name: definition.name,
          description: definition.description,
          role: definition.title,
          provider_config_id: providerId,
          model: providerId ?? '',
          pipeline_role: definition.role,
          is_system: true,
          tools: [],
          parameters
        })
        continue
      }

      this.create({
        name: definition.name,
        description: definition.description,
        role: definition.title,
        system_prompt: definition.systemPrompt,
        model: defaultProviderId ?? '',
        provider_config_id: defaultProviderId,
        pipeline_role: definition.role,
        is_system: true,
        tools: [],
        parameters
      })
    }

    return this.getWritingTeamRowsWithoutEnsuring()
  }

  private getWritingTeamRowsWithoutEnsuring(): AgentConfigRow[] {
    const roles = WRITING_AGENT_DEFINITIONS.map(definition => definition.role)
    const placeholders = roles.map(() => '?').join(', ')
    const rows = getDb()
      .prepare(`SELECT * FROM agent_configs WHERE pipeline_role IN (${placeholders})`)
      .all(...roles) as AgentConfigRow[]
    const order = new Map(WRITING_AGENT_DEFINITIONS.map(definition => [definition.role, definition.order]))
    return rows.sort((a, b) => (order.get(a.pipeline_role!) ?? 999) - (order.get(b.pipeline_role!) ?? 999))
  }

  private getByPipelineRole(role: WritingAgentRole): AgentConfigRow | undefined {
    return getDb().prepare('SELECT * FROM agent_configs WHERE pipeline_role = ?').get(role) as AgentConfigRow | undefined
  }

  private findLegacyPipelineAgent(role: WritingAgentRole): AgentConfigRow | undefined {
    const rows = this.list()
    return rows.find(row => {
      const params = parseParameters(row.parameters)
      return params.pipeline_role === role || params.pipelineRole === role
    })
  }
}

function parseParameters(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function resolveProviderConfigId(
  db: ReturnType<typeof getDb>,
  candidate: string | null | undefined
): string | null {
  const providerId = candidate?.trim()
  if (!providerId) return null
  const exists = db.prepare('SELECT 1 FROM provider_configs WHERE id = ?').get(providerId)
  return exists ? providerId : null
}

export const agentConfigRepo = new AgentConfigRepo()

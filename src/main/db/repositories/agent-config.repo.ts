import { getDb } from '../connection'
import { randomUUID } from 'crypto'

export interface AgentConfigRow {
  id: string
  name: string
  description: string | null
  role: string
  system_prompt: string
  model: string
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
  tools?: string[]
  parameters?: Record<string, unknown>
  category_id?: string | null
}

export interface AgentCategoryRow {
  id: string
  name: string
  created_at: string
}

export interface AgentGroupRow {
  id: string
  name: string
  project_id: string | null
  collaboration_mode: 'round_robin' | 'moderator'
  created_at: string
}

export interface AgentGroupMemberRow {
  group_id: string
  agent_id: string
  turn_order: number
  can_initiate: number
  is_moderator: number
  routing_rules: string
}

export class AgentConfigRepo {
  create(params: AgentConfigCreate): AgentConfigRow {
    const db = getDb()
    const id = randomUUID()
    db.prepare(
      'INSERT INTO agent_configs (id, name, description, role, system_prompt, model, tools, parameters, category_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id,
      params.name,
      params.description ?? null,
      params.role,
      params.system_prompt,
      params.model,
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
    if (updates.model !== undefined) { fields.push('model = ?'); values.push(updates.model) }
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

  // Agent Groups
  createGroup(name: string, projectId?: string | null, collaborationMode: 'round_robin' | 'moderator' = 'round_robin'): AgentGroupRow {
    const db = getDb()
    const id = randomUUID()
    db.prepare('INSERT INTO agent_groups (id, name, project_id, collaboration_mode) VALUES (?, ?, ?, ?)').run(id, name, projectId ?? null, collaborationMode)
    if (projectId) {
      this.bindProjectGroup(projectId, id)
    }
    return this.getGroupById(id)!
  }

  getGroupById(id: string): AgentGroupRow | undefined {
    return getDb().prepare('SELECT * FROM agent_groups WHERE id = ?').get(id) as AgentGroupRow | undefined
  }

  listGroupsByProject(projectId: string): AgentGroupRow[] {
    const project = getDb()
      .prepare('SELECT default_agent_group_id FROM projects WHERE id = ?')
      .get(projectId) as { default_agent_group_id: string | null } | undefined

    if (project?.default_agent_group_id) {
      const group = this.getGroupById(project.default_agent_group_id)
      return group ? [group] : []
    }

    return getDb()
      .prepare('SELECT * FROM agent_groups WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as AgentGroupRow[]
  }

  listGroups(): AgentGroupRow[] {
    return getDb().prepare('SELECT * FROM agent_groups ORDER BY created_at DESC').all() as AgentGroupRow[]
  }

  bindProjectGroup(projectId: string, groupId: string | null): void {
    getDb()
      .prepare("UPDATE projects SET default_agent_group_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(groupId, projectId)
  }

  updateGroup(id: string, updates: { name?: string; collaboration_mode?: 'round_robin' | 'moderator' }): void {
    const db = getDb()
    const fields: string[] = []
    const values: unknown[] = []
    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name) }
    if (updates.collaboration_mode !== undefined) { fields.push('collaboration_mode = ?'); values.push(updates.collaboration_mode) }
    values.push(id)
    if (fields.length > 0) {
      db.prepare(`UPDATE agent_groups SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    }
  }

  addGroupMember(groupId: string, agentId: string, turnOrder: number, canInitiate: boolean = true, isModerator: boolean = false, routingRules: Record<string, unknown> = {}): void {
    getDb().prepare(
      'INSERT OR REPLACE INTO agent_group_members (group_id, agent_id, turn_order, can_initiate, is_moderator, routing_rules) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(groupId, agentId, turnOrder, canInitiate ? 1 : 0, isModerator ? 1 : 0, JSON.stringify(routingRules))
  }

  getGroupMembers(groupId: string): (AgentGroupMemberRow & AgentConfigRow)[] {
    return getDb().prepare(`
      SELECT agm.*, ac.* FROM agent_group_members agm
      JOIN agent_configs ac ON ac.id = agm.agent_id
      WHERE agm.group_id = ?
      ORDER BY agm.turn_order
    `).all(groupId) as (AgentGroupMemberRow & AgentConfigRow)[]
  }

  removeGroupMember(groupId: string, agentId: string): void {
    getDb().prepare('DELETE FROM agent_group_members WHERE group_id = ? AND agent_id = ?').run(groupId, agentId)
  }

  deleteGroup(id: string): void {
    const db = getDb()
    db.prepare('UPDATE projects SET default_agent_group_id = NULL WHERE default_agent_group_id = ?').run(id)
    db.prepare('DELETE FROM agent_groups WHERE id = ?').run(id)
  }

  // Agent Categories
  createCategory(name: string): AgentCategoryRow {
    const db = getDb()
    const id = randomUUID()
    db.prepare('INSERT INTO agent_categories (id, name) VALUES (?, ?)').run(id, name)
    return this.getCategoryById(id)!
  }

  getCategoryById(id: string): AgentCategoryRow | undefined {
    return getDb().prepare('SELECT * FROM agent_categories WHERE id = ?').get(id) as AgentCategoryRow | undefined
  }

  listCategories(): AgentCategoryRow[] {
    return getDb().prepare('SELECT * FROM agent_categories ORDER BY created_at ASC').all() as AgentCategoryRow[]
  }

  updateCategory(id: string, name: string): void {
    getDb().prepare('UPDATE agent_categories SET name = ? WHERE id = ?').run(name, id)
  }

  deleteCategory(id: string): void {
    const db = getDb()
    db.prepare('UPDATE agent_configs SET category_id = NULL WHERE category_id = ?').run(id)
    db.prepare('DELETE FROM agent_categories WHERE id = ?').run(id)
  }
}

export const agentConfigRepo = new AgentConfigRepo()

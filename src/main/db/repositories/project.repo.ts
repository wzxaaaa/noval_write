import { getDb } from '../connection'
import { randomUUID } from 'crypto'

export interface ProjectRow {
  id: string
  name: string
  root_path: string
  created_at: string
  updated_at: string
  metadata: string
  default_agent_group_id: string | null
}

export interface ProjectSummary {
  id: string
  name: string
  root_path: string
  updated_at: string
  default_agent_group_id: string | null
}

export class ProjectRepo {
  create(name: string, rootPath: string, metadata: Record<string, unknown> = {}): ProjectRow {
    const db = getDb()
    const id = randomUUID()
    const defaultAgentGroupId = typeof metadata.default_agent_group_id === 'string' ? metadata.default_agent_group_id : null
    const cleanMetadata = { ...metadata }
    delete cleanMetadata.default_agent_group_id
    const stmt = db.prepare(
      'INSERT INTO projects (id, name, root_path, metadata, default_agent_group_id) VALUES (?, ?, ?, ?, ?)'
    )
    stmt.run(id, name, rootPath, JSON.stringify(cleanMetadata), defaultAgentGroupId)
    return this.getById(id)!
  }

  getById(id: string): ProjectRow | undefined {
    return getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
  }

  list(): ProjectSummary[] {
    return getDb()
      .prepare('SELECT id, name, root_path, updated_at, default_agent_group_id FROM projects ORDER BY updated_at DESC')
      .all() as ProjectSummary[]
  }

  update(id: string, updates: Partial<Pick<ProjectRow, 'name' | 'metadata' | 'default_agent_group_id'>>): void {
    const db = getDb()
    const fields: string[] = []
    const values: unknown[] = []

    if (updates.name !== undefined) {
      fields.push('name = ?')
      values.push(updates.name)
    }
    if (updates.metadata !== undefined) {
      fields.push('metadata = ?')
      values.push(typeof updates.metadata === 'string' ? updates.metadata : JSON.stringify(updates.metadata))
    }
    if (updates.default_agent_group_id !== undefined) {
      fields.push('default_agent_group_id = ?')
      values.push(updates.default_agent_group_id)
    }
    fields.push("updated_at = datetime('now')")
    values.push(id)

    db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }

  delete(id: string): void {
    getDb().prepare('DELETE FROM projects WHERE id = ?').run(id)
  }
}

export const projectRepo = new ProjectRepo()

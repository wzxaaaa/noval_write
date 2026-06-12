import { getDb } from '../connection'
import { randomUUID } from 'crypto'

export type OutlineType = 'outline' | 'detailed'

export interface ProjectOutlineRow {
  id: string
  project_id: string
  type: OutlineType
  title: string
  content: string
  updated_at: string
  created_at: string
}

export class OutlineRepo {
  create(projectId: string, type: OutlineType, title: string, content = ''): ProjectOutlineRow {
    const db = getDb()
    const id = randomUUID()
    db.prepare(
      'INSERT INTO project_outlines (id, project_id, type, title, content) VALUES (?, ?, ?, ?, ?)'
    ).run(id, projectId, type, title, content)
    return this.getById(id)!
  }

  getById(id: string): ProjectOutlineRow | undefined {
    return getDb().prepare('SELECT * FROM project_outlines WHERE id = ?').get(id) as ProjectOutlineRow | undefined
  }

  listByProject(projectId: string): ProjectOutlineRow[] {
    return getDb()
      .prepare('SELECT * FROM project_outlines WHERE project_id = ? ORDER BY type, created_at')
      .all(projectId) as ProjectOutlineRow[]
  }

  getByProjectAndType(projectId: string, type: OutlineType): ProjectOutlineRow[] {
    return getDb()
      .prepare('SELECT * FROM project_outlines WHERE project_id = ? AND type = ? ORDER BY created_at')
      .all(projectId, type) as ProjectOutlineRow[]
  }

  updateContent(id: string, content: string): void {
    getDb().prepare('UPDATE project_outlines SET content = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(content, id)
  }

  updateTitle(id: string, title: string): void {
    getDb().prepare('UPDATE project_outlines SET title = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(title, id)
  }

  update(id: string, updates: Partial<Pick<ProjectOutlineRow, 'title' | 'content'>>): void {
    const db = getDb()
    const fields: string[] = []
    const values: unknown[] = []

    if (updates.title !== undefined) {
      fields.push('title = ?')
      values.push(updates.title)
    }
    if (updates.content !== undefined) {
      fields.push('content = ?')
      values.push(updates.content)
    }
    fields.push("updated_at = datetime('now')")
    values.push(id)

    db.prepare(`UPDATE project_outlines SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }

  delete(id: string): void {
    getDb().prepare('DELETE FROM project_outlines WHERE id = ?').run(id)
  }
}

export const outlineRepo = new OutlineRepo()

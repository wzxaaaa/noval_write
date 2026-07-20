import { getDb } from '../connection'
import { randomUUID } from 'crypto'
import { isAbsolute, resolve } from 'path'
import { clampChapterWordTarget } from '../../../shared/chapterTarget'

export interface ProjectRow {
  id: string
  name: string
  root_path: string
  created_at: string
  updated_at: string
  metadata: string
}

export interface ProjectSummary {
  id: string
  name: string
  root_path: string
  updated_at: string
  target_chapter_words?: number | null
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function readChapterWordTarget(raw: string): number | null {
  return clampChapterWordTarget(parseMetadata(raw).target_chapter_words)
}

export class ProjectRepo {
  create(name: string, rootPath: string, metadata: Record<string, unknown> = {}): ProjectRow {
    const normalizedName = typeof name === 'string' ? name.trim() : ''
    if (!normalizedName) throw new Error('Project name is required')
    if (typeof rootPath !== 'string' || !rootPath.trim() || !isAbsolute(rootPath)) {
      throw new Error('Project root path must be absolute')
    }
    const normalizedRootPath = resolve(rootPath)
    const db = getDb()
    const id = randomUUID()
    const stmt = db.prepare(
      'INSERT INTO projects (id, name, root_path, metadata) VALUES (?, ?, ?, ?)'
    )
    stmt.run(id, normalizedName, normalizedRootPath, JSON.stringify(metadata))
    return this.getById(id)!
  }

  getById(id: string): ProjectRow | undefined {
    return getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
  }

  list(): ProjectSummary[] {
    const rows = getDb()
      .prepare('SELECT id, name, root_path, updated_at, metadata FROM projects ORDER BY updated_at DESC')
      .all() as Array<ProjectSummary & { metadata: string }>
    return rows.map(({ metadata, ...summary }) => ({
      ...summary,
      target_chapter_words: readChapterWordTarget(metadata)
    }))
  }

  /** 读取该项目的每章目标字数；未设置返回 null（表示使用全局默认值）。 */
  getChapterWordTarget(id: string): number | null {
    const row = this.getById(id)
    return row ? readChapterWordTarget(row.metadata) : null
  }

  /** 写入该项目的每章目标字数；传 null 清除设置。返回归一化后的实际值。 */
  setChapterWordTarget(id: string, value: number | null): number | null {
    const row = this.getById(id)
    if (!row) throw new Error('Project not found')
    const metadata = parseMetadata(row.metadata)
    const clamped = value === null ? null : clampChapterWordTarget(value)
    if (clamped === null) {
      delete metadata.target_chapter_words
    } else {
      metadata.target_chapter_words = clamped
    }
    getDb()
      .prepare("UPDATE projects SET metadata = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(metadata), id)
    return clamped
  }

  update(id: string, updates: Partial<Pick<ProjectRow, 'name' | 'metadata'>>): void {
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
    fields.push("updated_at = datetime('now')")
    values.push(id)

    db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }

  delete(id: string): void {
    getDb().prepare('DELETE FROM projects WHERE id = ?').run(id)
  }
}

export const projectRepo = new ProjectRepo()

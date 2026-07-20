import { randomUUID } from 'crypto'
import { getDb } from '../connection'
import { tokenizeSearchText } from '../../../shared/searchTerms'

export type NovelMemoryType =
  | 'story_bible'
  | 'style_guide'
  | 'character_card'
  | 'timeline_event'
  | 'foreshadowing'
  | 'chapter_summary'
  | 'semantic_note'
  | 'world_rule'
  | 'user_preference'

export interface NovelMemoryRow {
  id: string
  project_id: string
  memory_type: NovelMemoryType | string
  subject: string
  content: string
  metadata: string
  status: string
  source_chapter_id: string | null
  created_at: string
  updated_at: string
}

export interface NovelMemoryCreate {
  project_id: string
  memory_type: NovelMemoryType | string
  subject?: string
  content: string
  metadata?: Record<string, unknown>
  status?: string
  source_chapter_id?: string | null
}

export interface NovelMemoryUpdate {
  subject?: string
  content?: string
  metadata?: Record<string, unknown>
  status?: string
  source_chapter_id?: string | null
}

export class NovelMemoryRepo {
  create(params: NovelMemoryCreate): NovelMemoryRow {
    const db = getDb()
    const id = randomUUID()
    db.prepare(`
      INSERT INTO novel_memories
        (id, project_id, memory_type, subject, content, metadata, status, source_chapter_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.project_id,
      params.memory_type,
      params.subject?.trim() ?? '',
      params.content.trim(),
      JSON.stringify(params.metadata ?? {}),
      params.status ?? 'active',
      params.source_chapter_id ?? null
    )
    return this.getById(id)!
  }

  getById(id: string): NovelMemoryRow | undefined {
    return getDb().prepare('SELECT * FROM novel_memories WHERE id = ?').get(id) as NovelMemoryRow | undefined
  }

  listByProject(projectId: string, limit = 500): NovelMemoryRow[] {
    return getDb()
      .prepare('SELECT * FROM novel_memories WHERE project_id = ? ORDER BY datetime(updated_at) DESC, id DESC LIMIT ?')
      .all(projectId, limit) as NovelMemoryRow[]
  }

  listByType(projectId: string, memoryType: NovelMemoryType | string, limit = 100): NovelMemoryRow[] {
    return getDb()
      .prepare(`
        SELECT * FROM novel_memories
        WHERE project_id = ? AND memory_type = ?
        ORDER BY datetime(updated_at) DESC, id DESC
        LIMIT ?
      `)
      .all(projectId, memoryType, limit) as NovelMemoryRow[]
  }

  listByTypes(projectId: string, memoryTypes: Array<NovelMemoryType | string>, limit = 200): NovelMemoryRow[] {
    if (memoryTypes.length === 0) return []
    const placeholders = memoryTypes.map(() => '?').join(',')
    return getDb()
      .prepare(`
        SELECT * FROM novel_memories
        WHERE project_id = ? AND memory_type IN (${placeholders})
        ORDER BY datetime(updated_at) DESC, id DESC
        LIMIT ?
      `)
      .all(projectId, ...memoryTypes, limit) as NovelMemoryRow[]
  }

  findBySubject(
    projectId: string,
    memoryType: NovelMemoryType | string,
    subject: string
  ): NovelMemoryRow | undefined {
    return getDb()
      .prepare(`
        SELECT * FROM novel_memories
        WHERE project_id = ? AND memory_type = ? AND lower(subject) = lower(?)
        ORDER BY datetime(updated_at) DESC
        LIMIT 1
      `)
      .get(projectId, memoryType, subject.trim()) as NovelMemoryRow | undefined
  }

  update(id: string, updates: NovelMemoryUpdate): NovelMemoryRow | undefined {
    const db = getDb()
    const fields: string[] = []
    const values: unknown[] = []

    if (updates.subject !== undefined) { fields.push('subject = ?'); values.push(updates.subject.trim()) }
    if (updates.content !== undefined) { fields.push('content = ?'); values.push(updates.content.trim()) }
    if (updates.metadata !== undefined) { fields.push('metadata = ?'); values.push(JSON.stringify(updates.metadata)) }
    if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status) }
    if (updates.source_chapter_id !== undefined) { fields.push('source_chapter_id = ?'); values.push(updates.source_chapter_id) }

    if (fields.length === 0) return this.getById(id)

    fields.push("updated_at = datetime('now')")
    values.push(id)
    db.prepare(`UPDATE novel_memories SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    return this.getById(id)
  }

  upsertBySubject(params: NovelMemoryCreate): NovelMemoryRow {
    const subject = params.subject?.trim() ?? ''
    const existing = this.findBySubject(params.project_id, params.memory_type, subject)
    if (!existing) return this.create({ ...params, subject })

    return this.update(existing.id, {
      content: params.content,
      metadata: params.metadata,
      status: params.status ?? existing.status,
      source_chapter_id: params.source_chapter_id ?? existing.source_chapter_id
    })!
  }

  mergeBySubject(params: NovelMemoryCreate): NovelMemoryRow {
    const subject = params.subject?.trim() ?? ''
    const existing = this.findBySubject(params.project_id, params.memory_type, subject)
    if (!existing) return this.create({ ...params, subject })

    return this.update(existing.id, {
      content: mergeMemoryContent(existing.content, params.content),
      metadata: {
        ...parseMemoryMetadata(existing.metadata),
        ...(params.metadata ?? {})
      },
      status: params.status ?? existing.status,
      source_chapter_id: params.source_chapter_id ?? existing.source_chapter_id
    })!
  }

  search(projectId: string, query: string, limit = 20): NovelMemoryRow[] {
    const terms = Array.from(new Set(tokenizeSearchText(query).filter(term => term.length >= 2)))
      .slice(0, 12)

    if (terms.length === 0) return this.listByProject(projectId, limit)

    const rows = this.listByProject(projectId, 500)
    return rows
      .map(row => ({
        row,
        score: scoreMemory(row, terms)
      }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(item => item.row)
  }

  delete(id: string): void {
    getDb().prepare('DELETE FROM novel_memories WHERE id = ?').run(id)
  }
}

export function mergeMemoryContent(existingContent: string, incomingContent: string): string {
  const existing = existingContent.trim()
  const incoming = incomingContent.trim()
  if (!existing) return incoming
  if (!incoming) return existing

  const existingEntries = splitMemoryEntries(existing)
  const knownEntries = new Set(existingEntries.map(normalizeMemoryEntry))
  const newEntries = splitMemoryEntries(incoming).filter(entry => {
    const normalized = normalizeMemoryEntry(entry)
    if (!normalized || knownEntries.has(normalized)) return false
    knownEntries.add(normalized)
    return true
  })

  return newEntries.length > 0
    ? [existing, ...newEntries].join('\n\n')
    : existing
}

function splitMemoryEntries(content: string): string[] {
  return content
    .split(/\r?\n\s*\r?\n+/)
    .map(entry => entry.trim())
    .filter(Boolean)
}

function normalizeMemoryEntry(content: string): string {
  return content.toLowerCase().replace(/\s+/g, ' ').trim()
}

function parseMemoryMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function scoreMemory(row: NovelMemoryRow, terms: string[]): number {
  const haystack = `${row.memory_type}\n${row.subject}\n${row.content}`.toLowerCase()
  return terms.reduce((score, term) => {
    if (!haystack.includes(term)) return score
    const subjectBoost = row.subject.toLowerCase().includes(term) ? 3 : 0
    return score + 1 + subjectBoost
  }, 0)
}

export const novelMemoryRepo = new NovelMemoryRepo()

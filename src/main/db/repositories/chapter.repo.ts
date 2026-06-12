import { getDb } from '../connection'
import { randomUUID } from 'crypto'
import { countContentChars } from '../../../shared/textMetrics'
import { normalizeChapterContent, normalizeChapterTitle } from '../../../shared/chapterFormat'

export interface ChapterRow {
  id: string
  project_id: string
  parent_id: string | null
  title: string
  content: string
  sort_order: number
  word_count: number
  status: string
  created_at: string
  updated_at: string
}

export interface ChapterCreate {
  project_id: string
  parent_id?: string | null
  title: string
  content?: string
  sort_order?: number
}

export class ChapterRepo {
  create(params: ChapterCreate): ChapterRow {
    const db = getDb()
    const id = randomUUID()
    const title = normalizeChapterTitle(params.title)
    const content = normalizeChapterContent(params.content ?? '')
    const stmt = db.prepare(
      'INSERT INTO chapters (id, project_id, parent_id, title, content, sort_order, word_count) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    stmt.run(
      id,
      params.project_id,
      params.parent_id ?? null,
      title,
      content,
      params.sort_order ?? 0,
      countContentChars(content)
    )
    const chapter = this.getById(id)!
    this.addVersion(id, chapter.content, 'create')
    return chapter
  }

  getById(id: string): ChapterRow | undefined {
    const row = getDb().prepare('SELECT * FROM chapters WHERE id = ?').get(id) as ChapterRow | undefined
    return row ? normalizeChapterRow(row) : undefined
  }

  listByProject(projectId: string): ChapterRow[] {
    return getDb()
      .prepare('SELECT * FROM chapters WHERE project_id = ? ORDER BY sort_order, datetime(created_at), id')
      .all(projectId)
      .map(normalizeChapterRow) as ChapterRow[]
  }

  updateContent(id: string, content: string): ChapterRow | undefined {
    const current = this.getById(id)
    if (current) {
      this.addVersion(id, current.content, 'auto')
    }
    const normalizedContent = normalizeChapterContent(content)
    const wordCount = countContentChars(normalizedContent)
    getDb()
      .prepare("UPDATE chapters SET content = ?, word_count = ?, updated_at = datetime('now') WHERE id = ?")
      .run(normalizedContent, wordCount, id)
    return this.getById(id)
  }

  updateTitle(id: string, title: string): void {
    getDb()
      .prepare("UPDATE chapters SET title = ?, updated_at = datetime('now') WHERE id = ?")
      .run(normalizeChapterTitle(title), id)
  }

  updateSortOrder(id: string, order: number): void {
    getDb()
      .prepare('UPDATE chapters SET sort_order = ? WHERE id = ?')
      .run(order, id)
  }

  reorder(chapterIds: string[]): ChapterRow[] {
    if (chapterIds.length === 0) return []

    const db = getDb()
    const placeholders = chapterIds.map(() => '?').join(',')
    const rows = db
      .prepare(`SELECT id, project_id FROM chapters WHERE id IN (${placeholders})`)
      .all(...chapterIds) as Array<{ id: string; project_id: string }>

    if (rows.length !== chapterIds.length) {
      throw new Error('章节排序失败：部分章节不存在')
    }

    const projectIds = new Set(rows.map(row => row.project_id))
    if (projectIds.size !== 1) {
      throw new Error('章节排序失败：不能跨项目排序章节')
    }

    const update = db.prepare('UPDATE chapters SET sort_order = ? WHERE id = ?')
    const run = db.transaction((ids: string[]) => {
      ids.forEach((id, index) => update.run(index, id))
    })
    run(chapterIds)

    return this.listByProject(rows[0].project_id)
  }

  updateStatus(id: string, status: string): void {
    getDb()
      .prepare("UPDATE chapters SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, id)
  }

  delete(id: string): void {
    getDb().prepare('DELETE FROM chapters WHERE id = ?').run(id)
  }

  addVersion(chapterId: string, content: string, source: string): void {
    const db = getDb()
    const latest = db
      .prepare('SELECT MAX(version_no) as version FROM chapter_versions WHERE chapter_id = ?')
      .get(chapterId) as { version: number | null }
    db.prepare(
      'INSERT INTO chapter_versions (id, chapter_id, version_no, content, word_count, source) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(randomUUID(), chapterId, (latest.version ?? 0) + 1, content, countContentChars(content), source)
  }

  listVersions(chapterId: string): Array<{ id: string; chapter_id: string; version_no: number; content: string; word_count: number; source: string; created_at: string }> {
    return getDb()
      .prepare('SELECT * FROM chapter_versions WHERE chapter_id = ? ORDER BY version_no DESC')
      .all(chapterId) as Array<{ id: string; chapter_id: string; version_no: number; content: string; word_count: number; source: string; created_at: string }>
  }

  recalculateWordCounts(): void {
    const db = getDb()
    const chapters = db.prepare('SELECT id, content FROM chapters').all() as Array<{ id: string; content: string }>
    const update = db.prepare('UPDATE chapters SET word_count = ? WHERE id = ?')
    const run = db.transaction(() => {
      for (const chapter of chapters) {
        update.run(countContentChars(chapter.content), chapter.id)
      }
    })
    run()
  }
}

export const chapterRepo = new ChapterRepo()

function normalizeChapterRow(row: unknown): ChapterRow {
  const chapter = row as ChapterRow
  return {
    ...chapter,
    title: normalizeChapterTitle(chapter.title),
    content: normalizeChapterContent(chapter.content)
  }
}

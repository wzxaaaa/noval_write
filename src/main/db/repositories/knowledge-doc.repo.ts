import { getDb } from '../connection'
import { randomUUID } from 'crypto'

export interface KnowledgeDocRow {
  id: string
  project_id: string
  filename: string
  source_path: string
  file_type: string
  chunk_count: number
  char_count: number
  imported_at: string
  metadata: string
}

export class KnowledgeDocRepo {
  create(
    projectId: string,
    filename: string,
    sourcePath: string,
    fileType: string,
    charCount: number,
    metadata: Record<string, unknown> = {}
  ): KnowledgeDocRow {
    const db = getDb()
    const id = randomUUID()
    db.prepare(
      'INSERT INTO knowledge_docs (id, project_id, filename, source_path, file_type, char_count, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, projectId, filename, sourcePath, fileType, charCount, JSON.stringify(metadata))
    return this.getById(id)!
  }

  getById(id: string): KnowledgeDocRow | undefined {
    return getDb().prepare('SELECT * FROM knowledge_docs WHERE id = ?').get(id) as KnowledgeDocRow | undefined
  }

  listByProject(projectId: string): KnowledgeDocRow[] {
    return getDb()
      .prepare('SELECT * FROM knowledge_docs WHERE project_id = ? ORDER BY imported_at DESC')
      .all(projectId) as KnowledgeDocRow[]
  }

  updateChunkCount(id: string, chunkCount: number): void {
    getDb().prepare('UPDATE knowledge_docs SET chunk_count = ? WHERE id = ?').run(chunkCount, id)
  }

  replaceChunks(docId: string, chunks: string[]): void {
    const db = getDb()
    const replace = db.transaction(() => {
      db.prepare('DELETE FROM knowledge_doc_chunks WHERE doc_id = ?').run(docId)
      const stmt = db.prepare('INSERT INTO knowledge_doc_chunks (doc_id, chunk_index, content) VALUES (?, ?, ?)')
      chunks.forEach((chunk, index) => stmt.run(docId, index, chunk))
    })
    replace()
  }

  getChunks(docId: string): string[] {
    const rows = getDb()
      .prepare('SELECT content FROM knowledge_doc_chunks WHERE doc_id = ? ORDER BY chunk_index')
      .all(docId) as { content: string }[]
    return rows.map(row => row.content)
  }

  deleteChunks(docId: string): void {
    getDb().prepare('DELETE FROM knowledge_doc_chunks WHERE doc_id = ?').run(docId)
  }

  delete(id: string): void {
    getDb().prepare('DELETE FROM knowledge_docs WHERE id = ?').run(id)
  }
}

export const knowledgeDocRepo = new KnowledgeDocRepo()

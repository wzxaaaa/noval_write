import { getDb } from '../connection'
import { randomUUID } from 'crypto'

export interface ConversationRow {
  id: string
  project_id: string
  chapter_id: string | null
  title: string | null
  provider_config_id: string | null
  created_at: string
}

export interface MessageRow {
  id: string
  conversation_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  token_count: number | null
  agent_id: string | null
  metadata: string
  created_at: string
}

export class ConversationRepo {
  create(projectId: string, chapterId?: string, title?: string, providerConfigId?: string): ConversationRow {
    const db = getDb()
    const id = randomUUID()
    db.prepare(
      'INSERT INTO conversations (id, project_id, chapter_id, title, provider_config_id) VALUES (?, ?, ?, ?, ?)'
    ).run(id, projectId, chapterId ?? null, title ?? null, providerConfigId ?? null)
    return this.getById(id)!
  }

  getById(id: string): ConversationRow | undefined {
    return getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined
  }

  listByProject(projectId: string): ConversationRow[] {
    return getDb()
      .prepare('SELECT * FROM conversations WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as ConversationRow[]
  }

  addMessage(conversationId: string, role: 'user' | 'assistant' | 'system', content: string, agentId?: string, metadata: Record<string, unknown> = {}): MessageRow {
    const db = getDb()
    const id = randomUUID()
    const stmt = db.prepare(
      'INSERT INTO conversation_messages (id, conversation_id, role, content, agent_id, metadata) VALUES (?, ?, ?, ?, ?, ?)'
    )
    stmt.run(id, conversationId, role, content, agentId ?? null, JSON.stringify(metadata))
    return this.getMessageById(id)!
  }

  addUserMessageIfNeeded(conversationId: string, content: string): MessageRow {
    const latest = getDb().prepare(`
      SELECT * FROM conversation_messages
      WHERE conversation_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get(conversationId) as MessageRow | undefined

    if (latest?.role === 'user' && latest.content === content) {
      return latest
    }

    return this.addMessage(conversationId, 'user', content)
  }

  getMessages(conversationId: string): MessageRow[] {
    return getDb()
      .prepare('SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at, rowid')
      .all(conversationId) as MessageRow[]
  }

  getMessageById(id: string): MessageRow | undefined {
    return getDb().prepare('SELECT * FROM conversation_messages WHERE id = ?').get(id) as MessageRow | undefined
  }

  delete(id: string): void {
    getDb().prepare('DELETE FROM conversations WHERE id = ?').run(id)
  }
}

export const conversationRepo = new ConversationRepo()

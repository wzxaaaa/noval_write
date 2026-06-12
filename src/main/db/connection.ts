import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import schema from './schema.sql?raw'
import { countContentChars } from '../../shared/textMetrics'
import { normalizeChapterContent, normalizeChapterTitle } from '../../shared/chapterFormat'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.')
  }
  return db
}

export function initDatabase(): void {
  const dbPath = join(app.getPath('userData'), 'noval-write.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(schema)

  runMigrations(db)
}

function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  const applied = database.prepare('SELECT MAX(version) as v FROM _migrations').get() as { v: number | null }

  if ((applied.v ?? 0) < 1) {
    // Migration 1: collaboration_mode + is_moderator
    try { database.exec(`ALTER TABLE agent_groups ADD COLUMN collaboration_mode TEXT NOT NULL DEFAULT 'round_robin'`) } catch (_) {}
    try { database.exec(`ALTER TABLE agent_group_members ADD COLUMN is_moderator INTEGER NOT NULL DEFAULT 0`) } catch (_) {}
    database.exec(`INSERT INTO _migrations (version) VALUES (1)`)
  }

  if ((applied.v ?? 0) < 2) {
    try {
      database.exec(`ALTER TABLE provider_configs ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`)
      database.exec(`UPDATE provider_configs SET updated_at = COALESCE(created_at, datetime('now')) WHERE updated_at = ''`)
    } catch (_) {}
    database.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_doc_chunks (
        doc_id TEXT NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY (doc_id, chunk_index)
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc ON knowledge_doc_chunks(doc_id);
    `)
    database.exec(`INSERT INTO _migrations (version) VALUES (2)`)
  }

  if ((applied.v ?? 0) < 3) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS chapter_versions (
        id TEXT PRIMARY KEY,
        chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        version_no INTEGER NOT NULL,
        content TEXT NOT NULL,
        word_count INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'auto',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(chapter_id, version_no)
      );
      CREATE INDEX IF NOT EXISTS idx_chapter_versions_chapter ON chapter_versions(chapter_id);
    `)

    const chapters = database.prepare('SELECT id, content FROM chapters').all() as Array<{ id: string; content: string }>
    const update = database.prepare('UPDATE chapters SET word_count = ? WHERE id = ?')
    const recalc = database.transaction(() => {
      for (const chapter of chapters) {
        update.run(countContentChars(chapter.content), chapter.id)
      }
    })
    recalc()
    database.exec(`INSERT INTO _migrations (version) VALUES (3)`)
  }

  if ((applied.v ?? 0) < 4) {
    try { database.exec(`ALTER TABLE projects ADD COLUMN default_agent_group_id TEXT`) } catch (_) {}

    database.exec(`
      UPDATE projects
      SET default_agent_group_id = (
        SELECT id FROM agent_groups
        WHERE agent_groups.project_id = projects.id
        ORDER BY datetime(created_at) DESC
        LIMIT 1
      )
      WHERE default_agent_group_id IS NULL;
    `)

    database.exec(`PRAGMA foreign_keys = OFF;`)
    database.exec(`
      CREATE TABLE IF NOT EXISTS agent_groups_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        collaboration_mode TEXT NOT NULL DEFAULT 'round_robin',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO agent_groups_new (id, name, project_id, collaboration_mode, created_at)
        SELECT id, name, project_id, collaboration_mode, created_at FROM agent_groups;
      DROP TABLE agent_groups;
      ALTER TABLE agent_groups_new RENAME TO agent_groups;
      CREATE INDEX IF NOT EXISTS idx_agent_groups_project ON agent_groups(project_id);
    `)
    database.exec(`PRAGMA foreign_keys = ON;`)
    database.exec(`INSERT INTO _migrations (version) VALUES (4)`)
  }

  if ((applied.v ?? 0) < 5) {
    const chapters = database.prepare('SELECT id, title, content FROM chapters').all() as Array<{ id: string; title: string; content: string }>
    const update = database.prepare('UPDATE chapters SET title = ?, content = ?, word_count = ? WHERE id = ?')
    const normalize = database.transaction(() => {
      for (const chapter of chapters) {
        const title = normalizeChapterTitle(chapter.title)
        const content = normalizeChapterContent(chapter.content)
        update.run(title, content, countContentChars(content), chapter.id)
      }
    })
    normalize()
    database.exec(`INSERT INTO _migrations (version) VALUES (5)`)
  }

  if ((applied.v ?? 0) < 6) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS project_outlines (
          id          TEXT PRIMARY KEY,
          project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          type        TEXT NOT NULL DEFAULT 'outline',
          title       TEXT NOT NULL,
          content     TEXT NOT NULL DEFAULT '',
          updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_project_outlines_project ON project_outlines(project_id);
    `)
    database.exec(`INSERT INTO _migrations (version) VALUES (6)`)
  }

  if ((applied.v ?? 0) < 7) {
    // Migration 7: Add agent categories for organizing agents
    database.exec(`
      CREATE TABLE IF NOT EXISTS agent_categories (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)
    try {
      database.exec(`ALTER TABLE agent_configs ADD COLUMN category_id TEXT REFERENCES agent_categories(id) ON DELETE SET NULL`)
    } catch (_) {}
    database.exec(`CREATE INDEX IF NOT EXISTS idx_agent_configs_category ON agent_configs(category_id)`)
    database.exec(`INSERT INTO _migrations (version) VALUES (7)`)
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}

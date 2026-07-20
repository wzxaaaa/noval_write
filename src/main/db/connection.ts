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

export function initDatabase(databasePath?: string): void {
  const dbPath = databasePath ?? join(app.getPath('userData'), 'noval-write.db')
  if (db) {
    db.close()
  }
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
    try { database.exec(`ALTER TABLE agent_groups ADD COLUMN collaboration_mode TEXT NOT NULL DEFAULT 'chapter_pipeline'`) } catch (_) {}
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
        collaboration_mode TEXT NOT NULL DEFAULT 'chapter_pipeline',
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

  if ((applied.v ?? 0) < 8) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS novel_memories (
        id                TEXT PRIMARY KEY,
        project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        memory_type       TEXT NOT NULL,
        subject           TEXT NOT NULL DEFAULT '',
        content           TEXT NOT NULL DEFAULT '',
        metadata          TEXT NOT NULL DEFAULT '{}',
        status            TEXT NOT NULL DEFAULT 'active',
        source_chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_novel_memories_project_type ON novel_memories(project_id, memory_type);
      CREATE INDEX IF NOT EXISTS idx_novel_memories_subject ON novel_memories(project_id, subject);
      CREATE INDEX IF NOT EXISTS idx_novel_memories_chapter ON novel_memories(source_chapter_id);
    `)
    database.exec(`INSERT INTO _migrations (version) VALUES (8)`)
  }

  if ((applied.v ?? 0) < 9) {
    try { database.exec(`ALTER TABLE agent_configs ADD COLUMN provider_config_id TEXT REFERENCES provider_configs(id)`) } catch (_) {}
    try { database.exec(`ALTER TABLE agent_configs ADD COLUMN pipeline_role TEXT`) } catch (_) {}
    try { database.exec(`ALTER TABLE agent_configs ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0`) } catch (_) {}
    database.exec(`
      UPDATE agent_configs
      SET provider_config_id = model
      WHERE (provider_config_id IS NULL OR provider_config_id = '')
        AND model IN (SELECT id FROM provider_configs);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_configs_pipeline_role ON agent_configs(pipeline_role);
    `)
    database.exec(`INSERT INTO _migrations (version) VALUES (9)`)
  }

  if ((applied.v ?? 0) < 10) {
    const migrateProviderReferences = database.transaction(() => {
      database.exec(`
        UPDATE agent_configs
        SET model = ''
        WHERE model <> ''
          AND model NOT IN (SELECT id FROM provider_configs);

        UPDATE agent_configs
        SET provider_config_id = NULL
        WHERE provider_config_id = ''
           OR provider_config_id NOT IN (SELECT id FROM provider_configs);

        UPDATE conversations
        SET provider_config_id = NULL
        WHERE provider_config_id = ''
           OR provider_config_id NOT IN (SELECT id FROM provider_configs);
      `)

      const defaults = database
        .prepare(`
          SELECT id
          FROM provider_configs
          WHERE is_default = 1
          ORDER BY datetime(created_at) ASC, id ASC
        `)
        .all() as Array<{ id: string }>
      if (defaults.length > 1) {
        const keepId = defaults[0].id
        database.prepare('UPDATE provider_configs SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END').run(keepId)
      }

      database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_configs_single_default
        ON provider_configs(is_default)
        WHERE is_default = 1;
      `)
      database.exec(`INSERT INTO _migrations (version) VALUES (10)`)
    })
    migrateProviderReferences()
  }

  if ((applied.v ?? 0) < 11) {
    type SchemaObject = { type: 'index' | 'trigger'; name: string; sql: string }
    type ForeignKeyViolation = {
      table: string
      rowid: number | null
      parent: string
      fkid: number
    }

    const foreignKeysWereEnabled = database.pragma('foreign_keys', { simple: true }) === 1
    database.pragma('foreign_keys = OFF')

    try {
      const rebuildNullableForeignKeys = database.transaction(() => {
        const schemaObjects = database.prepare(`
          SELECT type, name, sql
          FROM sqlite_master
          WHERE tbl_name IN ('chapters', 'conversations', 'agent_configs')
            AND type IN ('index', 'trigger')
            AND sql IS NOT NULL
          ORDER BY CASE type WHEN 'index' THEN 0 ELSE 1 END, name
        `).all() as SchemaObject[]

        database.exec(`
          UPDATE chapters
          SET parent_id = NULL
          WHERE parent_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM chapters AS parent WHERE parent.id = chapters.parent_id
            );

          UPDATE conversations
          SET chapter_id = NULL
          WHERE chapter_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM chapters WHERE chapters.id = conversations.chapter_id
            );

          UPDATE conversations
          SET provider_config_id = NULL
          WHERE provider_config_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM provider_configs
              WHERE provider_configs.id = conversations.provider_config_id
            );

          UPDATE agent_configs
          SET provider_config_id = NULL
          WHERE provider_config_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM provider_configs
              WHERE provider_configs.id = agent_configs.provider_config_id
            );

          UPDATE agent_configs
          SET category_id = NULL
          WHERE category_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM agent_categories
              WHERE agent_categories.id = agent_configs.category_id
            );

          CREATE TABLE __noval_write_chapters_v11 (
            id          TEXT PRIMARY KEY,
            project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            parent_id   TEXT REFERENCES __noval_write_chapters_v11(id) ON DELETE SET NULL,
            title       TEXT NOT NULL,
            content     TEXT NOT NULL DEFAULT '',
            sort_order  INTEGER NOT NULL DEFAULT 0,
            word_count  INTEGER NOT NULL DEFAULT 0,
            status      TEXT NOT NULL DEFAULT 'draft',
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO __noval_write_chapters_v11 (
            id, project_id, parent_id, title, content, sort_order, word_count,
            status, created_at, updated_at
          )
          SELECT
            id, project_id, parent_id, title, content, sort_order, word_count,
            status, created_at, updated_at
          FROM chapters;
          DROP TABLE chapters;
          ALTER TABLE __noval_write_chapters_v11 RENAME TO chapters;

          CREATE TABLE __noval_write_conversations_v11 (
            id          TEXT PRIMARY KEY,
            project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            chapter_id  TEXT REFERENCES chapters(id) ON DELETE SET NULL,
            title       TEXT,
            provider_config_id TEXT REFERENCES provider_configs(id) ON DELETE SET NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO __noval_write_conversations_v11 (
            id, project_id, chapter_id, title, provider_config_id, created_at
          )
          SELECT id, project_id, chapter_id, title, provider_config_id, created_at
          FROM conversations;
          DROP TABLE conversations;
          ALTER TABLE __noval_write_conversations_v11 RENAME TO conversations;

          CREATE TABLE __noval_write_agent_configs_v11 (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            description TEXT,
            role        TEXT NOT NULL,
            system_prompt TEXT NOT NULL,
            model       TEXT NOT NULL,
            provider_config_id TEXT REFERENCES provider_configs(id) ON DELETE SET NULL,
            pipeline_role TEXT UNIQUE,
            is_system   INTEGER NOT NULL DEFAULT 0,
            tools       TEXT NOT NULL DEFAULT '[]',
            parameters  TEXT NOT NULL DEFAULT '{}',
            category_id TEXT REFERENCES agent_categories(id) ON DELETE SET NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO __noval_write_agent_configs_v11 (
            id, name, description, role, system_prompt, model, provider_config_id,
            pipeline_role, is_system, tools, parameters, category_id, created_at
          )
          SELECT
            id, name, description, role, system_prompt, model, provider_config_id,
            pipeline_role, is_system, tools, parameters, category_id, created_at
          FROM agent_configs;
          DROP TABLE agent_configs;
          ALTER TABLE __noval_write_agent_configs_v11 RENAME TO agent_configs;
        `)

        for (const schemaObject of schemaObjects) {
          database.exec(schemaObject.sql)
        }

        database.exec(`
          CREATE INDEX IF NOT EXISTS idx_chapters_project ON chapters(project_id);
          CREATE INDEX IF NOT EXISTS idx_chapters_parent ON chapters(parent_id);
          CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id);
          CREATE INDEX IF NOT EXISTS idx_agent_configs_category ON agent_configs(category_id);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_configs_pipeline_role
            ON agent_configs(pipeline_role);
        `)

        const violations = [
          ...(database.pragma('foreign_key_check(chapters)') as ForeignKeyViolation[]),
          ...(database.pragma('foreign_key_check(conversations)') as ForeignKeyViolation[]),
          ...(database.pragma('foreign_key_check(agent_configs)') as ForeignKeyViolation[])
        ]
        if (violations.length > 0) {
          throw new Error(`Migration 11 foreign key check failed: ${JSON.stringify(violations)}`)
        }

        database.exec(`INSERT INTO _migrations (version) VALUES (11)`)
      })

      rebuildNullableForeignKeys()
    } finally {
      database.pragma(`foreign_keys = ${foreignKeysWereEnabled ? 'ON' : 'OFF'}`)
    }
  }

  if ((applied.v ?? 0) < 12) {
    // Migration 12: user-imported writing skills
    database.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        version       TEXT NOT NULL DEFAULT '',
        install_path  TEXT NOT NULL,
        entry_file    TEXT NOT NULL DEFAULT 'SKILL.md',
        source_kind   TEXT NOT NULL DEFAULT 'folder',
        source_label  TEXT NOT NULL DEFAULT '',
        content_chars INTEGER NOT NULL DEFAULT 0,
        installed_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)
    database.exec(`INSERT INTO _migrations (version) VALUES (12)`)
  }

  if ((applied.v ?? 0) < 13) {
    // Migration 13: 技能子文档清单，供 Agent 按需读取 references
    try {
      database.exec(`ALTER TABLE skills ADD COLUMN doc_paths TEXT NOT NULL DEFAULT '[]'`)
    } catch (_) {}
    database.exec(`INSERT INTO _migrations (version) VALUES (13)`)
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { rmSync } from 'fs'
import { spawnSync } from 'child_process'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { join } from 'path'
import { agentConfigRepo } from '../../src/main/db/repositories/agent-config.repo'
import { chapterRepo } from '../../src/main/db/repositories/chapter.repo'
import { conversationRepo } from '../../src/main/db/repositories/conversation.repo'
import { providerConfigRepo } from '../../src/main/db/repositories/provider-config.repo'
import { closeDatabase, getDb, initDatabase } from '../../src/main/db/connection'
import { WRITING_AGENT_DEFINITIONS } from '../../src/shared/writingAgents'

const PROJECT_ID = 'project-lifecycle'
const temporaryDatabases: string[] = []
const isElectronNode = typeof process.versions.electron === 'string'

type ForeignKeyRow = {
  table: string
  from: string
  on_delete: string
}

function foreignKeyDeleteAction(database: Database.Database, table: string, column: string): string | undefined {
  const foreignKeys = database.pragma(`foreign_key_list(${table})`) as ForeignKeyRow[]
  return foreignKeys.find(foreignKey => foreignKey.from === column)?.on_delete
}

describe.runIf(!isElectronNode)('database lifecycle Electron bridge', () => {
  it('runs the SQLite integration suite with the Electron ABI', () => {
    const require = createRequire(import.meta.url)
    const electronPath = require('electron') as string
    const vitestPath = join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs')
    const result = spawnSync(electronPath, [vitestPath, '--run', 'tests/main/db-lifecycle.test.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1'
      },
      encoding: 'utf8',
      timeout: 60_000
    })
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()

    expect(result.error, output).toBeUndefined()
    expect(result.status, output).toBe(0)
    expect(output).toContain('8 passed')
  })
})

describe.runIf(isElectronNode)('database reference lifecycles', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    getDb().prepare('INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)')
      .run(PROJECT_ID, 'Lifecycle', '/tmp/lifecycle')
  })

  afterEach(() => {
    closeDatabase()
    for (const databasePath of temporaryDatabases.splice(0)) {
      rmSync(databasePath, { force: true })
    }
  })

  it('persists an unanswered user turn idempotently across retries', () => {
    const conversation = conversationRepo.create(PROJECT_ID, undefined, 'Retry chat')

    const first = conversationRepo.addUserMessageIfNeeded(conversation.id, 'retry me')
    const retry = conversationRepo.addUserMessageIfNeeded(conversation.id, 'retry me')

    expect(retry.id).toBe(first.id)
    expect(conversationRepo.getMessages(conversation.id)).toHaveLength(1)

    conversationRepo.addMessage(conversation.id, 'assistant', 'done')
    const nextTurn = conversationRepo.addUserMessageIfNeeded(conversation.id, 'retry me')

    expect(nextTurn.id).not.toBe(first.id)
    expect(conversationRepo.getMessages(conversation.id).map(message => message.role))
      .toEqual(['user', 'assistant', 'user'])
  })

  it('creates the fixed writing team without invalid provider foreign keys on a fresh database', () => {
    const team = agentConfigRepo.ensureWritingTeam()

    expect(team).toHaveLength(9)
    expect(team.every(agent => agent.provider_config_id === null)).toBe(true)
    expect(team.every(agent => agent.model === '')).toBe(true)
    for (const definition of WRITING_AGENT_DEFINITIONS) {
      const agent = team.find(item => item.pipeline_role === definition.role)
      expect(agent?.system_prompt).toBe(definition.systemPrompt)
      expect(JSON.parse(agent?.parameters ?? '{}')).toMatchObject({
        ...definition.defaultParameters,
        pipeline_role: definition.role
      })
    }
    expect(getDb().pragma('foreign_key_check')).toEqual([])
  })

  it('makes the first provider default and immediately binds the fixed writing team', () => {
    const team = agentConfigRepo.ensureWritingTeam()
    expect(team.every(agent => agent.provider_config_id === null)).toBe(true)

    const provider = providerConfigRepo.create({
      name: 'Only model',
      provider: 'openai-compat',
      api_key: 'test-key',
      base_url: 'https://example.invalid/v1',
      model: 'only-model'
    })

    expect(provider.is_default).toBe(1)
    expect(agentConfigRepo.getWritingTeam().every(agent =>
      agent.provider_config_id === provider.id && agent.model === provider.id
    )).toBe(true)
    expect(getDb().pragma('foreign_key_check')).toEqual([])
  })

  it('atomically detaches provider references and promotes a fallback when deleting a provider', () => {
    const primary = providerConfigRepo.create({
      name: 'Primary',
      provider: 'openai',
      api_key: 'key-1',
      model: 'gpt-primary',
      is_default: true
    })
    const fallback = providerConfigRepo.create({
      name: 'Fallback',
      provider: 'openai',
      api_key: 'key-2',
      model: 'gpt-fallback'
    })
    const team = agentConfigRepo.ensureWritingTeam()
    const conversation = conversationRepo.create(PROJECT_ID, undefined, 'Chat', primary.id)

    expect(team.every(agent => agent.provider_config_id === primary.id)).toBe(true)

    providerConfigRepo.delete(primary.id)

    expect(providerConfigRepo.getById(primary.id)).toBeUndefined()
    expect(providerConfigRepo.getDefault()?.id).toBe(fallback.id)
    expect(conversationRepo.getById(conversation.id)?.provider_config_id).toBeNull()
    expect(agentConfigRepo.getWritingTeam().every(agent =>
      agent.provider_config_id === fallback.id && agent.model === fallback.id
    )).toBe(true)
    expect(getDb().pragma('foreign_key_check')).toEqual([])
  })

  it('detaches child chapters and conversations before deleting a referenced chapter', () => {
    const parent = chapterRepo.create({
      project_id: PROJECT_ID,
      title: 'Parent',
      content: '父章节正文。',
      sort_order: 0
    })
    const child = chapterRepo.create({
      project_id: PROJECT_ID,
      parent_id: parent.id,
      title: 'Child',
      content: '子章节正文。',
      sort_order: 1
    })
    const conversation = conversationRepo.create(PROJECT_ID, parent.id, 'Chapter chat')

    chapterRepo.delete(parent.id)

    expect(chapterRepo.getById(parent.id)).toBeUndefined()
    expect(chapterRepo.getById(child.id)?.parent_id).toBeNull()
    expect(conversationRepo.getById(conversation.id)?.chapter_id).toBeNull()
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM chapter_versions WHERE chapter_id = ?')
      .get(parent.id)).toEqual({ count: 0 })
    expect(getDb().pragma('foreign_key_check')).toEqual([])
  })

  it('keeps exactly one default provider across create and update operations', () => {
    const first = providerConfigRepo.create({
      name: 'First',
      provider: 'openai',
      api_key: 'key-1',
      model: 'first',
      is_default: true
    })
    const second = providerConfigRepo.create({
      name: 'Second',
      provider: 'anthropic',
      api_key: 'key-2',
      model: 'second',
      is_default: true
    })

    expect(providerConfigRepo.getById(first.id)?.is_default).toBe(0)
    expect(providerConfigRepo.getById(second.id)?.is_default).toBe(1)

    providerConfigRepo.update(first.id, { is_default: true })

    expect(providerConfigRepo.getById(first.id)?.is_default).toBe(1)
    expect(providerConfigRepo.getById(second.id)?.is_default).toBe(0)
    const defaults = getDb().prepare('SELECT id FROM provider_configs WHERE is_default = 1').all()
    expect(defaults).toEqual([{ id: first.id }])
  })

  it('repairs legacy duplicate defaults and dangling provider references before adding the unique index', () => {
    closeDatabase()
    const databasePath = join(tmpdir(), `noval-write-lifecycle-${Date.now()}-${Math.random()}.db`)
    temporaryDatabases.push(databasePath)
    initDatabase(databasePath)
    getDb().prepare('INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)')
      .run(PROJECT_ID, 'Lifecycle', '/tmp/lifecycle')

    const first = providerConfigRepo.create({
      name: 'First legacy default',
      provider: 'openai',
      api_key: 'key-1',
      model: 'first',
      is_default: true
    })
    const second = providerConfigRepo.create({
      name: 'Second legacy default',
      provider: 'openai',
      api_key: 'key-2',
      model: 'second'
    })
    const agent = agentConfigRepo.ensureWritingTeam()[0]
    const conversation = conversationRepo.create(PROJECT_ID, undefined, 'Legacy', first.id)
    closeDatabase()

    const legacy = new Database(databasePath)
    legacy.pragma('foreign_keys = OFF')
    legacy.exec(`
      DROP INDEX IF EXISTS idx_provider_configs_single_default;
      DELETE FROM _migrations WHERE version >= 10;
      UPDATE provider_configs SET is_default = 1 WHERE id IN ('${first.id}', '${second.id}');
      UPDATE agent_configs SET provider_config_id = '' WHERE id = '${agent.id}';
      UPDATE conversations SET provider_config_id = 'missing-provider' WHERE id = '${conversation.id}';
    `)
    legacy.close()

    initDatabase(databasePath)

    expect(getDb().prepare('SELECT id FROM provider_configs WHERE is_default = 1').all()).toHaveLength(1)
    expect(agentConfigRepo.getById(agent.id)?.provider_config_id).toBeNull()
    expect(conversationRepo.getById(conversation.id)?.provider_config_id).toBeNull()
    expect(getDb().prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_provider_configs_single_default'
    `).get()).toEqual({ name: 'idx_provider_configs_single_default' })
    expect(getDb().pragma('foreign_key_check')).toEqual([])
  })

  it('rebuilds legacy nullable foreign keys with SET NULL while preserving data and indexes', () => {
    closeDatabase()
    const databasePath = join(tmpdir(), `noval-write-legacy-fk-${Date.now()}-${Math.random()}.db`)
    temporaryDatabases.push(databasePath)

    const legacy = new Database(databasePath)
    legacy.pragma('foreign_keys = OFF')
    legacy.exec(`
      CREATE TABLE _migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO _migrations (version) VALUES (10);

      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        default_agent_group_id TEXT REFERENCES agent_groups(id) ON DELETE SET NULL,
        metadata TEXT DEFAULT '{}'
      );

      CREATE TABLE provider_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        api_key TEXT NOT NULL DEFAULT '',
        base_url TEXT,
        model TEXT NOT NULL,
        parameters TEXT NOT NULL DEFAULT '{}',
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE agent_categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE chapters (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES chapters(id),
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        word_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        chapter_id TEXT REFERENCES chapters(id),
        title TEXT,
        provider_config_id TEXT REFERENCES provider_configs(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE agent_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        role TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        model TEXT NOT NULL,
        tools TEXT NOT NULL DEFAULT '[]',
        parameters TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        category_id TEXT REFERENCES agent_categories(id) ON DELETE SET NULL,
        provider_config_id TEXT REFERENCES provider_configs(id),
        pipeline_role TEXT,
        is_system INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE chapter_versions (
        id TEXT PRIMARY KEY,
        chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        version_no INTEGER NOT NULL,
        content TEXT NOT NULL,
        word_count INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'auto',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(chapter_id, version_no)
      );

      CREATE TABLE conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        token_count INTEGER,
        agent_id TEXT,
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE agent_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        collaboration_mode TEXT NOT NULL DEFAULT 'chapter_pipeline',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE agent_group_members (
        group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agent_configs(id) ON DELETE CASCADE,
        turn_order INTEGER NOT NULL,
        can_initiate INTEGER NOT NULL DEFAULT 1,
        is_moderator INTEGER NOT NULL DEFAULT 0,
        routing_rules TEXT DEFAULT '{}',
        PRIMARY KEY (group_id, agent_id)
      );

      CREATE TABLE novel_memories (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        memory_type TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        metadata TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active',
        source_chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_chapters_project ON chapters(project_id);
      CREATE INDEX idx_chapters_parent ON chapters(parent_id);
      CREATE INDEX legacy_chapters_status_sort ON chapters(status, sort_order);
      CREATE INDEX idx_conversations_project ON conversations(project_id);
      CREATE INDEX idx_agent_configs_category ON agent_configs(category_id);
      CREATE UNIQUE INDEX idx_agent_configs_pipeline_role ON agent_configs(pipeline_role);
    `)

    legacy.prepare('INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)')
      .run(PROJECT_ID, 'Legacy lifecycle', '/tmp/legacy-lifecycle')
    legacy.prepare(`
      INSERT INTO provider_configs (id, name, provider, api_key, model)
      VALUES (?, ?, ?, ?, ?)
    `).run('legacy-provider', 'Legacy provider', 'openai', 'legacy-key', 'legacy-model')
    legacy.prepare('INSERT INTO agent_categories (id, name) VALUES (?, ?)')
      .run('legacy-category', 'Legacy category')
    legacy.prepare(`
      INSERT INTO chapters (id, project_id, parent_id, title, content, sort_order, word_count, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('legacy-parent', PROJECT_ID, null, 'Legacy parent', 'parent-content', 0, 14, 'draft')
    legacy.prepare(`
      INSERT INTO chapters (id, project_id, parent_id, title, content, sort_order, word_count, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('legacy-child', PROJECT_ID, 'legacy-parent', 'Legacy child', 'child-content', 1, 13, 'revised')
    legacy.prepare(`
      INSERT INTO chapters (id, project_id, parent_id, title, content, sort_order, word_count, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('legacy-dangling', PROJECT_ID, 'missing-chapter', 'Legacy dangling', 'dangling', 2, 8, 'draft')
    legacy.prepare(`
      INSERT INTO conversations (id, project_id, chapter_id, title, provider_config_id)
      VALUES (?, ?, ?, ?, ?)
    `).run('legacy-conversation', PROJECT_ID, 'legacy-parent', 'Legacy valid', 'legacy-provider')
    legacy.prepare(`
      INSERT INTO conversations (id, project_id, chapter_id, title, provider_config_id)
      VALUES (?, ?, ?, ?, ?)
    `).run('legacy-dangling-conversation', PROJECT_ID, 'missing-chapter', 'Legacy dangling', 'missing-provider')
    legacy.prepare(`
      INSERT INTO agent_configs (
        id, name, role, system_prompt, model, provider_config_id,
        pipeline_role, is_system, category_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-agent', 'Legacy agent', 'writer', 'Legacy prompt', 'legacy-provider',
      'legacy-provider', 'legacy_writer', 1, 'legacy-category'
    )
    legacy.prepare(`
      INSERT INTO agent_configs (
        id, name, role, system_prompt, model, provider_config_id,
        pipeline_role, is_system, category_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-dangling-agent', 'Legacy dangling agent', 'reviewer', 'Legacy prompt', '',
      'missing-provider', 'legacy_reviewer', 0, 'missing-category'
    )
    legacy.prepare(`
      INSERT INTO chapter_versions (id, chapter_id, version_no, content, word_count, source)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('legacy-version', 'legacy-parent', 1, 'version-content', 15, 'manual')
    legacy.prepare(`
      INSERT INTO conversation_messages (id, conversation_id, role, content, token_count)
      VALUES (?, ?, ?, ?, ?)
    `).run('legacy-message', 'legacy-conversation', 'assistant', 'legacy-message-content', 7)
    legacy.prepare(`
      INSERT INTO agent_groups (id, name, project_id, collaboration_mode)
      VALUES (?, ?, ?, ?)
    `).run('legacy-group', 'Legacy group', PROJECT_ID, 'chapter_pipeline')
    legacy.prepare(`
      INSERT INTO agent_group_members (group_id, agent_id, turn_order, can_initiate, is_moderator)
      VALUES (?, ?, ?, ?, ?)
    `).run('legacy-group', 'legacy-agent', 0, 1, 1)
    legacy.prepare(`
      INSERT INTO novel_memories (
        id, project_id, memory_type, subject, content, source_chapter_id
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('legacy-memory', PROJECT_ID, 'plot', 'Legacy subject', 'Legacy memory', 'legacy-parent')
    legacy.prepare('UPDATE projects SET default_agent_group_id = ? WHERE id = ?')
      .run('legacy-group', PROJECT_ID)

    expect(foreignKeyDeleteAction(legacy, 'chapters', 'parent_id')).toBe('NO ACTION')
    expect(foreignKeyDeleteAction(legacy, 'conversations', 'chapter_id')).toBe('NO ACTION')
    expect(foreignKeyDeleteAction(legacy, 'conversations', 'provider_config_id')).toBe('NO ACTION')
    expect(foreignKeyDeleteAction(legacy, 'agent_configs', 'provider_config_id')).toBe('NO ACTION')
    expect(foreignKeyDeleteAction(legacy, 'agent_configs', 'category_id')).toBe('SET NULL')
    legacy.close()

    initDatabase(databasePath)

    expect(getDb().prepare('SELECT version FROM _migrations WHERE version = 11').get())
      .toEqual({ version: 11 })
    expect(foreignKeyDeleteAction(getDb(), 'chapters', 'parent_id')).toBe('SET NULL')
    expect(foreignKeyDeleteAction(getDb(), 'conversations', 'chapter_id')).toBe('SET NULL')
    expect(foreignKeyDeleteAction(getDb(), 'conversations', 'provider_config_id')).toBe('SET NULL')
    expect(foreignKeyDeleteAction(getDb(), 'agent_configs', 'provider_config_id')).toBe('SET NULL')
    expect(foreignKeyDeleteAction(getDb(), 'agent_configs', 'category_id')).toBe('SET NULL')

    expect(getDb().prepare(`
      SELECT id, parent_id, title, content, sort_order, word_count, status
      FROM chapters ORDER BY sort_order
    `).all()).toEqual([
      {
        id: 'legacy-parent', parent_id: null, title: 'Legacy parent', content: 'parent-content',
        sort_order: 0, word_count: 14, status: 'draft'
      },
      {
        id: 'legacy-child', parent_id: 'legacy-parent', title: 'Legacy child', content: 'child-content',
        sort_order: 1, word_count: 13, status: 'revised'
      },
      {
        id: 'legacy-dangling', parent_id: null, title: 'Legacy dangling', content: 'dangling',
        sort_order: 2, word_count: 8, status: 'draft'
      }
    ])
    expect(getDb().prepare(`
      SELECT chapter_id, provider_config_id FROM conversations WHERE id = ?
    `).get('legacy-dangling-conversation')).toEqual({ chapter_id: null, provider_config_id: null })
    expect(getDb().prepare(`
      SELECT provider_config_id, category_id FROM agent_configs WHERE id = ?
    `).get('legacy-dangling-agent')).toEqual({ provider_config_id: null, category_id: null })
    expect(getDb().prepare(`
      SELECT content, word_count, source FROM chapter_versions WHERE id = ?
    `).get('legacy-version')).toEqual({ content: 'version-content', word_count: 15, source: 'manual' })
    expect(getDb().prepare(`
      SELECT content, token_count FROM conversation_messages WHERE id = ?
    `).get('legacy-message')).toEqual({ content: 'legacy-message-content', token_count: 7 })
    expect(getDb().prepare(`
      SELECT turn_order, can_initiate, is_moderator
      FROM agent_group_members WHERE group_id = ? AND agent_id = ?
    `).get('legacy-group', 'legacy-agent')).toEqual({ turn_order: 0, can_initiate: 1, is_moderator: 1 })

    const preservedIndexes = getDb().prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index'
        AND name IN (
          'idx_chapters_project', 'idx_chapters_parent', 'legacy_chapters_status_sort',
          'idx_conversations_project', 'idx_agent_configs_category',
          'idx_agent_configs_pipeline_role'
        )
      ORDER BY name
    `).all()
    expect(preservedIndexes).toEqual([
      { name: 'idx_agent_configs_category' },
      { name: 'idx_agent_configs_pipeline_role' },
      { name: 'idx_chapters_parent' },
      { name: 'idx_chapters_project' },
      { name: 'idx_conversations_project' },
      { name: 'legacy_chapters_status_sort' }
    ])

    getDb().prepare('DELETE FROM chapters WHERE id = ?').run('legacy-parent')
    expect(getDb().prepare('SELECT parent_id FROM chapters WHERE id = ?').get('legacy-child'))
      .toEqual({ parent_id: null })
    expect(getDb().prepare('SELECT chapter_id FROM conversations WHERE id = ?').get('legacy-conversation'))
      .toEqual({ chapter_id: null })
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM chapter_versions WHERE id = ?')
      .get('legacy-version')).toEqual({ count: 0 })
    expect(getDb().prepare('SELECT source_chapter_id FROM novel_memories WHERE id = ?')
      .get('legacy-memory')).toEqual({ source_chapter_id: null })

    getDb().prepare('DELETE FROM provider_configs WHERE id = ?').run('legacy-provider')
    expect(getDb().prepare(`
      SELECT provider_config_id FROM conversations WHERE id = ?
    `).get('legacy-conversation')).toEqual({ provider_config_id: null })
    expect(getDb().prepare(`
      SELECT provider_config_id FROM agent_configs WHERE id = ?
    `).get('legacy-agent')).toEqual({ provider_config_id: null })

    getDb().prepare('DELETE FROM agent_categories WHERE id = ?').run('legacy-category')
    expect(getDb().prepare('SELECT category_id FROM agent_configs WHERE id = ?').get('legacy-agent'))
      .toEqual({ category_id: null })

    getDb().prepare('DELETE FROM conversations WHERE id = ?').run('legacy-conversation')
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM conversation_messages WHERE id = ?')
      .get('legacy-message')).toEqual({ count: 0 })
    getDb().prepare('DELETE FROM agent_configs WHERE id = ?').run('legacy-agent')
    expect(getDb().prepare(`
      SELECT COUNT(*) AS count FROM agent_group_members WHERE group_id = ?
    `).get('legacy-group')).toEqual({ count: 0 })
    expect(getDb().pragma('foreign_key_check')).toEqual([])
  })
})

-- Projects
CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    root_path   TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    default_agent_group_id TEXT REFERENCES agent_groups(id) ON DELETE SET NULL,
    metadata    TEXT DEFAULT '{}'
);

-- Chapters
CREATE TABLE IF NOT EXISTS chapters (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id   TEXT REFERENCES chapters(id) ON DELETE SET NULL,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    word_count  INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'draft',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chapter_versions (
    id          TEXT PRIMARY KEY,
    chapter_id  TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    version_no  INTEGER NOT NULL,
    content     TEXT NOT NULL,
    word_count  INTEGER NOT NULL DEFAULT 0,
    source      TEXT NOT NULL DEFAULT 'auto',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(chapter_id, version_no)
);

-- AI Provider Configurations
CREATE TABLE IF NOT EXISTS provider_configs (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    provider    TEXT NOT NULL,
    api_key     TEXT NOT NULL DEFAULT '',
    base_url    TEXT,
    model       TEXT NOT NULL,
    parameters  TEXT NOT NULL DEFAULT '{}',
    is_default  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- AI Conversations
CREATE TABLE IF NOT EXISTS conversations (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    chapter_id  TEXT REFERENCES chapters(id) ON DELETE SET NULL,
    title       TEXT,
    provider_config_id TEXT REFERENCES provider_configs(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversation_messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    token_count     INTEGER,
    agent_id        TEXT,
    metadata        TEXT DEFAULT '{}',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Agent Definitions
CREATE TABLE IF NOT EXISTS agent_configs (
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

-- Agent Groups
CREATE TABLE IF NOT EXISTS agent_groups (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
    collaboration_mode TEXT NOT NULL DEFAULT 'chapter_pipeline',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_group_members (
    group_id    TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
    agent_id    TEXT NOT NULL REFERENCES agent_configs(id) ON DELETE CASCADE,
    turn_order  INTEGER NOT NULL,
    can_initiate INTEGER NOT NULL DEFAULT 1,
    is_moderator INTEGER NOT NULL DEFAULT 0,
    routing_rules TEXT DEFAULT '{}',
    PRIMARY KEY (group_id, agent_id)
);

-- Knowledge Base
CREATE TABLE IF NOT EXISTS knowledge_docs (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    filename    TEXT NOT NULL,
    source_path TEXT NOT NULL,
    file_type   TEXT NOT NULL,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    char_count  INTEGER NOT NULL DEFAULT 0,
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    metadata    TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS knowledge_doc_chunks (
    doc_id      TEXT NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content     TEXT NOT NULL,
    PRIMARY KEY (doc_id, chunk_index)
);

-- Novel Memory
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

-- Writing Skills (user-imported methodology packages)
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
    doc_paths     TEXT NOT NULL DEFAULT '[]',
    installed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- App Settings
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_chapters_project ON chapters(project_id);
CREATE INDEX IF NOT EXISTS idx_chapters_parent ON chapters(parent_id);
CREATE INDEX IF NOT EXISTS idx_chapter_versions_chapter ON chapter_versions(chapter_id);
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON conversation_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_docs_project ON knowledge_docs(project_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc ON knowledge_doc_chunks(doc_id);
CREATE INDEX IF NOT EXISTS idx_agent_groups_project ON agent_groups(project_id);
CREATE INDEX IF NOT EXISTS idx_novel_memories_project_type ON novel_memories(project_id, memory_type);
CREATE INDEX IF NOT EXISTS idx_novel_memories_subject ON novel_memories(project_id, subject);
CREATE INDEX IF NOT EXISTS idx_novel_memories_chapter ON novel_memories(source_chapter_id);

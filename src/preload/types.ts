import type { PlannedChapterEditRequest, PlannedChapterEditResult } from '../shared/novelEditPlan'
import type { AppAgentActionEvent, AppAgentMessageParams, AppAgentMessageResult, AppUIEffect } from '../shared/appActions'
import type { AppearanceSettings } from '../shared/appearance'
import type { SkillBindings, SkillRecord } from '../shared/skills'
import type { WritingAgentRole } from '../shared/writingAgents'

export interface ChapterData {
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

export interface ChapterVersionData {
  id: string
  chapter_id: string
  version_no: number
  content: string
  word_count: number
  source: string
  created_at: string
}

export interface ProjectData {
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

export interface ProviderConfig {
  id: string
  name: string
  provider: 'anthropic' | 'openai' | 'openai-compat'
  api_key: string
  base_url: string | null
  model: string
  parameters: string
  is_default: number
  created_at: string
}

export interface ProviderConfigInput {
  name: string
  provider: ProviderConfig['provider']
  api_key: string
  base_url?: string | null
  model: string
  parameters?: Record<string, unknown>
  is_default?: boolean
}

export interface AIStreamParams {
  conversationId: string
  providerConfigId: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  /** The raw user turn for this request. Kept separate from sanitized history for idempotent persistence. */
  userMessage?: string
  aiParams?: Record<string, unknown>
}

export interface SearchResult {
  docId: string
  filename: string
  fileType: string
  chunkIndex: number
  content: string
  score: number
}

export interface KnowledgeDoc {
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

export interface AgentConfig {
  id: string
  name: string
  description: string | null
  role: string
  system_prompt: string
  model: string
  provider_config_id: string | null
  pipeline_role: WritingAgentRole | null
  is_system: number
  tools: string
  parameters: string
  category_id: string | null
  created_at: string
}

export interface ExportProgressData {
  projectId: string
  done: number
  total: number
  percent: number
  status: 'started' | 'writing' | 'done' | 'error'
  message?: string
}

export type OutlineType = 'outline' | 'detailed'

export interface ProjectOutline {
  id: string
  project_id: string
  type: OutlineType
  title: string
  content: string
  updated_at: string
  created_at: string
}

export interface ConversationData {
  id: string
  project_id: string
  chapter_id: string | null
  title: string | null
  provider_config_id: string | null
  created_at: string
}

export interface MessageData {
  id: string
  conversation_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  token_count: number | null
  agent_id: string | null
  metadata: string
  created_at: string
}

export interface ElectronAPI {
  lifecycle: {
    onBeforeClose(callback: () => void): () => void
    completeClose(saved: boolean): Promise<void>
  }
  file: {
    createProject(name: string, rootPath: string): Promise<ProjectData>
    listProjects(): Promise<ProjectSummary[]>
    getProject(id: string): Promise<ProjectData | undefined>
    deleteProject(id: string): Promise<void>
    getChapterWordTarget(projectId: string): Promise<number | null>
    setChapterWordTarget(projectId: string, value: number | null): Promise<number | null>
    listChapters(projectId: string): Promise<ChapterData[]>
    createChapter(params: { projectId: string; parentId?: string | null; title: string; content?: string }): Promise<ChapterData>
    saveChapter(id: string, content: string): Promise<ChapterData | undefined>
    renameChapter(id: string, title: string): Promise<void>
    deleteChapter(id: string): Promise<void>
    updateChapterOrder(chapterIds: string[]): Promise<ChapterData[]>
    listChapterVersions(chapterId: string): Promise<ChapterVersionData[]>
    exportProjectTxt(projectId: string): Promise<{ canceled: true } | { canceled: false; filePath: string; fileName: string; chapterCount: number }>
    onExportProgress(callback: (data: ExportProgressData) => void): () => void
    openFileDialog(options?: { filters?: { name: string; extensions: string[] }[]; properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'> }): Promise<string[] | null>
    saveFileDialog(options?: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>
  }
  ai: {
    listProviders(): Promise<ProviderConfig[]>
    getProvider(id: string): Promise<ProviderConfig | undefined>
    createProvider(params: ProviderConfigInput): Promise<ProviderConfig>
    updateProvider(id: string, updates: Partial<ProviderConfigInput>): Promise<void>
    deleteProvider(id: string): Promise<void>
    testConnection(configId: string): Promise<{ ok: boolean; error?: string }>
    createConversation(projectId: string, chapterId?: string, title?: string, providerConfigId?: string): Promise<ConversationData>
    listConversations(projectId: string): Promise<ConversationData[]>
    deleteConversation(conversationId: string): Promise<void>
    getMessages(conversationId: string): Promise<MessageData[]>
    sendMessage(params: AIStreamParams): Promise<{ content?: string; conversationId: string; error?: string; aborted?: boolean }>
    abortStream(conversationId: string): Promise<void>
    sendMessageSync(params: { providerConfigId: string; messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>; aiParams?: Record<string, unknown> }): Promise<{ content: string; usage: { inputTokens: number; outputTokens: number } }>
    planChapterEdit(params: PlannedChapterEditRequest): Promise<PlannedChapterEditResult>
    onToken(callback: (data: { conversationId: string; token: string }) => void): () => void
    onThinking(callback: (data: { conversationId: string; thinking: string }) => void): () => void
  }
  appAgent: {
    sendMessage(params: AppAgentMessageParams): Promise<AppAgentMessageResult>
    abortMessage(conversationId: string): Promise<void>
    onAction(callback: (event: AppAgentActionEvent) => void): () => void
  }
  skill: {
    list(): Promise<SkillRecord[]>
    import(sourcePath: string): Promise<SkillRecord>
    rename(id: string, name: string): Promise<SkillRecord | undefined>
    delete(id: string): Promise<void>
    getBindings(): Promise<SkillBindings>
    setBindings(bindings: SkillBindings): Promise<SkillBindings>
  }
  settings: {
    getAppearance(): Promise<AppearanceSettings>
    updateAppearance(updates: Partial<AppearanceSettings>): Promise<AppearanceSettings>
    importBackgroundImage(filePath: string): Promise<AppearanceSettings>
    clearBackgroundImage(): Promise<AppearanceSettings>
  }
  knowledge: {
    importDocument(filePath: string, projectId: string): Promise<KnowledgeDoc>
    search(query: string, projectId: string, options?: { limit?: number }): Promise<SearchResult[]>
    searchContext(query: string, projectId: string): Promise<string>
    listDocuments(projectId: string): Promise<KnowledgeDoc[]>
    deleteDocument(docId: string): Promise<void>
  }
  outline: {
    list(projectId: string): Promise<ProjectOutline[]>
    get(id: string): Promise<ProjectOutline | undefined>
    create(params: { projectId: string; type: OutlineType; title: string; content?: string }): Promise<ProjectOutline>
    update(id: string, updates: { title?: string; content?: string }): Promise<void>
    saveContent(id: string, content: string): Promise<void>
    delete(id: string): Promise<void>
  }
  agent: {
    getWritingTeam(): Promise<AgentConfig[]>
    updateWritingAgent(role: WritingAgentRole, updates: { provider_config_id?: string | null; system_prompt?: string; parameters?: Record<string, unknown> }): Promise<AgentConfig>
    runWritingWorkflow(projectId: string, inputContext: string, chapterId?: string | null): Promise<{ ok: boolean; message?: string }>
    stopWorkflow(): Promise<{ ok: boolean; message?: string }>
    sendWorkflowMessage(message: string): Promise<{ ok: boolean; message?: string }>
    onWorkflowEvent(callback: (event: WorkflowEvent) => void): () => void
    onChapterUpdate(callback: (event: ChapterUpdateEvent) => void): () => void
    onChapterCreated(callback: (chapter: ChapterData) => void): () => void
  }
}

export interface ChapterUpdateEvent {
  projectId?: string
  runId?: number
  chapterId: string
  oldContent: string
  newContent: string
}

export type WorkflowEvent = (
  | { type: 'agentStart'; agentId: string; agentName: string }
  | { type: 'agentToken'; agentId: string; token: string }
  | { type: 'agentThinking'; agentId: string; thinking: string }
  | { type: 'agentComplete'; agentId: string; result: { agentId: string; content: string; toolCalls: Array<{ tool: string; input: string; output: string; ok?: boolean; data?: unknown; uiEffects?: AppUIEffect[] }>; quality?: { hallucinationRisk: 'low' | 'medium' | 'high'; issues: string[]; tokenCount: number } } }
  | { type: 'roundComplete'; round: number }
  | { type: 'workflowComplete'; summary: string }
  | { type: 'error'; message: string }
) & { projectId?: string; runId?: number }

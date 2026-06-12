import type { PlannedChapterEditRequest, PlannedChapterEditResult } from '../shared/novelEditPlan'
import type { AppAgentActionEvent, AppAgentMessageParams, AppAgentMessageResult, AppUIEffect } from '../shared/appActions'
import type { AppearanceSettings } from '../shared/appearance'

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
  default_agent_group_id: string | null
  metadata: string
}

export interface ProjectSummary {
  id: string
  name: string
  root_path: string
  updated_at: string
  default_agent_group_id: string | null
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
  tools: string
  parameters: string
  category_id: string | null
  created_at: string
}

export interface AgentCategory {
  id: string
  name: string
  created_at: string
}

export interface AgentGroup {
  id: string
  name: string
  project_id: string | null
  collaboration_mode: 'round_robin' | 'moderator'
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

export interface AgentGroupMember {
  group_id: string
  agent_id: string
  turn_order: number
  can_initiate: number
  is_moderator: number
  routing_rules: string
  name: string
  role: string
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
  file: {
    createProject(name: string, rootPath: string, agentGroupId?: string | null): Promise<ProjectData>
    listProjects(): Promise<ProjectSummary[]>
    getProject(id: string): Promise<ProjectData | undefined>
    deleteProject(id: string): Promise<void>
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
    getMessages(conversationId: string): Promise<MessageData[]>
    sendMessage(params: AIStreamParams): Promise<{ content?: string; conversationId: string; error?: string }>
    sendMessageSync(params: { providerConfigId: string; messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>; aiParams?: Record<string, unknown> }): Promise<{ content: string; usage: { inputTokens: number; outputTokens: number } }>
    planChapterEdit(params: PlannedChapterEditRequest): Promise<PlannedChapterEditResult>
    onToken(callback: (data: { conversationId: string; token: string }) => void): () => void
  }
  appAgent: {
    sendMessage(params: AppAgentMessageParams): Promise<AppAgentMessageResult>
    onAction(callback: (event: AppAgentActionEvent) => void): () => void
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
    list(): Promise<AgentConfig[]>
    get(id: string): Promise<AgentConfig | undefined>
    create(params: { name: string; description?: string; role: string; system_prompt: string; model: string; tools?: string[]; parameters?: Record<string, unknown>; category_id?: string | null }): Promise<AgentConfig>
    update(id: string, updates: Partial<{ name: string; description?: string; role: string; system_prompt: string; model: string; tools?: string[]; parameters?: Record<string, unknown>; category_id?: string | null }>): Promise<void>
    delete(id: string): Promise<void>
    listCategories(): Promise<AgentCategory[]>
    createCategory(name: string): Promise<AgentCategory>
    updateCategory(id: string, name: string): Promise<void>
    deleteCategory(id: string): Promise<void>
    listGroups(projectId: string): Promise<AgentGroup[]>
    listAllGroups(): Promise<AgentGroup[]>
    createGroup(name: string, projectId?: string | null, collaborationMode?: string): Promise<AgentGroup>
    updateGroup(id: string, updates: { name?: string; collaboration_mode?: string }): Promise<void>
    getGroup(id: string): Promise<AgentGroup | undefined>
    getGroupMembers(groupId: string): Promise<AgentGroupMember[]>
    addGroupMember(groupId: string, agentId: string, turnOrder: number, canInitiate?: boolean, isModerator?: boolean): Promise<void>
    removeGroupMember(groupId: string, agentId: string): Promise<void>
    deleteGroup(groupId: string): Promise<void>
    bindProjectGroup(projectId: string, groupId: string | null): Promise<void>
    runWorkflow(groupId: string, projectId: string, inputContext: string): Promise<{ ok: boolean; message?: string }>
    stopWorkflow(): Promise<{ ok: boolean; message?: string }>
    sendWorkflowMessage(message: string): Promise<{ ok: boolean; message?: string }>
    onWorkflowEvent(callback: (event: WorkflowEvent) => void): () => void
    onChapterUpdate(callback: (event: ChapterUpdateEvent) => void): () => void
    onChapterCreated(callback: (chapter: ChapterData) => void): () => void
  }
}

export interface ChapterUpdateEvent {
  chapterId: string
  oldContent: string
  newContent: string
}

export type WorkflowEvent =
  | { type: 'agentStart'; agentId: string; agentName: string }
  | { type: 'agentToken'; agentId: string; token: string }
  | { type: 'agentThinking'; agentId: string; thinking: string }
  | { type: 'agentComplete'; agentId: string; result: { agentId: string; content: string; toolCalls: Array<{ tool: string; input: string; output: string; ok?: boolean; data?: unknown; uiEffects?: AppUIEffect[] }>; quality?: { hallucinationRisk: 'low' | 'medium' | 'high'; issues: string[]; tokenCount: number } } }
  | { type: 'roundComplete'; round: number }
  | { type: 'workflowComplete'; summary: string }
  | { type: 'error'; message: string }

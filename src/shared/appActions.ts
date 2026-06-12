export type AppPanel = 'chat' | 'agent' | 'knowledge' | 'outline' | 'settings'

export type AppActionSafety = 'read' | 'write' | 'ui' | 'confirm' | 'destructive'

export type AppActionName =
  | 'get_project_context'
  | 'resolve_chapter'
  | 'list_chapters'
  | 'read_chapter'
  | 'create_chapter'
  | 'propose_chapter_edit'
  | 'update_chapter_content'
  | 'update_chapter_status'
  | 'rename_chapter'
  | 'list_chapter_versions'
  | 'list_outlines'
  | 'read_outline'
  | 'upsert_outline'
  | 'search_knowledge'
  | 'list_knowledge'
  | 'open_panel'
  | 'select_chapter'

export interface AppActionDefinition {
  name: AppActionName
  title: string
  description: string
  safety: AppActionSafety
  inputSchema: Record<string, string>
}

export interface AppActionCall {
  id?: string
  name: AppActionName | string
  input?: Record<string, unknown>
}

export type AppUIEffect =
  | { type: 'open_panel'; panel: AppPanel }
  | { type: 'select_chapter'; chapterId: string }
  | { type: 'chapter_proposal'; projectId: string; chapterId: string; title?: string; html: string; oldHtml?: string; sourceName?: string }
  | { type: 'refresh_chapters'; projectId: string }
  | { type: 'chapter_updated'; projectId: string; chapterId: string; title?: string; content?: string }
  | { type: 'refresh_outlines'; projectId: string; types?: Array<'outline' | 'detailed'> }
  | { type: 'refresh_knowledge'; projectId: string }

export interface AppActionResult {
  id: string
  name: string
  ok: boolean
  message: string
  data?: unknown
  uiEffects?: AppUIEffect[]
  requiresConfirmation?: boolean
}

export interface AppAgentMessageParams {
  conversationId: string
  providerConfigId: string
  projectId: string
  chapterId?: string | null
  currentPanel?: AppPanel | null
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  aiParams?: Record<string, unknown>
}

export interface AppAgentMessageResult {
  content?: string
  conversationId: string
  actionResults: AppActionResult[]
  error?: string
}

export interface AppAgentActionEvent {
  conversationId: string
  status: 'started' | 'completed' | 'error'
  action: string
  message: string
  result?: AppActionResult
  uiEffects?: AppUIEffect[]
}

export const APP_ACTION_DEFINITIONS: AppActionDefinition[] = [
  {
    name: 'get_project_context',
    title: '读取当前项目上下文',
    description: '读取项目名称、当前章节、章节数量、大纲数量和知识库数量。',
    safety: 'read',
    inputSchema: {}
  },
  {
    name: 'list_chapters',
    title: '列出章节',
    description: '列出当前项目全部章节的 ID、标题、排序和字数。',
    safety: 'read',
    inputSchema: {}
  },
  {
    name: 'resolve_chapter',
    title: '定位章节',
    description: '根据 chapterId、标题关键词、序号或“第二章”这类自然语言引用定位章节。',
    safety: 'read',
    inputSchema: { chapterId: '可选，章节 ID', title: '可选，标题关键词', reference: '可选，自然语言章节引用，如 第二章', ordinal: '可选，章节序号数字' }
  },
  {
    name: 'read_chapter',
    title: '读取章节',
    description: '按 chapterId 或标题关键词读取章节正文。',
    safety: 'read',
    inputSchema: { chapterId: '可选，章节 ID', title: '可选，章节标题关键词' }
  },
  {
    name: 'create_chapter',
    title: '创建章节',
    description: '创建新章节，可同时写入正文。适合用户明确要求新增章节时使用。',
    safety: 'write',
    inputSchema: { title: '必填，章节标题', content: '可选，章节正文' }
  },
  {
    name: 'propose_chapter_edit',
    title: '提交正文修改预览',
    description: '把章节正文修改放入编辑器确认条，等待用户接受并保存。适合写作、续写、润色、按细纲完成章节等场景。',
    safety: 'confirm',
    inputSchema: {
      chapterId: '可选，章节 ID；没有时可用 title/reference/ordinal 或当前章节',
      title: '可选，章节标题关键词',
      reference: '可选，自然语言章节引用，如 第二章',
      ordinal: '可选，章节序号数字',
      content: '必填，要放入正文确认区的小说正文',
      mode: '可选，replace | append | prepend，默认 replace'
    }
  },
  {
    name: 'update_chapter_content',
    title: '更新章节正文',
    description: '替换、追加或前置指定章节正文。只有用户明确要求写入正文时才使用。',
    safety: 'write',
    inputSchema: {
      chapterId: '必填，章节 ID',
      content: '必填，要写入的正文',
      mode: '可选，replace | append | prepend，默认 replace'
    }
  },
  {
    name: 'update_chapter_status',
    title: '修改章节状态',
    description: '把章节标记为 draft、revising、done 等状态。',
    safety: 'write',
    inputSchema: { chapterId: '可选，章节 ID', title: '可选，标题关键词', reference: '可选，自然语言章节引用', status: '必填，draft | revising | done' }
  },
  {
    name: 'rename_chapter',
    title: '重命名章节',
    description: '修改指定章节标题。',
    safety: 'write',
    inputSchema: { chapterId: '必填，章节 ID', title: '必填，新标题' }
  },
  {
    name: 'list_chapter_versions',
    title: '读取章节版本',
    description: '列出指定章节的历史版本，用于回看、比较或恢复前确认。',
    safety: 'read',
    inputSchema: { chapterId: '可选，章节 ID', title: '可选，标题关键词', reference: '可选，自然语言章节引用' }
  },
  {
    name: 'list_outlines',
    title: '读取大纲细纲',
    description: '列出当前项目的大纲或细纲。',
    safety: 'read',
    inputSchema: { type: '可选，outline | detailed' }
  },
  {
    name: 'read_outline',
    title: '读取大纲细纲内容',
    description: '读取指定大纲或细纲的完整内容，可按 id、type、title 查询。',
    safety: 'read',
    inputSchema: { id: '可选，大纲/细纲 ID', type: '可选，outline | detailed', title: '可选，标题关键词' }
  },
  {
    name: 'upsert_outline',
    title: '写入大纲细纲',
    description: '按标题创建或更新大纲/细纲。适合用户要求整理并放入结构区时使用。',
    safety: 'write',
    inputSchema: { type: '必填，outline | detailed', title: '必填，标题', content: '必填，完整内容' }
  },
  {
    name: 'search_knowledge',
    title: '搜索知识库',
    description: '在当前项目知识库中搜索关键词，返回相关参考片段。',
    safety: 'read',
    inputSchema: { query: '必填，搜索词', limit: '可选，返回数量，默认 5' }
  },
  {
    name: 'list_knowledge',
    title: '列出知识库文档',
    description: '列出当前项目已导入的知识库文档。',
    safety: 'read',
    inputSchema: {}
  },
  {
    name: 'open_panel',
    title: '打开右侧面板',
    description: '切换右侧面板到 AI、Agent、大纲、知识库或设置。',
    safety: 'ui',
    inputSchema: { panel: '必填，chat | agent | knowledge | outline | settings' }
  },
  {
    name: 'select_chapter',
    title: '选择章节',
    description: '按 chapterId 或标题关键词切换当前编辑章节。',
    safety: 'ui',
    inputSchema: { chapterId: '可选，章节 ID', title: '可选，章节标题关键词' }
  }
]

export function getAppActionDefinition(name: string): AppActionDefinition | undefined {
  return APP_ACTION_DEFINITIONS.find(action => action.name === name)
}

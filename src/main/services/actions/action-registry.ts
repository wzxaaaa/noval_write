import { htmlToPlainText } from '../../../shared/textMetrics'
import { APP_ACTION_DEFINITIONS, getAppActionDefinition, type AppActionCall, type AppActionName, type AppActionResult, type AppPanel } from '../../../shared/appActions'
import { normalizeChapterContent } from '../../../shared/chapterFormat'
import { chapterRepo, type ChapterRow } from '../../db/repositories/chapter.repo'
import { knowledgeDocRepo } from '../../db/repositories/knowledge-doc.repo'
import { outlineRepo, type OutlineType } from '../../db/repositories/outline.repo'
import { projectRepo } from '../../db/repositories/project.repo'
import { retrieverService } from '../knowledge/retriever'

export interface AppActionContext {
  projectId: string
  chapterId?: string | null
  currentPanel?: AppPanel | null
}

export class ActionRegistry {
  constructor(private context: AppActionContext) {}

  listDefinitions(): typeof APP_ACTION_DEFINITIONS {
    return APP_ACTION_DEFINITIONS
  }

  getRuntimeContext(): Record<string, unknown> {
    const project = projectRepo.getById(this.context.projectId)
    const chapters = chapterRepo.listByProject(this.context.projectId)
    const outlines = outlineRepo.listByProject(this.context.projectId)
    const docs = knowledgeDocRepo.listByProject(this.context.projectId)
    const currentChapter = this.context.chapterId
      ? chapters.find(chapter => chapter.id === this.context.chapterId)
      : null

    return {
      project: project ? {
        id: project.id,
        name: project.name,
        root_path: project.root_path,
        default_agent_group_id: project.default_agent_group_id
      } : null,
      currentPanel: this.context.currentPanel ?? null,
      currentChapter: currentChapter ? {
        ...toChapterSummary(currentChapter),
        plainText: truncateText(htmlToPlainText(currentChapter.content), 1800),
        tail: truncateText(htmlToPlainText(currentChapter.content).slice(-1200), 1200)
      } : null,
      chapters: chapters.map(toChapterSummary),
      outlines: outlines.map(outline => ({
        id: outline.id,
        type: outline.type,
        title: outline.title,
        updated_at: outline.updated_at,
        preview: truncateText(outline.content, 500)
      })),
      knowledgeDocs: docs.map(doc => ({
        id: doc.id,
        filename: doc.filename,
        file_type: doc.file_type,
        chunk_count: doc.chunk_count,
        char_count: doc.char_count
      }))
    }
  }

  async execute(call: AppActionCall): Promise<AppActionResult> {
    const id = call.id || `${call.name}-${Date.now()}`
    const definition = getAppActionDefinition(call.name)
    if (!definition) {
      return fail(id, call.name, `未知动作：${call.name}`)
    }

    try {
      switch (definition.name) {
        case 'get_project_context':
          return this.getProjectContext(id)
        case 'resolve_chapter':
          return this.resolveChapter(id, call.input)
        case 'list_chapters':
          return this.listChapters(id)
        case 'read_chapter':
          return this.readChapter(id, call.input)
        case 'create_chapter':
          return this.createChapter(id, call.input)
        case 'propose_chapter_edit':
          return this.proposeChapterEdit(id, call.input)
        case 'update_chapter_content':
          return this.updateChapterContent(id, call.input)
        case 'update_chapter_status':
          return this.updateChapterStatus(id, call.input)
        case 'rename_chapter':
          return this.renameChapter(id, call.input)
        case 'list_chapter_versions':
          return this.listChapterVersions(id, call.input)
        case 'list_outlines':
          return this.listOutlines(id, call.input)
        case 'read_outline':
          return this.readOutline(id, call.input)
        case 'upsert_outline':
          return this.upsertOutline(id, call.input)
        case 'search_knowledge':
          return this.searchKnowledge(id, call.input)
        case 'list_knowledge':
          return this.listKnowledge(id)
        case 'open_panel':
          return this.openPanel(id, call.input)
        case 'select_chapter':
          return this.selectChapter(id, call.input)
        default:
          return fail(id, definition.name, `暂不支持动作：${definition.name}`)
      }
    } catch (err) {
      return fail(id, definition.name, (err as Error).message)
    }
  }

  private getProjectContext(id: string): AppActionResult {
    const project = projectRepo.getById(this.context.projectId)
    if (!project) return fail(id, 'get_project_context', '当前项目不存在')

    return ok(id, 'get_project_context', `已读取项目「${project.name}」上下文`, this.getRuntimeContext())
  }

  private resolveChapter(id: string, input: Record<string, unknown> | undefined): AppActionResult {
    const chapter = this.findChapter(input)
    if (!chapter) return fail(id, 'resolve_chapter', '未找到匹配章节')

    return ok(id, 'resolve_chapter', `已定位章节「${chapter.title}」`, {
      ...toChapterSummary(chapter),
      plainText: truncateText(htmlToPlainText(chapter.content), 1800)
    })
  }

  private listChapters(id: string): AppActionResult {
    const chapters = chapterRepo.listByProject(this.context.projectId)
    return ok(id, 'list_chapters', `已读取 ${chapters.length} 个章节`, chapters.map(toChapterSummary))
  }

  private readChapter(id: string, input: Record<string, unknown> | undefined): AppActionResult {
    const chapter = this.findChapter(input)
    if (!chapter) return fail(id, 'read_chapter', '未找到匹配章节')

    return ok(id, 'read_chapter', `已读取章节「${chapter.title}」`, {
      ...toChapterSummary(chapter),
      content: chapter.content,
      plainText: htmlToPlainText(chapter.content)
    })
  }

  private createChapter(id: string, input: Record<string, unknown> | undefined): AppActionResult {
    const title = readString(input, 'title')
    const content = readOptionalString(input, 'content') ?? ''
    if (!title.trim()) return fail(id, 'create_chapter', '章节标题不能为空')

    const chapters = chapterRepo.listByProject(this.context.projectId)
    const nextOrder = chapters.reduce((max, chapter) => Math.max(max, chapter.sort_order), -1) + 1
    const chapter = chapterRepo.create({
      project_id: this.context.projectId,
      title,
      content,
      sort_order: nextOrder
    })

    return ok(id, 'create_chapter', `已创建章节「${chapter.title}」`, toChapterSummary(chapter), [
      { type: 'refresh_chapters', projectId: this.context.projectId },
      { type: 'select_chapter', chapterId: chapter.id }
    ])
  }

  private proposeChapterEdit(id: string, input: Record<string, unknown> | undefined): AppActionResult {
    const chapter = this.findChapter(input)
    if (!chapter) return fail(id, 'propose_chapter_edit', '未找到要修改的章节')

    const content = readString(input, 'content')
    if (!content.trim()) return fail(id, 'propose_chapter_edit', '正文提案不能为空')

    const mode = normalizeEditMode(readOptionalString(input, 'mode'))
    const proposedText = composeChapterText(chapter.content, content, mode)
    const proposedHtml = normalizeChapterContent(proposedText)
    const sourceName = readOptionalString(input, 'sourceName') || readOptionalString(input, 'source') || '小漫正文提案'

    return ok(
      id,
      'propose_chapter_edit',
      `已把章节「${chapter.title}」的正文修改放入确认区`,
      {
        target: toChapterSummary(chapter),
        mode,
        proposedText: truncateText(htmlToPlainText(proposedHtml), 1800)
      },
      [
        { type: 'select_chapter', chapterId: chapter.id },
        {
          type: 'chapter_proposal',
          projectId: this.context.projectId,
          chapterId: chapter.id,
          title: chapter.title,
          html: proposedHtml,
          oldHtml: chapter.content,
          sourceName
        }
      ],
      true
    )
  }

  private updateChapterContent(id: string, input: Record<string, unknown> | undefined): AppActionResult {
    const chapter = this.findChapter(input)
    if (!chapter) return fail(id, 'update_chapter_content', '未找到要更新的章节')

    const content = readString(input, 'content')
    if (!content.trim()) return fail(id, 'update_chapter_content', '写入正文不能为空')

    const mode = normalizeEditMode(readOptionalString(input, 'mode'))
    const nextContent = composeChapterText(chapter.content, content, mode)

    const updated = chapterRepo.updateContent(chapter.id, normalizeChapterContent(nextContent))
    if (!updated) return fail(id, 'update_chapter_content', '章节更新失败')

    return ok(id, 'update_chapter_content', `已更新章节「${updated.title}」正文`, toChapterSummary(updated), [
      { type: 'refresh_chapters', projectId: this.context.projectId },
      { type: 'chapter_updated', projectId: this.context.projectId, chapterId: updated.id, title: updated.title, content: updated.content }
    ])
  }

  private updateChapterStatus(id: string, input: Record<string, unknown> | undefined): AppActionResult {
    const chapter = this.findChapter(input)
    if (!chapter) return fail(id, 'update_chapter_status', '未找到要修改状态的章节')

    const status = normalizeChapterStatus(readString(input, 'status'))
    if (!status) return fail(id, 'update_chapter_status', 'status 必须是 draft、revising 或 done')

    chapterRepo.updateStatus(chapter.id, status)
    const updated = chapterRepo.getById(chapter.id)
    return ok(id, 'update_chapter_status', `已把章节「${chapter.title}」标记为 ${status}`, updated ? toChapterSummary(updated) : toChapterSummary(chapter), [
      { type: 'refresh_chapters', projectId: this.context.projectId },
      { type: 'chapter_updated', projectId: this.context.projectId, chapterId: chapter.id, title: updated?.title ?? chapter.title }
    ])
  }

  private renameChapter(id: string, input: Record<string, unknown> | undefined): AppActionResult {
    const chapter = this.findChapter(input)
    if (!chapter) return fail(id, 'rename_chapter', '未找到要重命名的章节')

    const title = readString(input, 'title')
    if (!title.trim()) return fail(id, 'rename_chapter', '新标题不能为空')

    chapterRepo.updateTitle(chapter.id, title)
    const updated = chapterRepo.getById(chapter.id)

    return ok(id, 'rename_chapter', `已重命名为「${updated?.title ?? title}」`, updated ? toChapterSummary(updated) : undefined, [
      { type: 'refresh_chapters', projectId: this.context.projectId },
      { type: 'chapter_updated', projectId: this.context.projectId, chapterId: chapter.id, title }
    ])
  }

  private listChapterVersions(id: string, input: Record<string, unknown> | undefined): AppActionResult {
    const chapter = this.findChapter(input)
    if (!chapter) return fail(id, 'list_chapter_versions', '未找到匹配章节')

    const versions = chapterRepo.listVersions(chapter.id).map(version => ({
      id: version.id,
      chapter_id: version.chapter_id,
      version_no: version.version_no,
      word_count: version.word_count,
      source: version.source,
      created_at: version.created_at,
      preview: truncateText(htmlToPlainText(version.content), 1200)
    }))

    return ok(id, 'list_chapter_versions', `已读取章节「${chapter.title}」的 ${versions.length} 个版本`, versions)
  }

  private listOutlines(id: string, input: Record<string, unknown> | undefined): AppActionResult {
    const type = readOutlineType(input, false)
    const outlines = type
      ? outlineRepo.getByProjectAndType(this.context.projectId, type)
      : outlineRepo.listByProject(this.context.projectId)

    return ok(id, 'list_outlines', `已读取 ${outlines.length} 条${type ? labelOutlineType(type) : '大纲/细纲'}`, outlines)
  }

  private readOutline(id: string, input: Record<string, unknown> | undefined): AppActionResult {
    const outline = this.findOutline(input)
    if (!outline) return fail(id, 'read_outline', '未找到匹配的大纲或细纲')

    return ok(id, 'read_outline', `已读取${labelOutlineType(outline.type)}「${outline.title}」`, outline)
  }

  private upsertOutline(id: string, input: Record<string, unknown> | undefined): AppActionResult {
    const type = readOutlineType(input, true)!
    const title = readString(input, 'title')
    const content = readString(input, 'content')
    if (!title.trim()) return fail(id, 'upsert_outline', '标题不能为空')
    if (!content.trim()) return fail(id, 'upsert_outline', '内容不能为空')

    const existing = outlineRepo.getByProjectAndType(this.context.projectId, type)
    const match = existing.find(outline => outline.title.trim().toLowerCase() === title.trim().toLowerCase())
    const outline = match
      ? (outlineRepo.update(match.id, { title, content }), outlineRepo.getById(match.id))
      : outlineRepo.create(this.context.projectId, type, title, content)

    return ok(id, 'upsert_outline', `已写入${labelOutlineType(type)}「${title}」`, outline, [
      { type: 'open_panel', panel: 'outline' },
      { type: 'refresh_outlines', projectId: this.context.projectId, types: [type] }
    ])
  }

  private async searchKnowledge(id: string, input: Record<string, unknown> | undefined): Promise<AppActionResult> {
    const query = readString(input, 'query')
    if (!query.trim()) return fail(id, 'search_knowledge', '搜索词不能为空')

    const limitValue = readOptionalNumber(input, 'limit')
    const results = await retrieverService.search(query, this.context.projectId, {
      limit: limitValue && limitValue > 0 ? Math.min(limitValue, 10) : 5
    })

    return ok(id, 'search_knowledge', `知识库搜索完成，命中 ${results.length} 条`, results)
  }

  private listKnowledge(id: string): AppActionResult {
    const docs = knowledgeDocRepo.listByProject(this.context.projectId)
    return ok(id, 'list_knowledge', `已读取 ${docs.length} 个知识库文档`, docs)
  }

  private openPanel(id: string, input: Record<string, unknown> | undefined): AppActionResult {
    const panel = normalizePanel(readString(input, 'panel'))
    if (!isPanel(panel)) return fail(id, 'open_panel', `未知面板：${panel}`)

    return ok(id, 'open_panel', `已打开${labelPanel(panel)}`, { panel }, [
      { type: 'open_panel', panel }
    ])
  }

  private selectChapter(id: string, input: Record<string, unknown> | undefined): AppActionResult {
    const chapter = this.findChapter(input)
    if (!chapter) return fail(id, 'select_chapter', '未找到匹配章节')

    return ok(id, 'select_chapter', `已切换到章节「${chapter.title}」`, toChapterSummary(chapter), [
      { type: 'select_chapter', chapterId: chapter.id }
    ])
  }

  private findChapter(input: Record<string, unknown> | undefined): ChapterRow | null {
    const chapterId = readOptionalString(input, 'chapterId') || readOptionalString(input, 'chapter_id')
    const title = readOptionalString(input, 'title')
    const reference = readOptionalString(input, 'reference') || readOptionalString(input, 'chapter') || readOptionalString(input, 'target')
    const ordinal = readOptionalNumber(input, 'ordinal') || parseChapterOrdinal(reference) || parseChapterOrdinal(title)
    const chapters = chapterRepo.listByProject(this.context.projectId)

    if (chapterId) {
      const chapter = chapters.find(row => row.id === chapterId)
      if (chapter) return chapter
    }

    if (title) {
      const normalizedTitle = title.trim().toLowerCase()
      const exact = chapters.find(row => row.title.trim().toLowerCase() === normalizedTitle)
      if (exact) return exact
      const fuzzy = chapters.find(row => row.title.toLowerCase().includes(normalizedTitle))
      if (fuzzy) return fuzzy
    }

    if (reference) {
      const normalizedReference = normalizeComparable(reference)
      const fuzzy = chapters.find(row => normalizeComparable(row.title).includes(normalizedReference))
      if (fuzzy) return fuzzy
    }

    if (ordinal && ordinal > 0) {
      const ordered = chapters.slice().sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))
      const byOrdinal = ordered[ordinal - 1]
      if (byOrdinal) return byOrdinal
    }

    if (!chapterId && !title && this.context.chapterId) {
      return chapters.find(row => row.id === this.context.chapterId) ?? null
    }

    return null
  }

  private findOutline(input: Record<string, unknown> | undefined) {
    const id = readOptionalString(input, 'id') || readOptionalString(input, 'outlineId') || readOptionalString(input, 'outline_id')
    const type = readOutlineType(input, false)
    const title = readOptionalString(input, 'title')
    const outlines = type
      ? outlineRepo.getByProjectAndType(this.context.projectId, type)
      : outlineRepo.listByProject(this.context.projectId)

    if (id) {
      const outline = outlines.find(row => row.id === id)
      if (outline) return outline
    }

    if (title) {
      const normalizedTitle = normalizeComparable(title)
      const exact = outlines.find(row => normalizeComparable(row.title) === normalizedTitle)
      if (exact) return exact
      const fuzzy = outlines.find(row => normalizeComparable(row.title).includes(normalizedTitle))
      if (fuzzy) return fuzzy
    }

    if (type && outlines.length === 1) return outlines[0]
    if (!type && outlines.length === 1) return outlines[0]
    return null
  }
}

function ok(
  id: string,
  name: AppActionName,
  message: string,
  data?: unknown,
  uiEffects?: AppActionResult['uiEffects'],
  requiresConfirmation?: boolean
): AppActionResult {
  return { id, name, ok: true, message, data, uiEffects, requiresConfirmation }
}

function fail(id: string, name: string, message: string): AppActionResult {
  return { id, name, ok: false, message }
}

function readString(input: Record<string, unknown> | undefined, key: string): string {
  const value = input?.[key]
  return typeof value === 'string' ? value : ''
}

function readOptionalString(input: Record<string, unknown> | undefined, key: string): string | null {
  const value = input?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readOptionalNumber(input: Record<string, unknown> | undefined, key: string): number | null {
  const value = input?.[key]
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function readOutlineType(input: Record<string, unknown> | undefined, required: boolean): OutlineType | null {
  const rawType = readOptionalString(input, 'type')
  if (!rawType) {
    if (required) throw new Error('type 必须是 outline 或 detailed')
    return null
  }
  const type = rawType.trim().toLowerCase()
  if ([
    'outline',
    'storyoutline',
    'mainoutline',
    'overalloutline',
    'plotoutline',
    'noveloutline',
    '大纲',
    '故事大纲',
    '总体大纲',
    '整体大纲',
    '总纲',
    '卷纲',
    '剧情大纲'
  ].includes(normalizeComparable(type))) return 'outline'
  if ([
    'detailed',
    'detail',
    'details',
    'detailedoutline',
    'detailoutline',
    'chapteroutline',
    'chapterplan',
    'chapterplanning',
    'sceneoutline',
    '细纲',
    '章节细纲',
    '分章细纲',
    '分场细纲',
    '章节规划',
    '章节拆解'
  ].includes(normalizeComparable(type))) return 'detailed'
  throw new Error('type 必须是 outline 或 detailed')
}

function normalizeEditMode(value: string | null): 'replace' | 'append' | 'prepend' {
  if (value === 'append' || value === '追加' || value === '章尾' || value === '末尾') return 'append'
  if (value === 'prepend' || value === '前置' || value === '章首' || value === '开头') return 'prepend'
  return 'replace'
}

function composeChapterText(chapterHtml: string, content: string, mode: 'replace' | 'append' | 'prepend'): string {
  const oldPlainText = htmlToPlainText(chapterHtml)
  const newText = content.trim()
  if (mode === 'append') return [oldPlainText, newText].filter(Boolean).join('\n\n')
  if (mode === 'prepend') return [newText, oldPlainText].filter(Boolean).join('\n\n')
  return newText
}

function normalizeChapterStatus(value: string): string | null {
  const normalized = value.trim().toLowerCase()
  const aliases: Record<string, string> = {
    draft: 'draft',
    草稿: 'draft',
    revising: 'revising',
    revision: 'revising',
    修改中: 'revising',
    修订中: 'revising',
    done: 'done',
    final: 'done',
    complete: 'done',
    completed: 'done',
    完成: 'done',
    已完成: 'done'
  }
  return aliases[normalized] ?? null
}

function parseChapterOrdinal(value: string | null): number | null {
  if (!value) return null
  const match = /第?\s*([零〇一二两三四五六七八九十百千万\d]+)\s*[章节回幕卷]?/.exec(value)
  if (!match) return null
  return parseChineseNumber(match[1])
}

function parseChineseNumber(value: string): number | null {
  const cleaned = value.trim()
  if (!cleaned) return null
  if (/^\d+$/.test(cleaned)) return Number(cleaned)

  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9
  }
  let total = 0
  let section = 0
  let current = 0

  for (const char of cleaned) {
    const digit = digits[char]
    if (digit !== undefined) {
      current = digit
      continue
    }
    if (char === '十') {
      section += (current || 1) * 10
      current = 0
      continue
    }
    if (char === '百') {
      section += (current || 1) * 100
      current = 0
      continue
    }
    if (char === '千') {
      section += (current || 1) * 1000
      current = 0
      continue
    }
    if (char === '万') {
      total += (section + current || 1) * 10000
      section = 0
      current = 0
      continue
    }
    return null
  }

  return total + section + current || null
}

function normalizeComparable(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase()
}

function truncateText(text: string, maxChars: number): string {
  const trimmed = text.trim()
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}...` : trimmed
}

function toChapterSummary(chapter: ChapterRow): Record<string, unknown> {
  return {
    id: chapter.id,
    title: chapter.title,
    sort_order: chapter.sort_order,
    word_count: chapter.word_count,
    status: chapter.status,
    updated_at: chapter.updated_at
  }
}

function isPanel(value: string): value is AppPanel {
  return ['chat', 'agent', 'knowledge', 'outline', 'settings'].includes(value)
}

function normalizePanel(value: string): string {
  const normalized = value.trim().toLowerCase()
  const aliases: Record<string, AppPanel> = {
    ai: 'chat',
    'ai对话': 'chat',
    对话: 'chat',
    聊天: 'chat',
    agent: 'agent',
    'agent协作': 'agent',
    大纲: 'outline',
    细纲: 'outline',
    '大纲/细纲': 'outline',
    outline: 'outline',
    知识库: 'knowledge',
    knowledge: 'knowledge',
    设置: 'settings',
    settings: 'settings'
  }
  return aliases[normalized] ?? normalized
}

function labelPanel(panel: AppPanel): string {
  const labels: Record<AppPanel, string> = {
    chat: 'AI 对话',
    agent: 'Agent 协作',
    knowledge: '知识库',
    outline: '大纲 / 细纲',
    settings: '设置'
  }
  return labels[panel]
}

function labelOutlineType(type: OutlineType): string {
  return type === 'outline' ? '大纲' : '细纲'
}

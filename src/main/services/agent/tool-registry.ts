import { retrieverService } from '../knowledge/retriever'
import { knowledgeDocRepo } from '../../db/repositories/knowledge-doc.repo'
import { chapterRepo } from '../../db/repositories/chapter.repo'
import { outlineRepo, type OutlineType } from '../../db/repositories/outline.repo'
import { validateChapterDraft } from './quality-monitor'
import type { AppUIEffect } from '../../../shared/appActions'

export type ToolName =
  | 'search_knowledge_base'
  | 'list_knowledge'
  | 'read_chapter'
  | 'list_chapters'
  | 'search_chapters'
  | 'fact_check_chapter'
  | 'create_chapter'
  | 'write_chapter'
  | 'call_agent'
  | 'read_outline'
  | 'write_outline'
  | 'analyze_entity'

export interface Tool {
  name: ToolName
  description: string
  execute: (input: string) => Promise<string | ToolExecutionResult>
}

export interface ToolExecutionResult {
  ok: boolean
  message: string
  data?: unknown
  uiEffects?: AppUIEffect[]
}

export interface ChapterWriteCallback {
  (chapterId: string, oldContent: string, newContent: string): void
}

export interface ChapterCreateCallback {
  (chapter: ReturnType<typeof chapterRepo.create>): void
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map()

  constructor(projectId: string, onChapterWrite?: ChapterWriteCallback, onChapterCreate?: ChapterCreateCallback) {
    this.registerTool({
      name: 'search_knowledge_base',
      description: '在知识库中搜索相关内容。输入具体关键词（如角色名、地名、专有名词），返回最相关的参考片段。注意：只使用明确匹配的结果，不要凭空编造知识库中没有的内容。',
      execute: async (query: string) => {
        const results = await retrieverService.search(query, projectId, { limit: 3 })
        if (results.length === 0) return `知识库中未找到与「${query}」相关的内容。请尝试其他关键词，或确认该设定是否确实存在于参考文档中。`
        return results.map((r, i) =>
          `[${i + 1}] ${r.filename} | ${r.chapterLabel} | 相关度${Math.round(r.score * 100)}%\n${r.content.slice(0, 600)}`
        ).join('\n\n') + '\n\n⚠ 以上为检索到的原文片段，创作时请基于这些内容进行参考，不要添加知识库中不存在的设定或情节。'
      }
    })

    this.registerTool({
      name: 'list_knowledge',
      description: '列出当前项目知识库中的所有文档（文件名、类型、字符数）',
      execute: async () => {
        const docs = knowledgeDocRepo.listByProject(projectId)
        if (docs.length === 0) return '当前项目知识库为空，没有任何参考文档。请提示用户通过知识库面板导入文档。'
        return docs.map(d => `- ${d.filename} (${d.file_type}, ${d.char_count} 字符, ${d.chunk_count} 个分块)`).join('\n')
      }
    })

    this.registerTool({
      name: 'read_chapter',
      description: '读取指定章节内容。输入章节ID或标题关键词',
      execute: async (input: string) => {
        const chapters = chapterRepo.listByProject(projectId)
        const match = chapters.find(
          c => c.id === input || c.title.toLowerCase().includes(input.toLowerCase())
        )
        if (!match) return '未找到匹配的章节'
        return `章节ID: ${match.id}\n章节: ${match.title}\n字数: ${match.word_count}\n\n${match.content}`
      }
    })

    this.registerTool({
      name: 'list_chapters',
      description: '列出当前项目中的所有章节，返回章节 ID、标题、排序和字数',
      execute: async () => {
        const chapters = chapterRepo.listByProject(projectId)
        if (chapters.length === 0) return '当前项目还没有章节'
        return chapters
          .map(c => `ID: ${c.id}\n标题: ${c.title}\n排序: ${c.sort_order}\n字数: ${c.word_count}`)
          .join('\n\n')
      }
    })

    this.registerTool({
      name: 'search_chapters',
      description: '在所有章节中搜索关键词',
      execute: async (query: string) => {
        const chapters = chapterRepo.listByProject(projectId)
        const results = chapters
          .filter(c => c.content.toLowerCase().includes(query.toLowerCase()))
          .map(c => `[${c.title}] ...${extractSnippet(c.content, query)}...`)
        return results.slice(0, 5).join('\n\n') || '未找到匹配内容'
      }
    })

    this.registerTool({
      name: 'fact_check_chapter',
      description: '对章节正文进行事实核查，输入为待核查正文，返回与现有章节和知识库相关的可能冲突或缺少依据的提示',
      execute: async (input: string) => {
        const chapters = chapterRepo.listByProject(projectId)
        const keywords = Array.from(new Set((input.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,}/g) ?? []).slice(0, 20)))
        const chapterHits = chapters
          .filter(chapter => keywords.some(keyword => chapter.content.includes(keyword) || chapter.title.includes(keyword)))
          .slice(0, 5)
          .map(chapter => `章节: ${chapter.title} (${chapter.id})，字数: ${chapter.word_count}`)
        const knowledgeHits = await retrieverService.search(keywords.slice(0, 5).join(' '), projectId, { limit: 3 })
        const knowledgeText = knowledgeHits.map(hit => `[${hit.filename} | ${hit.chapterLabel}] ${hit.content.slice(0, 300)}`)

        if (chapterHits.length === 0 && knowledgeText.length === 0) {
          return '未找到可核查依据。请谨慎处理新设定，并在正文中保持自洽。如果知识库有参考文档，建议先用 search_knowledge_base 确认相关设定是否存在。'
        }

        return [
          chapterHits.length > 0 ? `相关章节:\n${chapterHits.join('\n')}` : '',
          knowledgeText.length > 0 ? `知识库参考:\n${knowledgeText.join('\n\n')}\n\n⚠ 以上为检索到的参考内容，请据此核查正文一致性，不要引入未检索到的新设定。` : ''
        ].filter(Boolean).join('\n\n')
      }
    })

    this.registerTool({
      name: 'write_chapter',
      description: '写入或更新章节内容。输入格式:\nchapter_id: <章节ID>\ncontent:\n<新内容>',
      execute: async (input: string) => {
        const chapterMatch = input.match(/chapter_id:\s*(\S+)/)
        const contentMatch = input.match(/content:\s*([\s\S]*)/)
        if (!chapterMatch || !contentMatch) {
          return toolFail('格式错误。请使用:\nchapter_id: <章节ID>\ncontent:\n<内容>')
        }
        const chapterId = chapterMatch[1]
        const newContent = contentMatch[1].trim()
        const validation = validateChapterDraft(newContent)
        if (!validation.ok) return toolFail(`正文质量检查未通过: ${validation.reason}`)
        const chapter = chapterRepo.getById(chapterId)
        if (!chapter) return toolFail(`未找到章节: ${chapterId}`)
        if (chapter.project_id !== projectId) return toolFail('Chapter does not belong to the current project')
        const oldContent = chapter.content
        const updated = chapterRepo.updateContent(chapterId, newContent)
        if (!updated) return toolFail(`章节更新失败: ${chapterId}`)
        onChapterWrite?.(chapterId, oldContent, updated.content)
        return toolOk(`已更新章节 "${updated.title}"，写入 ${newContent.length} 字符`, updated, [
          { type: 'refresh_chapters', projectId },
          { type: 'chapter_updated', projectId, chapterId: updated.id, title: updated.title, content: updated.content }
        ])
      }
    })

    this.registerTool({
      name: 'create_chapter',
      description: '创建新章节并写入正文。输入格式:\ntitle: <章节标题>\ncontent:\n<章节正文>',
      execute: async (input: string) => {
        const titleMatch = input.match(/title:\s*(.+)/)
        const contentMatch = input.match(/content:\s*([\s\S]*)/)
        if (!titleMatch || !contentMatch) {
          return toolFail('格式错误。请使用:\ntitle: <章节标题>\ncontent:\n<章节正文>')
        }

        const title = titleMatch[1].trim()
        const content = contentMatch[1].trim()
        if (!title || !content) return toolFail('章节标题和正文不能为空')
        const validation = validateChapterDraft(content)
        if (!validation.ok) return toolFail(`正文质量检查未通过: ${validation.reason}`)

        const chapters = chapterRepo.listByProject(projectId)
        const nextOrder = chapters.reduce((max, chapter) => Math.max(max, chapter.sort_order), -1) + 1
        const chapter = chapterRepo.create({
          project_id: projectId,
          title,
          content,
          sort_order: nextOrder
        })
        onChapterCreate?.(chapter)
        return toolOk(`已创建章节 "${chapter.title}"，ID: ${chapter.id}，写入 ${content.length} 字符`, chapter, [
          { type: 'refresh_chapters', projectId },
          { type: 'select_chapter', chapterId: chapter.id }
        ])
      }
    })

    this.registerTool({
      name: 'read_outline',
      description: '读取项目的大纲或细纲内容。输入格式:\ntype: <outline|detailed>（可选，默认读取全部）',
      execute: async (input: string) => {
        let typeFilter: OutlineType | null = null
        const type = parseOutlineToolType(input)
        const typeMatch = type ? [type, type] : null
        if (typeMatch) typeFilter = typeMatch[1] as OutlineType

        const outlines = typeFilter
          ? outlineRepo.getByProjectAndType(projectId, typeFilter)
          : outlineRepo.listByProject(projectId)

        if (outlines.length === 0) {
          return `当前项目暂无${typeFilter ? (typeFilter === 'outline' ? '大纲' : '细纲') : '大纲或细纲'}数据。请先使用 write_outline 工具创建。`
        }

        return outlines.map(o =>
          `[${o.type === 'outline' ? '大纲' : '细纲'}] ${o.title}\n${'─'.repeat(o.title.length + 8)}\n${o.content}`
        ).join('\n\n')
      }
    })

    this.registerTool({
      name: 'write_outline',
      description: '创建或更新项目的大纲/细纲。输入格式:\ntype: <outline|detailed>\ntitle: <标题>\ncontent:\n<完整内容>',
      execute: async (input: string) => {
        const type = parseOutlineToolType(input)
        const titleMatch = input.match(/title:\s*(.+)/)
        const contentMatch = input.match(/content:\s*([\s\S]*)/)
        if (!type || !titleMatch || !contentMatch) {
          return toolFail('格式错误。请使用:\ntype: <outline|detailed>\ntitle: <标题>\ncontent:\n<完整内容>')
        }

        const title = titleMatch[1].trim()
        const content = contentMatch[1].trim()
        if (!title || !content) return toolFail('标题和内容不能为空')

        const existing = outlineRepo.getByProjectAndType(projectId, type)
        const match = existing.find(o => o.title.toLowerCase() === title.toLowerCase())

        if (match) {
          outlineRepo.update(match.id, { title, content })
          const updated = outlineRepo.getById(match.id)
          return toolOk(`已更新${type === 'outline' ? '大纲' : '细纲'}「${title}」，共 ${content.length} 字符`, updated, [
            { type: 'open_panel', panel: 'outline' },
            { type: 'refresh_outlines', projectId, types: [type] }
          ])
        }

        const created = outlineRepo.create(projectId, type, title, content)
        return toolOk(`已创建${type === 'outline' ? '大纲' : '细纲'}「${title}」，ID: ${created.id}，共 ${content.length} 字符`, created, [
          { type: 'open_panel', panel: 'outline' },
          { type: 'refresh_outlines', projectId, types: [type] }
        ])
      }
    })

    this.registerTool({
      name: 'analyze_entity',
      description: '深度分析知识库中的角色/实体。输入角色名（如：玄鉴），返回该实体在原文中的全部出现位置、完整chunk内容、共现实体列表及共现原文片段。可用于理清人物关系、角色背景、情节线索。你需要基于提供的原文证据进行文学分析：明确写出的关系要汇报，多个片段呈现的模式也要分析推断（标注为「推断」）。',
      execute: async (entityName: string) => {
        const name = entityName.trim()
        if (!name || name.length < 1) return '请输入要分析的角色名/实体名'

        const docs = knowledgeDocRepo.listByProject(projectId)
        if (docs.length === 0) return '知识库中没有任何参考文档。'

        const RELATIONSHIP_KEYWORDS: [string, string][] = [
          ['爱慕|倾心|喜欢|心动|暗恋|相思|痴情', '浪漫/爱慕'],
          ['牵手|拥抱|亲吻|接吻|吻|相拥|依偎', '亲密接触'],
          ['情侣|道侣|双修|夫妻|成亲|娶|嫁|求婚|定情', '情侣/婚姻'],
          ['脸红|心跳|慌乱|羞涩|害羞|低头|扭捏', '暧昧/害羞反应'],
          ['对视|凝望|注视|目光|眼神|望着|盯着|望着', '深情注视'],
          ['独自.*两人|两人.*独自|深夜|独处|私会|私下|悄悄', '私密场景'],
          ['师父|徒弟|师尊|徒儿|拜师|收徒|门下', '师徒'],
          ['父亲|母亲|爹|娘|父|母|儿子|女儿|父子|母女', '亲子'],
          ['兄弟|姐妹|兄长|姐姐|弟弟|妹妹|手足', '兄弟姐妹'],
          ['朋友|知己|挚友|故交|旧友|好友|闺蜜', '朋友'],
          ['敌人|仇人|敌对|死对头|宿敌|恨|仇', '敌对/仇怨'],
          ['主人|仆人|奴婢|侍女|侍卫|手下|追随|效忠', '主仆/从属'],
          ['保护|守护|舍命|拼死|救|挡住|挡在', '保护/牺牲'],
          ['争吵|吵架|争执|冷战|不和|翻脸|绝交|断交', '冲突/矛盾'],
        ]

        interface EntityHit {
          chunkContent: string
          chapterLabel: string
          filename: string
          chunkIdx: number
        }

        interface CoEntity {
          name: string
          totalCount: number
          chapters: Set<string>
          snippets: string[]
        }

        const allHits: EntityHit[] = []
        const coEntityMap = new Map<string, CoEntity>()
        const nameRegexGlobal = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gu')

        for (const doc of docs) {
          const rawChunks = knowledgeDocRepo.getChunks(doc.id)
          let chunks: { content: string; chapterLabel: string }[]
          if (rawChunks.length > 0) {
            chunks = rawChunks.map((c, i) => ({
              content: c,
              chapterLabel: `第${i + 1}块`
            }))
          } else {
            continue
          }

          for (let ci = 0; ci < chunks.length; ci++) {
            const chunk = chunks[ci]
            if (!chunk.content.includes(name)) continue

            const matches = chunk.content.match(nameRegexGlobal)
            const hitCount = matches ? matches.length : 0

            allHits.push({
              chunkContent: chunk.content,
              chapterLabel: chunk.chapterLabel,
              filename: doc.filename,
              chunkIdx: ci
            })

            const coNames = chunk.content.match(/[\u4e00-\u9fa5]{2,4}/g) || []
            const filteredCo = new Set<string>()
            for (const co of coNames) {
              if (co !== name && co.length >= 2) {
                filteredCo.add(co)
              }
            }
            for (const co of filteredCo) {
              const existing = coEntityMap.get(co)
              const coRegex = new RegExp(co.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gu')
              const coMatches = chunk.content.match(coRegex)
              const coCount = coMatches ? coMatches.length : 0
              const ctxLen = 120
              let snippet = ''
              for (const match of coMatches || []) {
                const idx = chunk.content.indexOf(co)
                const start = Math.max(0, idx - ctxLen)
                const end = Math.min(chunk.content.length, idx + co.length + ctxLen)
                snippet = '...' + chunk.content.slice(start, end).replace(/\n/g, ' ').replace(/\s+/g, ' ') + '...'
                break
              }
              if (existing) {
                existing.totalCount += coCount
                existing.chapters.add(chunk.chapterLabel)
                if (snippet && existing.snippets.length < 15) {
                  existing.snippets.push(snippet)
                }
              } else {
                coEntityMap.set(co, {
                  name: co,
                  totalCount: coCount,
                  chapters: new Set([chunk.chapterLabel]),
                  snippets: snippet ? [snippet] : []
                })
              }
            }
          }
        }

        if (allHits.length === 0) {
          return `知识库中未找到「${name}」的明确出现。请确认角色名拼写是否正确，或使用 search_knowledge_base 用别名搜索。`
        }

        const topCoEntities = Array.from(coEntityMap.values())
          .filter(c => c.totalCount >= 2 && c.name.length >= 2)
          .sort((a, b) => b.totalCount - a.totalCount)
          .slice(0, 30)

        const lines: string[] = []
        lines.push(`「${name}」在知识库中共出现 ${allHits.length} 次（全部展示）`)
        lines.push(`共涉及 ${docs.length} 个文档，${new Set(allHits.map(h => h.chapterLabel)).size} 个chunk区间`)
        lines.push('')

        if (topCoEntities.length > 0) {
          lines.push(`╔${'═'.repeat(48)}╗`)
          lines.push(`║    与「${name}」频繁共现的实体及关系线索分析         ║`)
          lines.push(`╚${'═'.repeat(48)}╝`)
          lines.push('')
          for (const c of topCoEntities) {
            const relHints: string[] = []
            for (const [pattern, relLabel] of RELATIONSHIP_KEYWORDS) {
              const regex = new RegExp(pattern, 'g')
              let matched = false
              for (const snip of c.snippets) {
                if (regex.test(snip)) { matched = true; break }
              }
              if (matched && !relHints.includes(relLabel)) {
                relHints.push(relLabel)
              }
            }
            const relStr = relHints.length > 0 ? `  ⚡ 发现关系线索: ${relHints.join('、')}` : ''
            lines.push(`  ▸ ${c.name}（共现${c.totalCount}次，${c.chapters.size}个区间）${relStr}`)
            if (c.snippets.length > 0) {
              const displaySnippets = c.snippets.slice(0, 5)
              for (let si = 0; si < displaySnippets.length; si++) {
                const snip = displaySnippets[si].slice(0, 180)
                lines.push(`     ┊ ${si + 1}. ${snip}`)
              }
            }
            lines.push('')
          }

          lines.push('─'.repeat(50))
          lines.push('🔍 关系关键词说明：')
          for (const [pattern, label] of RELATIONSHIP_KEYWORDS) {
            lines.push(`  ${label}: ${pattern.split('|').slice(0, 4).join('/')}`)
          }
          lines.push('')
        }

        lines.push(`${'═'.repeat(50)}`)
        lines.push(`全部原文出现记录（${allHits.length}个chunk）：`)
        lines.push(`${'═'.repeat(50)}`)
        lines.push('')

        const MAX_FULL_DISPLAY = 30
        const MAX_OUTPUT_CHARS = 200000
        let estimatedChars = lines.join('\n').length
        let truncated = false

        for (let i = 0; i < allHits.length; i++) {
          const hit = allHits[i]
          const isFullDisplay = i < MAX_FULL_DISPLAY
          const contentLines = hit.chunkContent.split('\n')
          const nameLineIndices: number[] = []
          for (let li = 0; li < contentLines.length; li++) {
            if (contentLines[li].includes(name)) {
              nameLineIndices.push(li)
            }
          }

          lines.push(`┌─ [${i + 1}/${allHits.length}] ${hit.filename} | ${hit.chapterLabel} (${nameLineIndices.length}处出现)`)
          lines.push(`│`)

          if (isFullDisplay) {
            const displayCount = Math.min(contentLines.length, 25)
            for (let li = 0; li < displayCount; li++) {
              const line = contentLines[li].replace(/\r$/, '')
              if (line.includes(name)) {
                lines.push(`│  ▸ ${line}`)
              } else {
                lines.push(`│    ${line}`)
              }
            }
            if (contentLines.length > 25) {
              lines.push(`│  ... (共${contentLines.length}行，已截断)`)
            }
          } else {
            for (const li of nameLineIndices.slice(0, 8)) {
              let start = Math.max(0, li - 1)
              let end = Math.min(contentLines.length, li + 2)
              for (let cl = start; cl < end; cl++) {
                const line = contentLines[cl].replace(/\r$/, '')
                if (line.includes(name)) {
                  lines.push(`│  ▸ ${line}`)
                } else {
                  lines.push(`│    ${line}`)
                }
              }
              if (nameLineIndices.indexOf(li) < Math.min(7, nameLineIndices.length - 1)) {
                lines.push(`│  ···`)
              }
            }
            if (nameLineIndices.length > 8) {
              lines.push(`│  ... (还有${nameLineIndices.length - 8}处出现，已截断)`)
            }
          }

          lines.push(`└${'─'.repeat(49)}`)
          lines.push('')

          estimatedChars += hit.chunkContent.length
          if (estimatedChars > MAX_OUTPUT_CHARS && i < allHits.length - 1) {
            truncated = true
            lines.push(`⚠ 已达到输出上限（约${MAX_OUTPUT_CHARS}字符），省略剩余 ${allHits.length - i - 1} 个chunk。`)
            lines.push(`   这些chunk统计: ${allHits.slice(i + 1).reduce((s, h) => s + h.chunkContent.length, 0)} 字符`)
            lines.push('')
            break
          }
        }

        if (!truncated) {
          const totalChars = allHits.reduce((sum, h) => sum + h.chunkContent.length, 0)
          lines.push('─'.repeat(50))
          lines.push(`统计: 共 ${allHits.length} 个chunk，总计约 ${totalChars} 字符`)
          lines.push('')
        }

        lines.push(`${'═'.repeat(50)}`)
        lines.push(`📋 人物关系分析任务 — 请基于以上原文执行：`)
        lines.push(`${'═'.repeat(50)}`)
        lines.push('')
        lines.push(`你是文学分析专家。请基于以上「${name}」的全部原文出现记录，完成以下分析：`)
        lines.push('')
        lines.push('1. 【明确关系】列出原文中明确写出的关系（如「X是Y的父亲」「X和Y结为道侣」），')
        lines.push('   标注关系类型和出现的chunk编号。没有明确写出的关系就说「无」。')
        lines.push('')
        lines.push('2. 【推断关系】从多个chunk的互动模式中推断可能的关系。')
        lines.push('   例如：在多处出现牵手/脸红/深夜独处 → 可推断「疑似情侣/暧昧关系」')
        lines.push('   推断必须标注「推断」字样，并列出支持该推断的chunk编号和具体原文内容')
        lines.push('   参考上文的关系关键词线索和共现片段')
        lines.push('')
        lines.push('3. 【关系变化】如果角色关系在文中经历了变化，描述变化轨迹')
        lines.push('')
        lines.push('4. 【关系图谱】以「${name}」为中心，列出其关联的所有角色及关系类型')
        lines.push('')
        lines.push('重要规则：')
        lines.push('- 明确关系 = 原文直接写了 → 标注为「事实」')
        lines.push('- 推断关系 = 多个片段有模式 → 标注为「推断」+ 列出证据')
        lines.push('- 禁止凭空编造没有原文依据的人物、事件、关系名称')
        lines.push('- 如果信息不足以判断关系，说「原文信息不足，无法判断」')

        return lines.join('\n')
      }
    })
  }

  registerTool(tool: Tool): void {
    this.tools.set(tool.name, tool)
  }

  getDescription(name: string): string {
    return this.tools.get(name)?.description ?? '未知工具'
  }

  async execute(name: string, input: string): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name)
    if (!tool) return toolFail(`未知工具: ${name}`)
    try {
      return normalizeToolResult(await tool.execute(input))
    } catch (err) {
      return toolFail(`工具执行失败: ${(err as Error).message}`)
    }
  }
}

export function toolOk(message: string, data?: unknown, uiEffects?: AppUIEffect[]): ToolExecutionResult {
  return { ok: true, message, data, uiEffects }
}

export function toolFail(message: string, data?: unknown): ToolExecutionResult {
  return { ok: false, message, data }
}

function normalizeToolResult(result: string | ToolExecutionResult): ToolExecutionResult {
  if (typeof result !== 'string') return result
  return {
    ok: !looksLikeFailureMessage(result),
    message: result
  }
}

function looksLikeFailureMessage(message: string): boolean {
  return /^(格式错误|未知工具|工具执行失败|正文质量检查未通过|章节标题和正文不能为空|标题和内容不能为空|已拦截|未找到章节|Chapter does not belong)/.test(message)
}

export function parseOutlineToolType(input: string): OutlineType | null {
  const match = input.match(/type:\s*([^\n\r]+)/)
  if (!match) return null
  const type = match[1].trim().toLowerCase()
  if (['outline', '大纲', '故事大纲', '总体大纲', '整体大纲', '卷纲'].includes(type)) return 'outline'
  if (['detailed', 'detail', '细纲', '章节细纲', '分章细纲', '分场细纲', '章节规划'].includes(type)) return 'detailed'
  return null
}

function extractSnippet(text: string, query: string, context: number = 60): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return ''
  const start = Math.max(0, idx - context)
  const end = Math.min(text.length, idx + query.length + context)
  return text.slice(start, end)
}

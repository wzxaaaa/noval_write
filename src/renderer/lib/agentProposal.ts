import { normalizeChapterTitle, plainTextToHtml } from '../../shared/chapterFormat'

export const AGENT_CHAPTER_PROPOSAL_EVENT = 'noval:agent-chapter-proposal'

export interface AgentChapterProposalDetail {
  chapterId: string
  html: string
  sourceName: string
  oldHtml?: string
}

export interface AgentDraft {
  title: string
  content: string
}

let pendingChapterProposal: AgentChapterProposalDetail | null = null

export function emitAgentChapterProposal(detail: AgentChapterProposalDetail): void {
  pendingChapterProposal = detail
  window.dispatchEvent(new CustomEvent<AgentChapterProposalDetail>(AGENT_CHAPTER_PROPOSAL_EVENT, { detail }))
}

export function takePendingAgentChapterProposal(chapterId: string | null): AgentChapterProposalDetail | null {
  if (!chapterId || pendingChapterProposal?.chapterId !== chapterId) return null

  const proposal = pendingChapterProposal
  pendingChapterProposal = null
  return proposal
}

export function extractAgentDrafts(text: string): AgentDraft[] {
  const cleaned = normalizeAgentOutput(text)
  if (!cleaned) return []

  const chapterDrafts = splitChapterDrafts(cleaned)
  if (chapterDrafts.length > 0) return chapterDrafts

  const section = extractExplicitBodySection(cleaned)
  if (section && looksLikeNovelBody(section.content)) return [section]

  if (looksLikeNovelBody(cleaned)) {
    return [{ title: inferTitle(cleaned), content: cleaned }]
  }

  return []
}

export function agentOutputToHtml(text: string): string {
  return plainTextToHtml(text)
}

function normalizeAgentOutput(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\[WORKFLOW_COMPLETE\]/g, '')
    .replace(/\[\s*TOOL\s*:[\s\S]*?\[\s*\/\s*TOOL\s*\]/gi, '')
    .replace(/```(?:markdown|md|text|html)?\n([\s\S]*?)```/gi, '$1')
    .trim()
}

function splitChapterDrafts(text: string): AgentDraft[] {
  const lines = text.split('\n')
  const starts: Array<{ index: number; title: string }> = []

  lines.forEach((line, index) => {
    const title = normalizeTitleLine(line)
    if (/^第[一二三四五六七八九十百千万\d]+[章节回幕卷]/.test(title)) {
      starts.push({ index, title })
    }
  })

  if (starts.length === 0) return []

  return starts
    .map((start, index) => {
      const end = starts[index + 1]?.index ?? lines.length
      const content = lines.slice(start.index, end).join('\n').trim()
      return { title: start.title, content }
    })
    .filter(draft => looksLikeNovelBody(draft.content))
}

function extractExplicitBodySection(text: string): AgentDraft | null {
  const lines = text.split('\n')
  const startIndex = lines.findIndex(line => {
    const normalized = normalizeTitleLine(line)
    return /^(正文|正文定稿|最终正文|小说正文|章节正文|成稿|正文稿|最终稿|交付正文)[:：]?$/.test(normalized)
  })

  if (startIndex < 0) return null

  const bodyLines: string[] = []
  for (const line of lines.slice(startIndex + 1)) {
    const normalized = normalizeTitleLine(line)
    if (bodyLines.length > 0 && /^(正文|正文定稿|最终正文|小说正文|章节正文|成稿|正文稿|最终稿|交付正文)[:：]?$/.test(normalized)) {
      break
    }
    if (/^(校验|核验|总结|工作总结|交付说明|最终交付|备注|大纲|提纲|修改说明|审稿意见|字数校验|结构校验|人物校验|设定校验)/.test(normalized)) {
      break
    }
    bodyLines.push(line)
  }

  const content = bodyLines.join('\n').trim()
  if (!content) return null
  return { title: inferTitle(content), content }
}

function looksLikeNovelBody(text: string): boolean {
  if (looksLikeOutlinePlan(text)) return false
  if (!passesDraftQuality(text)) return false

  const compact = stripMarkdownNoise(text)
  if (compact.length < 50) return false

  const metaLineCount = text.split('\n').filter(line => {
    const normalized = normalizeTitleLine(line)
    return /校验|核验|总结|工作流|任务|完成|交付|无需|可以直接|字数|结构|设定|人物|伏笔/.test(normalized)
  }).length
  const lineCount = Math.max(1, text.split('\n').filter(line => line.trim()).length)
  if (metaLineCount / lineCount > 0.35) return false

  return /[。！？“”]/.test(compact) || /^第[一二三四五六七八九十百千万\d]+[章节回幕卷]/.test(normalizeTitleLine(text.split('\n')[0] ?? ''))
}

function looksLikeOutlinePlan(text: string): boolean {
  const lines = text.split('\n').map(normalizeTitleLine).filter(Boolean)
  if (lines.length === 0) return false

  const outlineWordHits = lines.filter(line =>
    /大纲|细纲|纲要|提纲|卷纲|分卷|分章|章节规划|章节拆解|故事梗概|剧情梗概|总体结构|整体结构|主线结构|核心设定|总篇幅|总字数|章数目标|每章|六卷结构|三幕结构/.test(line)
  ).length
  const structuralLineHits = lines.filter(line =>
    /^[-*•]/.test(line) ||
    /^第[一二三四五六七八九十百千万\d]+卷/.test(line) ||
    /[（(]\s*\d+\s*-\s*\d+\s*章\s*[)）]/.test(line) ||
    /\d+\s*-\s*\d+\s*章/.test(line)
  ).length

  if (outlineWordHits >= 2 && structuralLineHits >= 2) return true
  if (outlineWordHits / lines.length > 0.35 && structuralLineHits >= 1) return true

  const compact = lines.join('')
  return /大纲已保存|自动打开大纲面板|完整.{0,8}(六卷结构|三幕结构|整体结构|总体结构)|总篇幅.{0,20}每章/.test(compact)
}

function stripMarkdownNoise(text: string): string {
  return text
    .replace(/[#*_`>\-\s\d.、，,：:；;]/g, '')
    .trim()
}

function normalizeTitleLine(line: string): string {
  return line.trim().replace(/^#{1,6}\s*/, '').replace(/^\*\*|\*\*$/g, '').trim()
}

function inferTitle(text: string): string {
  const firstLine = text.split('\n').map(normalizeTitleLine).find(Boolean)
  return normalizeChapterTitle(firstLine ?? '', 'AI 生成章节')
}

function passesDraftQuality(text: string): boolean {
  const plain = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
  const cjkCount = countMatches(plain, /[\u3400-\u9fff]/g)
  if (cjkCount < 100) return true

  const punctuationCount = countMatches(plain, /[，。！？；：、,.!?;:…—]/g)
  const punctuationDensity = punctuationCount / Math.max(1, cjkCount)
  const runs = plain
    .split(/[，。！？；：、,.!?;:…—\-\n\r\t\s"“”'‘’（）()《》<>【】\[\]]+/)
    .map(segment => countMatches(segment, /[\u3400-\u9fff]/g))
    .filter(count => count > 0)
  const longestRun = runs.length > 0 ? Math.max(...runs) : 0
  const longRunCount = runs.filter(count => count >= 36).length

  if (longestRun >= 52) return false
  if (longRunCount >= 3) return false
  if (punctuationDensity < 0.018 && longestRun >= 32) return false
  if (hasTextDegeneration(plain)) return false

  return true
}

function hasTextDegeneration(text: string): boolean {
  const compact = text.replace(/\s+/g, '').slice(-8000)
  if (/(.)\1{17,}/u.test(compact)) return true

  const cjkText = compact.replace(/[^\u3400-\u9fffA-Za-z0-9]/g, '')
  for (let size = 2; size <= 32; size++) {
    let index = 0
    while (index + size * 4 <= cjkText.length) {
      const phrase = cjkText.slice(index, index + size)
      if (/^(.)(\1)+$/u.test(phrase)) {
        index++
        continue
      }

      let count = 1
      let cursor = index + size
      while (cjkText.slice(cursor, cursor + size) === phrase) {
        count++
        cursor += size
      }

      const threshold = size <= 4 ? 8 : size <= 12 ? 5 : 3
      if (count >= threshold) return true
      index += Math.max(1, count * size)
    }
  }

  return false
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0
}

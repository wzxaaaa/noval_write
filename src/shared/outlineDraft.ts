export type OutlineDraftType = 'outline' | 'detailed'

export interface ExtractedOutlineDraft {
  type: OutlineDraftType
  title: string
  content: string
}

interface OutlineMarker {
  lineIndex: number
  type: OutlineDraftType
  title: string
  inlineContent: string
}

const OUTLINE_WORDS = /(大纲|故事梗概|剧情梗概|总体结构|整体结构|主线结构|卷纲)/
const DETAILED_WORDS = /(细纲|章节细纲|分章|章节拆解|章节规划|分场|场景细纲)/

export function extractOutlineDrafts(input: string | null | undefined, fallbackTitle = 'AI 生成'): ExtractedOutlineDraft[] {
  const cleaned = stripCodeFences(input || '')
  const lines = cleaned.split('\n')
  const markers = lines
    .map((line, lineIndex) => parseMarker(line, lineIndex, fallbackTitle))
    .filter((marker): marker is OutlineMarker => marker !== null)

  if (markers.length === 0) {
    return inferSingleDraft(cleaned, fallbackTitle)
  }

  return markers
    .map((marker, index) => {
      const nextMarker = markers[index + 1]
      const bodyLines = lines.slice(marker.lineIndex + 1, nextMarker?.lineIndex)
      const content = cleanOutlineContent([marker.inlineContent, ...bodyLines].join('\n'))
      return {
        type: marker.type,
        title: marker.title,
        content
      }
    })
    .filter(draft => draft.content.length > 0)
}

export function isOutlinePlacementInstruction(input: string | null | undefined): boolean {
  const text = (input || '').replace(/\s+/g, '')
  if (!text) return false

  return /(放到|放入|放进|写入|存到|保存到|加入|嵌入|归入)/.test(text) && /(大纲|细纲|结构)/.test(text)
}

export function summarizeOutlineDraftTypes(drafts: ExtractedOutlineDraft[]): string {
  const hasOutline = drafts.some(draft => draft.type === 'outline')
  const hasDetailed = drafts.some(draft => draft.type === 'detailed')

  if (hasOutline && hasDetailed) return '大纲/细纲'
  if (hasDetailed) return '细纲'
  return '大纲'
}

function parseMarker(line: string, lineIndex: number, fallbackTitle: string): OutlineMarker | null {
  if (!isLikelyHeading(line)) return null

  const { heading, inlineContent } = splitHeadingAndInline(line)
  const type = classifyHeading(heading)
  if (!type) return null

  return {
    lineIndex,
    type,
    title: buildDraftTitle(heading, type, fallbackTitle),
    inlineContent
  }
}

function isLikelyHeading(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed || trimmed.length > 110) return false

  const headingText = stripMarkdown(trimmed)
  const hasOutlineWord = OUTLINE_WORDS.test(headingText) || DETAILED_WORDS.test(headingText)
  if (!hasOutlineWord) return false

  const labelPrefix = new RegExp(`^[#*\\-\\s]*[^：:]{0,48}(${OUTLINE_WORDS.source}|${DETAILED_WORDS.source})[^：:]{0,24}[：:]`).test(trimmed.replace(/\*\*/g, ''))

  return (
    labelPrefix ||
    /^#{1,6}\s+/.test(trimmed) ||
    /^[-*]\s+/.test(trimmed) ||
    /^\*\*.+\*\*[:：]?$/.test(trimmed) ||
    /^[一二三四五六七八九十\d]+[、.．]\s*/.test(trimmed) ||
    /[:：]\s*$/.test(trimmed) ||
    headingText.length <= 48
  )
}

function classifyHeading(heading: string): OutlineDraftType | null {
  const hasOutline = OUTLINE_WORDS.test(heading)
  const hasDetailed = DETAILED_WORDS.test(heading)

  if (hasOutline && hasDetailed && /大纲\s*[/／、和+]\s*细纲/.test(heading)) return null
  if (hasOutline && hasDetailed && /大纲.{0,8}(细纲|分章|章节)/.test(heading)) return null
  if (hasDetailed) return 'detailed'
  if (hasOutline) return 'outline'
  return null
}

function splitHeadingAndInline(line: string): { heading: string; inlineContent: string } {
  const normalized = stripMarkdown(line)
  const colonIndex = normalized.search(/[：:]/)

  if (colonIndex > -1 && colonIndex <= 48) {
    return {
      heading: normalized.slice(0, colonIndex).trim(),
      inlineContent: normalized.slice(colonIndex + 1).trim()
    }
  }

  return {
    heading: normalized.trim(),
    inlineContent: ''
  }
}

function buildDraftTitle(heading: string, type: OutlineDraftType, fallbackTitle: string): string {
  const cleaned = heading
    .replace(/^(以下是|下面是|这里是|为您整理的|为你整理的)/, '')
    .replace(/[：:]\s*$/, '')
    .trim()

  if (cleaned && !/^(大纲|故事大纲|细纲|章节细纲|分章细纲)$/.test(cleaned)) return cleaned.slice(0, 80)

  return `${fallbackTitle || 'AI 生成'} · ${type === 'outline' ? '大纲' : '细纲'}`
}

function inferSingleDraft(input: string, fallbackTitle: string): ExtractedOutlineDraft[] {
  const content = cleanOutlineContent(input)
  if (content.length < 40) return []

  const plain = stripMarkdown(content)
  const hasDetailed = DETAILED_WORDS.test(plain) || /第[一二三四五六七八九十\d]+章/.test(plain)
  const hasOutline = OUTLINE_WORDS.test(plain)

  if (hasDetailed && !hasOutline) {
    return [{
      type: 'detailed',
      title: `${fallbackTitle || 'AI 生成'} · 细纲`,
      content
    }]
  }

  if (hasOutline && !hasDetailed) {
    return [{
      type: 'outline',
      title: `${fallbackTitle || 'AI 生成'} · 大纲`,
      content
    }]
  }

  return []
}

function cleanOutlineContent(input: string): string {
  return stripCodeFences(input)
    .replace(/^\s*[-=]{3,}\s*$/gm, '')
    .replace(/^\s*(以下是|下面是|这里是).{0,40}(大纲|细纲|结构).{0,20}$/gm, '')
    .trim()
}

function stripCodeFences(input: string): string {
  return input
    .replace(/\r\n/g, '\n')
    .replace(/```(?:markdown|md|text)?\s*([\s\S]*?)```/gi, '$1')
}

function stripMarkdown(input: string): string {
  return input
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/^[一二三四五六七八九十\d]+[、.．]\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .trim()
}

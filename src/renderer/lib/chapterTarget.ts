import type { ChapterData } from '../../preload/types'

interface ChapterReference {
  raw: string
  ordinal: number | null
  index: number
}

const CHINESE_DIGITS: Record<string, number> = {
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

export function resolveTargetChapter(
  chapters: ChapterData[],
  instruction: string,
  fallbackChapterId: string | null
): ChapterData | null {
  const ordered = chapters.slice().sort(compareChapterOrder)
  if (ordered.length === 0) return null

  const references = extractChapterReferences(instruction)
  for (const reference of references.slice().reverse()) {
    const byTitle = findChapterByTitleReference(ordered, reference.raw)
    if (byTitle) return byTitle

    if (reference.ordinal && reference.ordinal > 0) {
      const byOrdinal = ordered[reference.ordinal - 1]
      if (byOrdinal) return byOrdinal
    }
  }

  return ordered.find(chapter => chapter.id === fallbackChapterId) ?? null
}

export function extractChapterReferences(text: string): ChapterReference[] {
  const references: ChapterReference[] = []
  const patterns = [
    /第\s*([零〇一二两三四五六七八九十百千万\d]+)\s*[章节回幕卷]/g,
    /(?:^|[，。！？、\s])([零〇一二两三四五六七八九十百千万\d]+)\s*章/g
  ]

  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      const raw = match[0].trim().replace(/^[，。！？、\s]+/, '')
      const numberPart = match[1]
      references.push({
        raw,
        ordinal: parseChapterNumber(numberPart),
        index: match.index
      })
    }
  }

  return dedupeReferences(references).sort((a, b) => a.index - b.index)
}

export function parseChapterNumber(value: string): number | null {
  const cleaned = value.trim()
  if (!cleaned) return null
  if (/^\d+$/.test(cleaned)) return Number(cleaned)

  let total = 0
  let section = 0
  let current = 0

  for (const char of cleaned) {
    const digit = CHINESE_DIGITS[char]
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

function findChapterByTitleReference(chapters: ChapterData[], rawReference: string): ChapterData | null {
  const normalizedReference = normalizeComparable(rawReference)
  if (!normalizedReference) return null

  return chapters.find(chapter => normalizeComparable(chapter.title).includes(normalizedReference)) ?? null
}

function dedupeReferences(references: ChapterReference[]): ChapterReference[] {
  const seen = new Set<string>()
  return references.filter(reference => {
    const key = `${reference.raw}:${reference.index}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function compareChapterOrder(a: ChapterData, b: ChapterData): number {
  return a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at)
}

function normalizeComparable(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase()
}

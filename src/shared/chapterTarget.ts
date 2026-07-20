export type ChapterWriteTarget =
  | { kind: 'current' }
  | { kind: 'next' }
  | { kind: 'ordinal'; index: number }
  | { kind: 'unspecified' }

export const CHAPTER_WORDS_MIN = 300
export const CHAPTER_WORDS_MAX = 20000
export const CHAPTER_WORDS_DEFAULT = 3500
/** 交付正文相对目标字数的下限比例（低于视为篇幅不足）。 */
export const CHAPTER_MIN_RATIO = 0.45
/** 交付正文相对目标字数的上限比例（高于触发压缩重写）。 */
export const CHAPTER_MAX_RATIO = 1.35

/**
 * 归一化用户/项目配置的每章目标字数。非法或非正数返回 null（表示"用默认值"），
 * 合法值夹到 [CHAPTER_WORDS_MIN, CHAPTER_WORDS_MAX]。
 */
export function clampChapterWordTarget(value: unknown): number | null {
  const raw = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN
  if (!Number.isFinite(raw) || raw <= 0) return null
  return Math.min(CHAPTER_WORDS_MAX, Math.max(CHAPTER_WORDS_MIN, Math.floor(raw)))
}

/** 由目标字数推导交付正文的字符预算区间。 */
export function chapterCharBudget(targetWords: number): { min: number; max: number } {
  const target = Number.isFinite(targetWords) && targetWords > 0 ? Math.floor(targetWords) : CHAPTER_WORDS_DEFAULT
  return {
    min: Math.max(80, Math.floor(target * CHAPTER_MIN_RATIO)),
    max: Math.ceil(target * CHAPTER_MAX_RATIO)
  }
}

interface TargetCandidate {
  kind: Exclude<ChapterWriteTarget['kind'], 'unspecified'>
  index?: number
  start: number
  end: number
  score: number
}

const TARGET_MENTION_PATTERN = /当前章节|当前章|这一章|本章|下一个章节|下一章节|下一章|下章|新章节|新章|第([零〇一二两三四五六七八九十百千万\d]+)[章节回幕卷]/g
const TARGET_VERB_PATTERN = /直接保存|写入|保存|润色|修改|修订|重写|改写|替换|调整|优化|续写|补写|扩写|完成|处理|精简|简化|删改|更新|生成|创作|创建|新建|打开|切换|选择|读取|定位|重命名|改|写|加|删/g
const REFERENCE_PATTERN = /作为参考|用作参考|参考|参照|承接|衔接|呼应|根据|基于|延续|沿用|来自|提及|提到|回顾|对照/g
const NEGATION_PATTERN = /不需要|不允许|不要|不用|不必|无需|禁止|不能|不可|请勿|别/g
const CLAUSE_BOUNDARY_PATTERN = /[，。；;！？!?：:\n]/g

/**
 * Identify the chapter that a write/control instruction acts on. Mentions used
 * only as references (for example, "承接第三章") must not become write targets.
 */
export function classifyChapterWriteTarget(text: string): ChapterWriteTarget {
  const compact = text.toLowerCase().replace(/\s+/g, '')
  const candidates = collectCandidates(compact)
  if (candidates.length === 0) return { kind: 'unspecified' }

  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
    const candidate = candidates[candidateIndex]
    const previous = candidates[candidateIndex - 1]
    const next = candidates[candidateIndex + 1]
    const leftBoundary = Math.max(
      previous?.end ?? 0,
      findLastClauseBoundary(compact, candidate.start)
    )
    const rightBoundary = Math.min(
      next?.start ?? compact.length,
      findNextClauseBoundary(compact, candidate.end)
    )
    const before = compact.slice(leftBoundary, candidate.start)
    const after = compact.slice(candidate.end, rightBoundary)
    candidate.score = scoreCandidate(candidate, before, after)
  }

  const winner = candidates.reduce<TargetCandidate | null>((best, candidate) => {
    if (candidate.score <= 0) return best
    if (!best || candidate.score >= best.score) return candidate
    return best
  }, null)

  if (!winner) return { kind: 'unspecified' }
  if (winner.kind === 'ordinal' && winner.index) {
    return { kind: 'ordinal', index: winner.index }
  }
  if (winner.kind === 'current') return { kind: 'current' }
  if (winner.kind === 'next') return { kind: 'next' }
  return { kind: 'unspecified' }
}

function collectCandidates(text: string): TargetCandidate[] {
  const candidates: TargetCandidate[] = []
  for (const match of text.matchAll(TARGET_MENTION_PATTERN)) {
    const mention = match[0]
    let kind: TargetCandidate['kind']
    let index: number | undefined
    if (/^(当前章节|当前章|这一章|本章)$/.test(mention)) {
      kind = 'current'
    } else if (/^(下一个章节|下一章节|下一章|下章|新章节|新章)$/.test(mention)) {
      kind = 'next'
    } else {
      const parsed = parseChapterNumber(match[1] ?? '')
      if (!parsed) continue
      kind = 'ordinal'
      index = parsed
    }
    candidates.push({
      kind,
      index,
      start: match.index ?? 0,
      end: (match.index ?? 0) + mention.length,
      score: 0
    })
  }
  return candidates
}

function scoreCandidate(candidate: TargetCandidate, before: string, after: string): number {
  const targetDistance = Math.min(
    closestBeforeDistance(before, TARGET_VERB_PATTERN),
    closestAfterDistance(after, TARGET_VERB_PATTERN)
  )
  const referenceDistance = Math.min(
    closestBeforeDistance(before, REFERENCE_PATTERN),
    closestAfterDistance(after, REFERENCE_PATTERN)
  )
  const negated = isNegatedTarget(before) || isNegatedTarget(after, true)

  if (negated) return -20
  if (referenceDistance < targetDistance) return -10
  if (Number.isFinite(targetDistance)) return 20 - Math.min(targetDistance, 10)

  if (candidate.kind === 'ordinal' && /^(?:的)?(?:结尾|开头|内容|伏笔|风格|设定|情节|剧情|线索)/.test(after)) {
    return -5
  }
  return 1
}

function closestBeforeDistance(value: string, pattern: RegExp): number {
  let distance = Number.POSITIVE_INFINITY
  for (const match of value.matchAll(cloneGlobal(pattern))) {
    distance = Math.min(distance, value.length - ((match.index ?? 0) + match[0].length))
  }
  return distance
}

function closestAfterDistance(value: string, pattern: RegExp): number {
  const match = cloneGlobal(pattern).exec(value)
  return match ? match.index : Number.POSITIVE_INFINITY
}

function isNegatedTarget(value: string, fromStart = false): boolean {
  const targetMatches = Array.from(value.matchAll(cloneGlobal(TARGET_VERB_PATTERN)))
  const negationMatches = Array.from(value.matchAll(cloneGlobal(NEGATION_PATTERN)))
  if (targetMatches.length === 0) {
    if (fromStart) return negationMatches.some(match => (match.index ?? 0) <= 3)
    return negationMatches.some(match => value.length - ((match.index ?? 0) + match[0].length) <= 3)
  }

  const target = fromStart ? targetMatches[0] : targetMatches[targetMatches.length - 1]
  const targetStart = target.index ?? 0
  return negationMatches.some(match => {
    const negationEnd = (match.index ?? 0) + match[0].length
    return negationEnd <= targetStart && targetStart - negationEnd <= 4
  })
}

function findLastClauseBoundary(text: string, beforeIndex: number): number {
  let boundary = 0
  for (const match of text.slice(0, beforeIndex).matchAll(cloneGlobal(CLAUSE_BOUNDARY_PATTERN))) {
    boundary = (match.index ?? 0) + match[0].length
  }
  return boundary
}

function findNextClauseBoundary(text: string, afterIndex: number): number {
  const match = cloneGlobal(CLAUSE_BOUNDARY_PATTERN).exec(text.slice(afterIndex))
  return match ? afterIndex + match.index : text.length
}

function cloneGlobal(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
}

function parseChapterNumber(value: string): number | null {
  if (/^\d+$/.test(value)) {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }

  const digits: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
    五: 5, 六: 6, 七: 7, 八: 8, 九: 9
  }
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }
  let total = 0
  let section = 0
  let number = 0
  for (const char of value) {
    if (digits[char] !== undefined) {
      number = digits[char]
    } else if (units[char] !== undefined) {
      section += (number || 1) * units[char]
      number = 0
    } else if (char === '万') {
      total += (section + number) * 10000
      section = 0
      number = 0
    } else {
      return null
    }
  }
  const parsed = total + section + number
  return parsed > 0 ? parsed : null
}

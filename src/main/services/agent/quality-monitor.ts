import type { ToolCall } from './agent-runtime'
import { estimateTokenCount } from '../../../shared/textMetrics'

export interface QualityAssessment {
  hallucinationRisk: 'low' | 'medium' | 'high'
  issues: string[]
  tokenCount: number
}

export interface ChinesePunctuationInspection {
  ok: boolean
  cjkCount: number
  punctuationCount: number
  punctuationDensity: number
  longestRun: number
  longRunCount: number
  reason?: string
}

export interface TextDegenerationInspection {
  ok: boolean
  reason?: string
  repeatedCharRun: number
  repeatedPhrase?: string
  repeatedPhraseCount: number
}

export interface AiFlavorInspection {
  ok: boolean
  score: number
  issues: string[]
  samples: string[]
}

export function assessAgentOutput(content: string, toolCalls: ToolCall[], contextRatio: number = 0): QualityAssessment {
  const issues: string[] = []
  const chapterWriteCalls = toolCalls.filter(tc => tc.tool === 'create_chapter' || tc.tool === 'write_chapter')
  const hasChapterWrite = chapterWriteCalls.some(tc => tc.ok !== false)
  const failedChapterWrites = chapterWriteCalls.filter(tc => tc.ok === false)

  if (contextRatio >= 0.85) {
    issues.push('上下文使用率过高，模型更容易丢失早期设定')
  }

  if (!hasChapterWrite && /已(创建|写入|保存|交付).{0,12}章/.test(content)) {
    issues.push('输出声称章节已创建或写入，但没有对应章节工具调用')
  }

  if (failedChapterWrites.length > 0) {
    issues.push(`章节工具调用失败: ${failedChapterWrites.map(call => call.output).join('；')}`)
  }

  if (/字数校验|结构校验|工作总结|最终交付|无需二次编辑/.test(content) && !/第[一二三四五六七八九十百千万\d]+[章节回幕卷]/.test(content)) {
    issues.push('输出更像工作总结而不是章节正文')
  }

  const punctuation = inspectChinesePunctuation(content)
  if (!punctuation.ok && looksLikeChapterDraft(content)) {
    issues.push(`中文标点密度异常: ${punctuation.reason}`)
  }

  const degeneration = inspectTextDegeneration(content)
  if (!degeneration.ok) {
    issues.push(`输出重复退化: ${degeneration.reason}`)
  }

  if (looksLikeChapterDraft(content)) {
    const flavor = inspectAiFlavor(content)
    if (!flavor.ok) {
      issues.push(`AI 腔偏重(评分 ${flavor.score}): ${flavor.issues.join('；')}`)
    }
  }

  const risk = issues.some(issue => issue.includes('没有对应') || issue.includes('工作总结') || issue.includes('失败'))
    ? 'high'
    : issues.length > 0
      ? 'medium'
      : 'low'

  return {
    hallucinationRisk: risk,
    issues,
    tokenCount: estimateTokenCount(content)
  }
}

export function validateChapterDraft(content: string): { ok: boolean; reason?: string } {
  const trimmed = content.trim()
  if (trimmed.length < 80) {
    return { ok: false, reason: '章节正文过短，疑似不是完整正文' }
  }

  const lines = trimmed.split('\n').filter(line => line.trim())
  const metaLines = lines.filter(line => /字数校验|结构校验|工作总结|最终交付|无需二次编辑|任务完成|审核通过/.test(line))
  if (metaLines.length / Math.max(1, lines.length) > 0.3) {
    return { ok: false, reason: '正文中包含过多流程/审核说明，未通过正文质量检查' }
  }

  const punctuation = inspectChinesePunctuation(trimmed)
  if (!punctuation.ok) {
    return { ok: false, reason: punctuation.reason }
  }

  const degeneration = inspectTextDegeneration(trimmed)
  if (!degeneration.ok) {
    return { ok: false, reason: degeneration.reason }
  }

  return { ok: true }
}

export function inspectChinesePunctuation(content: string): ChinesePunctuationInspection {
  const plain = content
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
  const cjkCount = countMatches(plain, /[\u3400-\u9fff]/g)
  const punctuationCount = countMatches(plain, /[，。！？；：、,.!?;:…—]/g)
  const punctuationDensity = cjkCount > 0 ? punctuationCount / cjkCount : 1
  const runs = plain
    .split(/[，。！？；：、,.!?;:…—\-\n\r\t\s"“”'‘’（）()《》<>【】\[\]]+/)
    .map(segment => countMatches(segment, /[\u3400-\u9fff]/g))
    .filter(count => count > 0)
  const longestRun = runs.length > 0 ? Math.max(...runs) : 0
  const longRunCount = runs.filter(count => count >= 36).length

  if (cjkCount < 100) {
    return { ok: true, cjkCount, punctuationCount, punctuationDensity, longestRun, longRunCount }
  }

  if (longestRun >= 52) {
    return {
      ok: false,
      cjkCount,
      punctuationCount,
      punctuationDensity,
      longestRun,
      longRunCount,
      reason: `存在连续 ${longestRun} 个汉字没有停顿标点，疑似漏标点`
    }
  }

  if (longRunCount >= 3) {
    return {
      ok: false,
      cjkCount,
      punctuationCount,
      punctuationDensity,
      longestRun,
      longRunCount,
      reason: `有 ${longRunCount} 处连续 36 个以上汉字没有停顿标点，阅读节奏过硬`
    }
  }

  if (punctuationDensity < 0.018 && longestRun >= 32) {
    return {
      ok: false,
      cjkCount,
      punctuationCount,
      punctuationDensity,
      longestRun,
      longRunCount,
      reason: '中文标点过少，正文读起来像未完成润色稿'
    }
  }

  return { ok: true, cjkCount, punctuationCount, punctuationDensity, longestRun, longRunCount }
}

export function inspectTextDegeneration(content: string): TextDegenerationInspection {
  const plain = content
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, '')
  const tail = plain.slice(-8000)
  const repeatedCharRun = getLongestRepeatedCharRun(tail)

  if (repeatedCharRun >= 18) {
    return {
      ok: false,
      repeatedCharRun,
      repeatedPhraseCount: 0,
      reason: `存在连续 ${repeatedCharRun} 个相同字符，疑似模型复读`
    }
  }

  const repeatedPhrase = findRepeatedPhrase(tail)
  if (repeatedPhrase) {
    return {
      ok: false,
      repeatedCharRun,
      repeatedPhrase: repeatedPhrase.phrase,
      repeatedPhraseCount: repeatedPhrase.count,
      reason: `短语「${repeatedPhrase.phrase.slice(0, 20)}」连续重复 ${repeatedPhrase.count} 次，疑似模型循环`
    }
  }

  return { ok: true, repeatedCharRun, repeatedPhraseCount: 0 }
}

const CLICHE_METAPHORS = [
  '深海巨兽', '洪水猛兽', '困兽', '野兽般', '巨兽', '冰冷的眼', '手术刀', '教科书般',
  '像一把', '如同一把', '仿佛整个世界', '空气仿佛凝固', '时间仿佛静止', '时间仿佛凝固',
  '像被按下了暂停键', '暴风雨前的宁静', '深渊', '棋子', '猎物'
]

const ABSTRACT_FILLERS = [
  '说不出的', '难以名状', '无法形容', '莫名的', '某种莫名', '让人发毛', '让人头皮发麻',
  '拒人于千里', '一种难以', '一股说不清', '五味杂陈', '心情复杂', '百感交集', '不容置疑的'
]

const PSEUDO_METRIC_CONTEXT = /(指数|权重|置信度|概率|准确率|负荷|可信度|评分|阈值|饱和度|匹配度|相似度)/

/**
 * 确定性扫描一段正文里的“AI 腔”高发特征，返回评分和可疑片段。
 * 只作为软信号使用：进入质量提示、喂给审稿/整合 Agent 驱动重写，
 * 不直接卡住入库，避免误伤导致整章生成失败。
 */
export function inspectAiFlavor(content: string): AiFlavorInspection {
  const plain = content
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
  const cjkCount = countMatches(plain, /[㐀-鿿]/g)
  if (cjkCount < 120) {
    return { ok: true, score: 0, issues: [], samples: [] }
  }

  const issues: string[] = []
  const samples: string[] = []
  let score = 0

  const antithesis = countAntithesis(plain, samples)
  if (antithesis >= 2) {
    issues.push(`否定-肯定对偶警句出现 ${antithesis} 处(如「不是…而是…」「这不是X，这是Y」)，是最典型的 AI 腔，整章此类句式应≤1处`)
    score += antithesis * 2
  }

  const pseudo = countPseudoMetrics(plain, samples)
  if (pseudo >= 3) {
    issues.push(`伪精确数值 ${pseudo} 处(给情绪/状态打小数分或百分比)，读起来像仪表盘而非小说，应改为具体动作和感官`)
    score += pseudo
  }

  const cliche = countPhraseHits(plain, [...CLICHE_METAPHORS, ...ABSTRACT_FILLERS], samples)
  if (cliche >= 2) {
    issues.push(`套路喻体/抽象拔高词 ${cliche} 处(如「深海巨兽/手术刀/说不出的…」)，应换成当前场景里的具体画面`)
    score += cliche
  }

  const fragment = shortFragmentParagraphRatio(plain)
  if (fragment.count >= 4 && fragment.ratio >= 0.18) {
    issues.push(`单句独立成段 ${fragment.count} 处(占段落约 ${Math.round(fragment.ratio * 100)}%)，短句凹节奏过量，整章应≤3处`)
    score += fragment.count
  }

  return { ok: score < 6, score, issues, samples: samples.slice(0, 8) }
}

/** 把 AI 腔检测结果整理成可直接塞进提示词的文字块；无问题时返回空串。 */
export function formatAiFlavorReport(inspection: AiFlavorInspection): string {
  if (inspection.ok || inspection.issues.length === 0) return ''
  const lines = ['【AI 腔自动检测结果 — 以下问题必须在最终稿中消除】']
  inspection.issues.forEach((issue, index) => lines.push(`${index + 1}. ${issue}`))
  if (inspection.samples.length > 0) {
    lines.push(`可疑片段示例：${inspection.samples.map(sample => `「${sample}」`).join('；')}`)
  }
  return lines.join('\n')
}

function countAntithesis(text: string, samples: string[]): number {
  let count = 0
  const inline = /(?:这)?(?:并?不是|不只是|不再是|不仅仅?是|并非)[^，。！？\n]{1,30}[，。！？]\s*(?:而是|这才是|这就是|这正是|这是|才是|是)[^，。！？\n]{1,28}[。！？]/g
  let match: RegExpExecArray | null
  while ((match = inline.exec(text)) !== null) {
    count++
    if (samples.length < 8) samples.push(match[0].trim())
  }

  const paragraphs = text.split(/\n+/).map(segment => segment.trim()).filter(Boolean)
  for (let i = 0; i < paragraphs.length - 1; i++) {
    const first = paragraphs[i]
    const second = paragraphs[i + 1]
    if (
      first.length <= 26 && /^(?:这)?(?:并?不是|不只是|不再是|不仅仅?是|并非)/.test(first) &&
      second.length <= 26 && /^(?:而是|这才是|这就是|这正是|这是|才是)/.test(second)
    ) {
      count++
      if (samples.length < 8) samples.push(`${first} / ${second}`)
    }
  }

  return count
}

function countPseudoMetrics(text: string, samples: string[]): number {
  const decimals = text.match(/-?\d{1,4}\.\d{1,2}%?/g) ?? []
  const percents = text.match(/-?\d{1,3}%/g) ?? []
  const total = decimals.length + percents.length

  if (total > 0 && samples.length < 8) {
    const sentences = text.split(/[。！？\n]/)
    for (const sentence of sentences) {
      if (PSEUDO_METRIC_CONTEXT.test(sentence) && /-?\d+(?:\.\d+)?%?/.test(sentence)) {
        samples.push(sentence.trim().slice(0, 40))
        if (samples.length >= 8) break
      }
    }
  }

  return total
}

function countPhraseHits(text: string, phrases: string[], samples: string[]): number {
  let count = 0
  for (const phrase of phrases) {
    let index = text.indexOf(phrase)
    while (index !== -1) {
      count++
      if (samples.length < 8) {
        const start = Math.max(0, index - 8)
        samples.push(text.slice(start, index + phrase.length + 8).replace(/\s+/g, ''))
      }
      index = text.indexOf(phrase, index + phrase.length)
    }
  }
  return count
}

function shortFragmentParagraphRatio(text: string): { count: number; ratio: number } {
  const paragraphs = text.split(/\n+/).map(segment => segment.trim()).filter(Boolean)
  if (paragraphs.length === 0) return { count: 0, ratio: 0 }

  let short = 0
  for (const paragraph of paragraphs) {
    const cjkLen = countMatches(paragraph, /[㐀-鿿]/g)
    const sentenceCount = paragraph.split(/[。！？]/).filter(segment => segment.trim()).length
    if (cjkLen > 0 && cjkLen <= 8 && sentenceCount <= 1) short++
  }

  return { count: short, ratio: short / paragraphs.length }
}

function looksLikeChapterDraft(content: string): boolean {
  const plain = content.replace(/<[^>]+>/g, '')
  return countMatches(plain, /[\u3400-\u9fff]/g) >= 120 && !/工作总结|结构校验|字数校验/.test(plain)
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0
}

function getLongestRepeatedCharRun(text: string): number {
  let longest = 0
  let current = 0
  let previous = ''

  for (const char of text) {
    if (char === previous) {
      current++
    } else {
      previous = char
      current = 1
    }
    longest = Math.max(longest, current)
  }

  return longest
}

function findRepeatedPhrase(text: string): { phrase: string; count: number } | null {
  const cjkText = text.replace(/[^\u3400-\u9fffA-Za-z0-9]/g, '')
  if (cjkText.length < 80) return null

  for (let size = 2; size <= 32; size++) {
    let index = 0
    while (index + size * 4 <= cjkText.length) {
      const phrase = cjkText.slice(index, index + size)
      if (!isUsefulRepeatedPhrase(phrase)) {
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
      if (count >= threshold) {
        return { phrase, count }
      }

      index += Math.max(1, count * size)
    }
  }

  return null
}

function isUsefulRepeatedPhrase(phrase: string): boolean {
  if (phrase.length < 2) return false
  if (/^(.)(\1)+$/.test(phrase)) return false
  return /[\u3400-\u9fffA-Za-z0-9]/.test(phrase)
}

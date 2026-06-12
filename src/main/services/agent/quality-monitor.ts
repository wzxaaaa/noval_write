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

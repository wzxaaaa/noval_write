import { normalizeChapterContent, plainTextToHtml } from './chapterFormat'
import { htmlToPlainText } from './textMetrics'

export type NovelEditOperationType =
  | 'append_chapter'
  | 'prepend_chapter'
  | 'insert_after_paragraph'
  | 'insert_before_paragraph'
  | 'replace_paragraphs'
  | 'delete_paragraphs'
  | 'rewrite_chapter'

export interface NumberedParagraph {
  id: string
  index: number
  text: string
}

export interface NovelEditOperation {
  type: NovelEditOperationType
  paragraphId?: string
  startParagraphId?: string
  endParagraphId?: string
  text?: string
  reason?: string
}

export interface NovelEditPlan {
  summary: string
  confidence: number
  operations: NovelEditOperation[]
}

export interface PlannedChapterEditRequest {
  providerConfigId: string
  chapterTitle: string
  chapterHtml: string
  assistantContent: string
  userInstruction?: string
  selectedText?: string
}

export interface AppliedNovelOperation extends NovelEditOperation {
  applied: boolean
  fallback?: string
}

export interface PlannedChapterEditResult {
  plan: NovelEditPlan
  proposedText: string
  proposedHtml: string
  summary: string
  appliedOperations: AppliedNovelOperation[]
  warnings: string[]
}

interface ParagraphBlock {
  id: string
  text: string
}

export function getNumberedParagraphs(chapterHtml: string): NumberedParagraph[] {
  const plainText = htmlToPlainText(chapterHtml)
  return splitIntoParagraphs(plainText).map((text, index) => ({
    id: `p${index + 1}`,
    index,
    text
  }))
}

export function buildNumberedChapterText(chapterHtml: string, maxChars = 50000): string {
  const paragraphs = getNumberedParagraphs(chapterHtml)
  const numbered = paragraphs.map(paragraph => `[${paragraph.id}] ${paragraph.text}`).join('\n\n')

  if (numbered.length <= maxChars) return numbered || '(当前章节为空)'

  const head: string[] = []
  const tail: string[] = []
  let headChars = 0
  let tailChars = 0
  const budget = Math.floor((maxChars - 80) / 2)

  for (const paragraph of paragraphs) {
    const line = `[${paragraph.id}] ${paragraph.text}`
    if (headChars + line.length > budget) break
    head.push(line)
    headChars += line.length
  }

  for (let index = paragraphs.length - 1; index >= 0; index--) {
    const paragraph = paragraphs[index]
    const line = `[${paragraph.id}] ${paragraph.text}`
    if (tailChars + line.length > budget) break
    tail.unshift(line)
    tailChars += line.length
  }

  return `${head.join('\n\n')}\n\n...（中间段落已省略，请优先使用可见段落编号定位）...\n\n${tail.join('\n\n')}`.trim()
}

export function findSelectedParagraphRange(
  chapterHtml: string,
  selectedText?: string
): { startParagraphId: string; endParagraphId: string; text: string } | null {
  const cleanedSelection = selectedText?.trim()
  if (!cleanedSelection) return null

  const paragraphs = getNumberedParagraphs(chapterHtml)
  const normalizedSelection = normalizeComparable(cleanedSelection)
  if (!normalizedSelection) return null

  const matching = paragraphs.filter(paragraph => {
    const comparable = normalizeComparable(paragraph.text)
    return comparable.includes(normalizedSelection) || normalizedSelection.includes(comparable)
  })

  if (matching.length === 0) return null

  return {
    startParagraphId: matching[0].id,
    endParagraphId: matching[matching.length - 1].id,
    text: matching.map(paragraph => paragraph.text).join('\n\n')
  }
}

export function applyNovelEditPlan(chapterHtml: string, rawPlan: NovelEditPlan): PlannedChapterEditResult {
  const plan = normalizePlan(rawPlan)
  let blocks = getNumberedParagraphs(chapterHtml).map(paragraph => ({
    id: paragraph.id,
    text: paragraph.text
  }))
  const warnings: string[] = []
  const appliedOperations: AppliedNovelOperation[] = []

  for (const operation of plan.operations) {
    const normalizedOperation = normalizeOperation(operation)
    const result = applyOperation(blocks, normalizedOperation)
    blocks = result.blocks
    appliedOperations.push({
      ...normalizedOperation,
      applied: result.applied,
      fallback: result.fallback
    })
    if (result.fallback) warnings.push(result.fallback)
  }

  const proposedText = blocks.map(block => block.text.trim()).filter(Boolean).join('\n\n')

  return {
    plan,
    proposedText,
    proposedHtml: normalizeChapterContent(plainTextToHtml(proposedText)),
    summary: plan.summary || summarizeOperations(appliedOperations),
    appliedOperations,
    warnings
  }
}

export function normalizePlan(rawPlan: NovelEditPlan): NovelEditPlan {
  const operations = Array.isArray(rawPlan.operations) ? rawPlan.operations.map(normalizeOperation) : []
  return {
    summary: typeof rawPlan.summary === 'string' ? rawPlan.summary.trim() : '',
    confidence: clampConfidence(rawPlan.confidence),
    operations: operations.length > 0
      ? operations
      : [fallbackNovelOperation('', 'AI 未返回有效操作，保留空计划')]
  }
}

export function cleanDraftText(input: string): string {
  return input
    .replace(/\r\n/g, '\n')
    .replace(/\[WORKFLOW_COMPLETE\]/g, '')
    .replace(/\[\s*TOOL\s*:[\s\S]*?\[\s*\/\s*TOOL\s*\]/gi, '')
    .replace(/```(?:markdown|md|text|html)?\n([\s\S]*?)```/gi, '$1')
    .replace(/^\s*\*\*(正文|正文定稿|最终正文|小说正文|章节正文|成稿|正文稿|最终稿)[:：]?\s*\*\*\s*$/gim, '')
    .replace(/^\s*(正文|正文定稿|最终正文|小说正文|章节正文|成稿|正文稿|最终稿)[:：]\s*$/gim, '')
    .trim()
}

export function fallbackNovelEditPlan(newText: string, reason = '未能获得可靠定位，默认追加到章尾'): NovelEditPlan {
  return {
    summary: reason,
    confidence: 0.35,
    operations: [fallbackNovelOperation(newText, reason)]
  }
}

export function extractJsonObject(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = fenced?.[1] ?? text
  const firstBrace = candidate.indexOf('{')
  const lastBrace = candidate.lastIndexOf('}')

  if (firstBrace < 0 || lastBrace <= firstBrace) return null

  try {
    return JSON.parse(candidate.slice(firstBrace, lastBrace + 1))
  } catch {
    return null
  }
}

function applyOperation(
  blocks: ParagraphBlock[],
  operation: NovelEditOperation
): { blocks: ParagraphBlock[]; applied: boolean; fallback?: string } {
  const newBlocks = splitIntoParagraphs(operation.text || '').map((text, index) => ({
    id: makeGeneratedId(operation.type, index),
    text
  }))

  switch (operation.type) {
    case 'rewrite_chapter':
      return {
        blocks: newBlocks,
        applied: newBlocks.length > 0,
        fallback: newBlocks.length === 0 ? '重写操作没有正文内容，已跳过' : undefined
      }

    case 'prepend_chapter':
      return {
        blocks: [...newBlocks, ...blocks],
        applied: newBlocks.length > 0,
        fallback: newBlocks.length === 0 ? '章首插入没有正文内容，已跳过' : undefined
      }

    case 'append_chapter':
      return {
        blocks: [...blocks, ...newBlocks],
        applied: newBlocks.length > 0,
        fallback: newBlocks.length === 0 ? '章尾追加没有正文内容，已跳过' : undefined
      }

    case 'insert_after_paragraph': {
      const index = findParagraphIndex(blocks, operation.paragraphId)
      if (index < 0) {
        return {
          blocks: [...blocks, ...newBlocks],
          applied: newBlocks.length > 0,
          fallback: `未找到段落 ${operation.paragraphId || '(空)'}，已改为追加到章尾`
        }
      }
      return {
        blocks: [...blocks.slice(0, index + 1), ...newBlocks, ...blocks.slice(index + 1)],
        applied: newBlocks.length > 0
      }
    }

    case 'insert_before_paragraph': {
      const index = findParagraphIndex(blocks, operation.paragraphId)
      if (index < 0) {
        return {
          blocks: [...newBlocks, ...blocks],
          applied: newBlocks.length > 0,
          fallback: `未找到段落 ${operation.paragraphId || '(空)'}，已改为插入章首`
        }
      }
      return {
        blocks: [...blocks.slice(0, index), ...newBlocks, ...blocks.slice(index)],
        applied: newBlocks.length > 0
      }
    }

    case 'delete_paragraphs': {
      const range = findParagraphRange(blocks, operation)
      if (!range) {
        return { blocks, applied: false, fallback: '未找到要删除的段落，已跳过' }
      }
      return {
        blocks: [...blocks.slice(0, range.start), ...blocks.slice(range.end + 1)],
        applied: true
      }
    }

    case 'replace_paragraphs': {
      const range = findParagraphRange(blocks, operation)
      if (!range) {
        return {
          blocks: [...blocks, ...newBlocks],
          applied: newBlocks.length > 0,
          fallback: '未找到要替换的段落，已改为追加到章尾'
        }
      }
      return {
        blocks: [...blocks.slice(0, range.start), ...newBlocks, ...blocks.slice(range.end + 1)],
        applied: newBlocks.length > 0
      }
    }

    default:
      return {
        blocks: [...blocks, ...newBlocks],
        applied: newBlocks.length > 0,
        fallback: '未知操作类型，已改为追加到章尾'
      }
  }
}

function normalizeOperation(operation: NovelEditOperation): NovelEditOperation {
  const type = isNovelEditOperationType(operation.type) ? operation.type : 'append_chapter'
  return {
    type,
    paragraphId: normalizeParagraphId(operation.paragraphId),
    startParagraphId: normalizeParagraphId(operation.startParagraphId),
    endParagraphId: normalizeParagraphId(operation.endParagraphId),
    text: cleanDraftText(operation.text || ''),
    reason: typeof operation.reason === 'string' ? operation.reason.trim() : undefined
  }
}

function fallbackNovelOperation(newText: string, reason: string): NovelEditOperation {
  return {
    type: 'append_chapter',
    text: cleanDraftText(newText),
    reason
  }
}

function findParagraphIndex(blocks: ParagraphBlock[], paragraphId?: string): number {
  const normalized = normalizeParagraphId(paragraphId)
  if (!normalized) return -1
  return blocks.findIndex(block => block.id === normalized)
}

function findParagraphRange(
  blocks: ParagraphBlock[],
  operation: NovelEditOperation
): { start: number; end: number } | null {
  const startId = operation.startParagraphId || operation.paragraphId
  const endId = operation.endParagraphId || operation.startParagraphId || operation.paragraphId
  const start = findParagraphIndex(blocks, startId)
  const end = findParagraphIndex(blocks, endId)

  if (start < 0 || end < 0) return null
  return { start: Math.min(start, end), end: Math.max(start, end) }
}

function splitIntoParagraphs(text: string): string[] {
  const normalized = cleanDraftText(text)
  if (!normalized) return []

  const blankLineBlocks = normalized
    .split(/\n{2,}/)
    .map(block => block.trim())
    .filter(Boolean)

  if (blankLineBlocks.length > 1) return blankLineBlocks

  return normalized
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
}

function normalizeComparable(text: string): string {
  return text.replace(/\s+/g, '').trim()
}

function normalizeParagraphId(id?: string): string | undefined {
  const match = id?.trim().match(/^p?(\d+)$/i)
  return match ? `p${Number(match[1])}` : undefined
}

function makeGeneratedId(type: NovelEditOperationType, index: number): string {
  return `new_${type}_${index + 1}_${Math.random().toString(36).slice(2, 8)}`
}

function isNovelEditOperationType(value: string): value is NovelEditOperationType {
  return [
    'append_chapter',
    'prepend_chapter',
    'insert_after_paragraph',
    'insert_before_paragraph',
    'replace_paragraphs',
    'delete_paragraphs',
    'rewrite_chapter'
  ].includes(value)
}

function clampConfidence(value: unknown): number {
  return typeof value === 'number' ? Math.max(0, Math.min(1, value)) : 0.5
}

function summarizeOperations(operations: AppliedNovelOperation[]): string {
  const labels: Record<NovelEditOperationType, string> = {
    append_chapter: '追加到章尾',
    prepend_chapter: '插入到章首',
    insert_after_paragraph: '插入到段落之后',
    insert_before_paragraph: '插入到段落之前',
    replace_paragraphs: '替换段落',
    delete_paragraphs: '删除段落',
    rewrite_chapter: '重写章节'
  }
  const applied = operations.filter(operation => operation.applied)
  if (applied.length === 0) return '未应用任何编辑'
  return applied.map(operation => labels[operation.type]).join('，')
}

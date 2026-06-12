import { readFileSync } from 'fs'
import { extname } from 'path'

export interface ParsedDocument {
  text: string
  charCount: number
  metadata: Record<string, string>
}

export interface TextChunk {
  content: string
  chapterLabel: string
  chunkIndex: number
}

const CHAPTER_PATTERNS = [
  /^第[一二三四五六七八九十百千零〇\d]+[章节回卷集部篇]/m,
  /^Chapter\s*\d+/im,
  /^第\d+章/m,
  /^\d+\.\s+/m,
  /^【[^】]+】/m,
]

function detectChapterHeader(line: string): string | null {
  for (const pattern of CHAPTER_PATTERNS) {
    const match = line.match(pattern)
    if (match) return match[0].trim()
  }
  return null
}

export function parseDocument(filePath: string): ParsedDocument {
  const ext = extname(filePath).toLowerCase()
  return parseTextFile(filePath, ext)
}

function parseTextFile(filePath: string, ext: string): ParsedDocument {
  const text = readFileSync(filePath, 'utf-8')
  return { text, charCount: text.length, metadata: { format: ext } }
}

export function chunkText(text: string, chunkSize: number = 1500, overlap: number = 150): TextChunk[] {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map(block => block.trim())
    .filter(Boolean)
  const chunks: TextChunk[] = []
  let currentChapter = '(开头)'
  let currentContent = ''
  let chunkIndex = 0

  for (const paragraph of paragraphs) {
    const firstLine = paragraph.split('\n').find(Boolean) ?? paragraph
    const chapterHeader = detectChapterHeader(firstLine)

    if (chapterHeader && currentContent.trim()) {
      flushBuffer()
    }

    if (chapterHeader) {
      currentChapter = chapterHeader
    }

    const candidate = currentContent.trim()
      ? `${currentContent.trim()}\n\n${paragraph}`
      : paragraph

    if (currentContent.trim() && candidate.length > chunkSize) {
      flushBuffer()
    }

    currentContent = currentContent.trim()
      ? `${currentContent.trim()}\n\n${paragraph}`
      : paragraph

    if (currentContent.length >= chunkSize) {
      flushBuffer()
    }
  }

  if (currentContent.trim()) {
    flushBuffer()
  }

  function flushBuffer() {
    const trimmed = currentContent.trim()
    if (!trimmed) return
    chunks.push({
      content: trimmed,
      chapterLabel: currentChapter,
      chunkIndex: chunkIndex++
    })

    if (overlap > 0 && trimmed.length > overlap * 2) {
      const lastPart = trimmed.slice(-overlap)
      currentContent = lastPart + '\n'
    } else {
      currentContent = ''
    }
  }

  return chunks
}

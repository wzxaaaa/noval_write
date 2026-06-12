import { htmlToPlainText } from './textMetrics'

export function normalizeChapterTitle(input: string, fallback = '未命名章节'): string {
  const plain = htmlToPlainText(input)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => normalizeTitleLine(line))
    .find(Boolean)

  if (!plain) return fallback

  const chapterMatch = plain.match(/第[一二三四五六七八九十百千万\d]+[章节回幕卷][^。！？\n]{0,40}/)
  if (chapterMatch) return chapterMatch[0].trim()

  const withoutLabel = plain.replace(/^(title|标题|章节标题)\s*[:：]\s*/i, '').trim()
  if (!withoutLabel) return fallback

  return Array.from(withoutLabel).slice(0, 48).join('').trim() || fallback
}

export function normalizeChapterContent(input: string): string {
  const content = input.trim()
  if (!content) return ''
  if (looksLikeHtml(content)) return content
  return plainTextToHtml(content)
}

export function plainTextToHtml(input: string): string {
  const blocks = input
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .map(block => block.trim())
    .filter(Boolean)

  if (blocks.length === 0) return '<p></p>'

  return blocks.map(formatBlock).join('')
}

function normalizeTitleLine(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\*\*|\*\*$/g, '')
    .replace(/^[-*+]\s+/, '')
    .trim()
}

function looksLikeHtml(value: string): boolean {
  return /<\/?(p|div|h[1-6]|br|ul|ol|li|blockquote)\b/i.test(value)
}

function formatBlock(block: string): string {
  const lines = block.split('\n')

  if (lines.length === 1) {
    const heading = parseHeading(lines[0])
    if (heading) return heading
  }

  if (lines.every(line => /^[-*+]\s+/.test(line.trim()))) {
    return `<ul>${lines.map(line => `<li>${escapeHtml(line.trim().replace(/^[-*+]\s+/, ''))}</li>`).join('')}</ul>`
  }

  if (lines.every(line => /^\d+\.\s+/.test(line.trim()))) {
    return `<ol>${lines.map(line => `<li>${escapeHtml(line.trim().replace(/^\d+\.\s+/, ''))}</li>`).join('')}</ol>`
  }

  return `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`
}

function parseHeading(line: string): string | null {
  const match = /^(#{1,3})\s+(.+)$/.exec(line.trim())
  if (!match) return null

  const level = match[1].length
  return `<h${level}>${escapeHtml(match[2])}</h${level}>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

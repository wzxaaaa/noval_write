export function countContentChars(input: string): number {
  const visible = htmlToText(input)
  return Array.from(visible.replace(/\s+/g, '')).length
}

export function htmlToText(input: string): string {
  return decodeHtmlEntities(input)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/\u00a0/g, ' ')
}

export function htmlToPlainText(input: string): string {
  return decodeHtmlEntities(input)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(h[1-6]|p|div|blockquote|tr)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function estimateTokenCount(input: string): number {
  const text = htmlToText(input)
  const cjkChars = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0
  const nonCjk = text.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, '')
  const nonCjkTokens = Math.ceil(nonCjk.replace(/\s+/g, ' ').trim().length / 4)
  return cjkChars + Math.max(0, nonCjkTokens)
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

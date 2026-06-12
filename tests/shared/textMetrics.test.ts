import { describe, expect, it } from 'vitest'
import { countContentChars, estimateTokenCount, htmlToPlainText } from '../../src/shared/textMetrics'

describe('textMetrics', () => {
  it('counts visible Chinese content instead of whitespace-separated words', () => {
    expect(countContentChars('<p>第一章开始。</p><p>他推开门。</p>')).toBe(11)
  })

  it('estimates token count for mixed CJK and latin text', () => {
    expect(estimateTokenCount('这是中文 text')).toBeGreaterThan(4)
  })

  it('keeps paragraph structure when exporting plain text', () => {
    expect(htmlToPlainText('<h1>第一章</h1><p>第一段<br>第二行</p><p>第三段</p>')).toBe('第一章\n\n第一段\n第二行\n\n第三段')
  })
})

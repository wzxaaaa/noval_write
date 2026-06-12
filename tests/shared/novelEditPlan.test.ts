import { describe, expect, it } from 'vitest'
import { applyNovelEditPlan, buildNumberedChapterText, findSelectedParagraphRange } from '../../src/shared/novelEditPlan'

describe('novelEditPlan', () => {
  it('builds stable paragraph ids for chapter text', () => {
    const numbered = buildNumberedChapterText('<p>第一段</p><p>第二段</p>')

    expect(numbered).toContain('[p1] 第一段')
    expect(numbered).toContain('[p2] 第二段')
  })

  it('inserts generated prose after a paragraph id', () => {
    const result = applyNovelEditPlan('<p>第一段</p><p>第二段</p>', {
      summary: '插入',
      confidence: 0.9,
      operations: [
        {
          type: 'insert_after_paragraph',
          paragraphId: 'p1',
          text: '新段落'
        }
      ]
    })

    expect(result.proposedText).toBe('第一段\n\n新段落\n\n第二段')
    expect(result.warnings).toEqual([])
  })

  it('replaces a selected paragraph range', () => {
    const result = applyNovelEditPlan('<p>第一段</p><p>第二段</p><p>第三段</p>', {
      summary: '替换',
      confidence: 0.9,
      operations: [
        {
          type: 'replace_paragraphs',
          startParagraphId: 'p2',
          endParagraphId: 'p2',
          text: '新的第二段'
        }
      ]
    })

    expect(result.proposedText).toBe('第一段\n\n新的第二段\n\n第三段')
  })

  it('falls back to appending when a paragraph id is missing', () => {
    const result = applyNovelEditPlan('<p>第一段</p>', {
      summary: '插入',
      confidence: 0.4,
      operations: [
        {
          type: 'insert_after_paragraph',
          paragraphId: 'p9',
          text: '新段落'
        }
      ]
    })

    expect(result.proposedText).toBe('第一段\n\n新段落')
    expect(result.warnings[0]).toContain('未找到段落 p9')
  })

  it('maps selected text back to paragraph ids', () => {
    const result = findSelectedParagraphRange('<p>第一段</p><p>关键第二段</p>', '关键第二段')

    expect(result?.startParagraphId).toBe('p2')
    expect(result?.endParagraphId).toBe('p2')
  })
})

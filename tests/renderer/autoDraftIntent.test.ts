import { describe, expect, it } from 'vitest'
import { isOutlineOnlyInstruction, shouldAutoApplyAssistantDraft } from '../../src/renderer/lib/autoDraftIntent'

describe('autoDraftIntent', () => {
  it('does not auto-place outline-only requests into chapter body', () => {
    const instruction = '小漫，请根据项目名称，定下整个小说的大纲，并且目标总字数在一百万出头，章节数目标在500-600章。'

    expect(isOutlineOnlyInstruction(instruction)).toBe(true)
    expect(shouldAutoApplyAssistantDraft(instruction)).toBe(false)
  })

  it('allows body drafting when outline is only source material', () => {
    expect(shouldAutoApplyAssistantDraft('小漫，根据第二章的细纲完成第二章正文')).toBe(true)
  })

  it('skips auto-placement after outline was already saved by an action', () => {
    const result = {
      actionResults: [
        { name: 'upsert_outline', ok: true, message: '大纲已保存' }
      ]
    }

    expect(shouldAutoApplyAssistantDraft('帮我写一个大纲', result)).toBe(false)
  })
})

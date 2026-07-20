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

  it('auto-places anti-AI-flavor rewrites into the chapter body proposal flow', () => {
    expect(shouldAutoApplyAssistantDraft('小漫，帮当前章祛味，去掉AI味后给可替换正文')).toBe(true)
  })

  it('auto-places vague web-novel polish requests into the chapter body proposal flow', () => {
    expect(shouldAutoApplyAssistantDraft('小漫，其实专业术语没必要这么多，毕竟咱们写的是网络小说。你看着帮忙处理一下')).toBe(true)
  })

  it('auto-places follow-up placement wording into the chapter body proposal flow', () => {
    expect(shouldAutoApplyAssistantDraft('小漫把你改好的放进去')).toBe(true)
  })

  it('does not auto-place next-scene design advice into the chapter body', () => {
    expect(shouldAutoApplyAssistantDraft('请基于当前章节末尾设计下一场戏，给我一个 6 拍细纲')).toBe(false)
  })

  it('auto-places explicit next-scene prose writing into the chapter body', () => {
    expect(shouldAutoApplyAssistantDraft('请续写下一场正文')).toBe(true)
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

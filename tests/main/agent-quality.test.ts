import { describe, expect, it } from 'vitest'
import { AgentContextManager } from '../../src/main/services/agent/context-manager'
import { assessAgentOutput, inspectChinesePunctuation, inspectTextDegeneration, validateChapterDraft } from '../../src/main/services/agent/quality-monitor'

describe('agent quality monitor', () => {
  it('flags chapter creation claims without matching tools', () => {
    const result = assessAgentOutput('已创建第一章并写入章节列表。', [], 0.1)

    expect(result.hallucinationRisk).toBe('high')
  })

  it('flags failed chapter tools instead of treating calls as success', () => {
    const result = assessAgentOutput('已创建第一章。', [
      { tool: 'create_chapter', input: 'title: 第一章', output: '已拦截：主编不能绕过工作 Agent', ok: false }
    ], 0.1)

    expect(result.hallucinationRisk).toBe('high')
    expect(result.issues.join('\n')).toContain('章节工具调用失败')
  })

  it('rejects workflow summaries as chapter drafts', () => {
    const validation = validateChapterDraft('字数校验完成。\n结构校验完成。\n工作总结：可以交付。')

    expect(validation.ok).toBe(false)
  })

  it('rejects chapter drafts with long Chinese runs and sparse punctuation', () => {
    const draft = [
      '心跳声从耳膜内侧炸开怦怦怦怦快得像要撞碎骨头紧接着那声音变了调子越来越慢越来越重最后一下拖得极长像是有人把秒表按进了泥沼里',
      '他张了张嘴想喊隔壁工位的老王喉咙里涌上来的却是一股铁锈味视野里所有灰色单元格都像水蛭一样扭曲拉伸边框线渗出暗红色泽。'
    ].join('')

    const inspection = inspectChinesePunctuation(draft)
    const validation = validateChapterDraft(draft)

    expect(inspection.ok).toBe(false)
    expect(validation.ok).toBe(false)
    expect(validation.reason).toContain('标点')
  })

  it('accepts polished Chinese prose with natural punctuation', () => {
    const draft = [
      '那些灰色的单元格像水蛭一样扭曲、拉伸，边框线渗出某种暗红的色泽。',
      '陈默试图眨眼，视野却没有恢复，反而变得更加清晰。',
      '耳鸣先是一根针，然后是一口钟；心跳声从耳膜内侧炸开，快得像要撞碎骨头。',
      '他张了张嘴，想喊隔壁工位的老王，喉咙里涌上来的却是一股铁锈味。',
      '脸砸下去的时候，他没有感觉到键盘的硬度。最后一个钻进意识的声响，是钉钉的提示音。',
      '黑暗没有过渡。下一秒，陈默猛地吸了一口气，睁开眼。'
    ].join('\n')

    expect(inspectChinesePunctuation(draft).ok).toBe(true)
    expect(validateChapterDraft(draft).ok).toBe(true)
  })

  it('rejects model repetition degeneration in chapter drafts', () => {
    const draft = [
      '纸页下方留出的签名栏不是横线，而是一个正在缓慢旋转的黑色漩涡。',
      '边缘长着细密的牙齿，每一颗都在无声地开合。',
      '不休不休不休不休不休不休不休不休不休不休不休不休。',
      '谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢合作合作合作合作合作合作合作合作。'
    ].join('\n')

    expect(inspectTextDegeneration(draft).ok).toBe(false)
    expect(validateChapterDraft(draft).ok).toBe(false)
  })
})

describe('AgentContextManager', () => {
  it('compresses old messages when token budget is exceeded', () => {
    const manager = new AgentContextManager(10)
    manager.record('这是一个很长很长的上下文，用来触发压缩。')

    const compressed = manager.compress([
      { role: 'user', content: '一' },
      { role: 'assistant', content: '二' },
      { role: 'user', content: '三' },
      { role: 'assistant', content: '四' },
      { role: 'user', content: '五' },
      { role: 'assistant', content: '六' },
      { role: 'user', content: '七' }
    ])

    expect(compressed.stats.compressed).toBe(true)
    expect(compressed.messages[0].content).toContain('[CONTEXT_COMPRESSED]')
  })
})

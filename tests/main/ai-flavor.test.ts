import { describe, expect, it } from 'vitest'
import { formatAiFlavorReport, inspectAiFlavor } from '../../src/main/services/agent/quality-monitor'

describe('inspectAiFlavor', () => {
  it('flags AI-flavored prose: antithesis, pseudo metrics, cliché metaphors and fragment paragraphs', () => {
    const draft = [
      '这不是简单的情感分析。',
      '这是透视大脑负荷。',
      '他忽然明白，这根本不是运气，而是实力。',
      '系统弹出报告：恐慌诱导指数0.91，可信度-100%，准确率99.99%。',
      '那东西像深海巨兽在黑暗中骤然睁开了冰冷的眼，一种说不出的精致里透着让人发毛的狂热。',
      '延期。',
      '休眠了。',
      '三天了。',
      '是维度。',
      '林辰死死盯着那行冰冷的白色字体，指尖发抖，胸口起伏，脑子里全是评语和倒计时的猩红光芒交织在一起的画面。'
    ].join('\n\n')

    const result = inspectAiFlavor(draft)

    expect(result.ok).toBe(false)
    expect(result.score).toBeGreaterThanOrEqual(6)
    expect(result.issues.length).toBeGreaterThanOrEqual(3)
    expect(result.samples.length).toBeGreaterThan(0)

    const report = formatAiFlavorReport(result)
    expect(report).toContain('AI 腔')
  })

  it('accepts natural prose with concrete detail and normal punctuation', () => {
    const draft = [
      '那些灰色的单元格像水蛭一样扭曲、拉伸，边框线渗出某种暗红的色泽。',
      '陈默试图眨眼，视野却没有恢复，反而变得更加清晰。',
      '耳鸣先是一根针，然后是一口钟；心跳声从耳膜内侧炸开，快得像要撞碎骨头。',
      '他张了张嘴，想喊隔壁工位的老王，喉咙里涌上来的却是一股铁锈味。',
      '脸砸下去的时候，他没有感觉到键盘的硬度，只闻到一股凉掉的咖啡味。',
      '下一秒，他猛地吸了一口气，睁开眼，屏幕的幽光还亮着，光标停在那一行没改完的代码上。'
    ].join('\n')

    const result = inspectAiFlavor(draft)

    expect(result.ok).toBe(true)
    expect(result.issues).toHaveLength(0)
    expect(formatAiFlavorReport(result)).toBe('')
  })

  it('skips very short fragments (not enough text to judge)', () => {
    const result = inspectAiFlavor('这不是结束，而是开始。')
    expect(result.ok).toBe(true)
    expect(result.score).toBe(0)
  })
})

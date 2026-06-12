import { describe, expect, it } from 'vitest'
import {
  extractOutlineDrafts,
  isOutlinePlacementInstruction,
  summarizeOutlineDraftTypes
} from '../../src/shared/outlineDraft'

describe('outlineDraft', () => {
  it('extracts outline and detailed outline sections from markdown headings', () => {
    const drafts = extractOutlineDrafts(`
以下是为您整理的结构：

## **《重生》故事大纲**

- 核心设定：主角重生回关键节点
- 主线矛盾：外部压力与内部黑化

## **《重生》章节细纲**

### 第一章：醒来
- 场景目标：建立危机
- 结尾钩子：手机弹出旧日短信
`)

    expect(drafts).toHaveLength(2)
    expect(drafts[0]).toMatchObject({
      type: 'outline',
      title: '《重生》故事大纲'
    })
    expect(drafts[0].content).toContain('核心设定')
    expect(drafts[1]).toMatchObject({
      type: 'detailed',
      title: '《重生》章节细纲'
    })
    expect(drafts[1].content).toContain('第一章')
  })

  it('handles inline bold labels', () => {
    const drafts = extractOutlineDrafts(`
**大纲：** 主角从失败结局回到十八岁，试图改变母亲死亡和家族覆灭。

**细纲：** 第一章写醒来，第二章写试探旧友，第三章写第一次反击。
`, '重生')

    expect(drafts).toHaveLength(2)
    expect(drafts[0].content).toContain('十八岁')
    expect(drafts[1].content).toContain('第二章')
  })

  it('does not treat a generic combined title as a draft', () => {
    const drafts = extractOutlineDrafts(`
## 大纲 / 细纲

这是总标题。

### 故事大纲
主角被迫重新选择。

### 分章细纲
第一章：雨夜醒来。
`)

    expect(drafts).toHaveLength(2)
    expect(summarizeOutlineDraftTypes(drafts)).toBe('大纲/细纲')
  })

  it('detects explicit placement instructions', () => {
    expect(isOutlinePlacementInstruction('小漫，帮我放到对应的大纲和细纲中')).toBe(true)
    expect(isOutlinePlacementInstruction('请帮我润色这一段')).toBe(false)
  })
})

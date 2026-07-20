import { describe, expect, it } from 'vitest'
import {
  buildSkillPromptBlock,
  deriveSkillMeta,
  normalizeSkillBindings,
  parseSkillFrontmatter,
  stripSkillFrontmatter
} from '../../src/shared/skills'

/** chinese-novelist-skill 那种带 YAML frontmatter 的标准技能包。 */
const WITH_FRONTMATTER = `---
name: chinese-novelist
description: AI 驱动的中文小说创作助手，三层递进式问答、跨会话偏好记忆。
version: 2.0
---

# 中文小说创作助手

写小说最难的是坚持写完，本技能专为解决这个痛点而生。

## 核心法则
- 展示而非讲述
- 冲突驱动剧情`

/** novel-writing-framework 那种散装 markdown，没有 frontmatter。 */
const WITHOUT_FRONTMATTER = `# 网文写作方法论

一套从 500+ 章实战中提炼的中文网文写作全流程框架。

## 技能体系架构
writing-novel（基础层：通用流程 + 技术规范）`

describe('deriveSkillMeta', () => {
  it('优先使用 frontmatter 的 name/description/version', () => {
    const meta = deriveSkillMeta(WITH_FRONTMATTER, '兜底名')
    expect(meta.name).toBe('chinese-novelist')
    expect(meta.version).toBe('2.0')
    expect(meta.description).toContain('三层递进式问答')
  })

  it('没有 frontmatter 时退回一级标题和首段', () => {
    const meta = deriveSkillMeta(WITHOUT_FRONTMATTER, '兜底名')
    expect(meta.name).toBe('网文写作方法论')
    expect(meta.description).toContain('500+ 章实战')
    expect(meta.version).toBe('')
  })

  it('既没标题也没 frontmatter 时用文件名兜底', () => {
    expect(deriveSkillMeta('只有一段没有标题的正文', 'piqie-writing').name).toBe('piqie-writing')
  })

  it('描述里剥掉 markdown 行内标记', () => {
    const meta = deriveSkillMeta('# 标题\n\n这是**加粗**和[链接](http://x)。', 'x')
    expect(meta.description).toBe('这是加粗和链接。')
  })
})

describe('parseSkillFrontmatter', () => {
  it('剥离 frontmatter 后保留正文', () => {
    expect(stripSkillFrontmatter(WITH_FRONTMATTER).trim().startsWith('# 中文小说创作助手')).toBe(true)
  })

  it('没有 frontmatter 时原样返回', () => {
    expect(parseSkillFrontmatter(WITHOUT_FRONTMATTER).body).toBe(WITHOUT_FRONTMATTER)
  })

  it('容忍带引号的值', () => {
    const { frontmatter } = parseSkillFrontmatter('---\nname: "带引号"\n---\n正文')
    expect(frontmatter.name).toBe('带引号')
  })

  // chinese-novelist 用的就是块标量写法，早期版本会把描述读成字面量 "|"
  it('解析 YAML 块标量描述（| 字面式）', () => {
    const { frontmatter } = parseSkillFrontmatter(
      '---\nname: chinese-novelist\ndescription: |\n  第一行说明。\n  第二行说明。\nmetadata:\n  trigger: 忽略我\n---\n# 正文'
    )
    expect(frontmatter.name).toBe('chinese-novelist')
    expect(frontmatter.description).toBe('第一行说明。\n第二行说明。')
  })

  it('解析 YAML 块标量描述（> 折叠式）', () => {
    const { frontmatter } = parseSkillFrontmatter(
      '---\ndescription: >\n  折叠第一行\n  折叠第二行\n---\n正文'
    )
    expect(frontmatter.description).toBe('折叠第一行 折叠第二行')
  })

  it('忽略 metadata 之类的嵌套子键，不误当成顶层字段', () => {
    const { frontmatter } = parseSkillFrontmatter(
      '---\nmetadata:\n  name: 不该被采用\n---\n# 真标题'
    )
    expect(frontmatter.name).toBeUndefined()
  })
})

describe('buildSkillPromptBlock', () => {
  it('没有技能或技能为空时返回空串', () => {
    expect(buildSkillPromptBlock([])).toBe('')
    expect(buildSkillPromptBlock([{ name: 'x', content: '   ' }])).toBe('')
  })

  it('包裹技能正文并去掉 frontmatter', () => {
    const block = buildSkillPromptBlock([{ name: 'chinese-novelist', content: WITH_FRONTMATTER }])
    expect(block).toContain('<skill name="chinese-novelist">')
    expect(block).toContain('展示而非讲述')
    expect(block).not.toContain('version: 2.0')
  })

  it('声明用户当前指令优先级最高', () => {
    const block = buildSkillPromptBlock([{ name: 'a', content: '# A' }])
    expect(block).toContain('以用户要求为准')
  })

  it('保持挂载顺序，后挂载的优先级更高', () => {
    const block = buildSkillPromptBlock([
      { name: 'base', content: '# Base' },
      { name: 'override', content: '# Override' }
    ])
    expect(block.indexOf('name="base"')).toBeLessThan(block.indexOf('name="override"'))
  })

  it('3 万字符的技能完整载入，不截断', () => {
    const block = buildSkillPromptBlock([{ name: 'writing-novel', content: '啊'.repeat(30000) }])
    expect(block).not.toContain('已截断')
  })

  it('单个技能超过 4 万字符才截断', () => {
    const block = buildSkillPromptBlock([{ name: 'big', content: '啊'.repeat(50000) }])
    expect(block).toContain('已截断')
    expect(block.length).toBeLessThan(42000)
  })

  it('合计超过总预算时跳过后续技能并写明', () => {
    const block = buildSkillPromptBlock([
      { name: 'a', content: '啊'.repeat(40000) },
      { name: 'b', content: '啊'.repeat(40000) },
      { name: 'c', content: '啊'.repeat(40000) },
      { name: 'd', content: '被挤掉的技能' }
    ])
    expect(block).toContain('name="a"')
    expect(block).toContain('未被载入')
    expect(block).toContain('d')
    expect(block).not.toContain('被挤掉的技能')
  })

  it('技能名里的引号不会破坏属性', () => {
    const block = buildSkillPromptBlock([{ name: 'say "hi"\nnext', content: '# X' }])
    expect(block).toContain(`<skill name="say 'hi' next">`)
  })
})

describe('normalizeSkillBindings', () => {
  it('把任意脏数据归一成两个数组', () => {
    expect(normalizeSkillBindings(null)).toEqual({ xiaoman: [], writingTeam: [] })
    expect(normalizeSkillBindings('nope')).toEqual({ xiaoman: [], writingTeam: [] })
  })

  it('去重、去空、丢掉非字符串', () => {
    expect(normalizeSkillBindings({ xiaoman: ['a', 'a', '', 3, ' b '], writingTeam: 'bad' }))
      .toEqual({ xiaoman: ['a', 'b'], writingTeam: [] })
  })

  it('忽略未知目标', () => {
    expect(normalizeSkillBindings({ xiaoman: ['a'], unknown: ['x'] }))
      .toEqual({ xiaoman: ['a'], writingTeam: [] })
  })
})

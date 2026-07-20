import { describe, expect, it } from 'vitest'
import {
  composeCreatedChapterTitle,
  ensureNumberedChapterTitle,
  inferChapterPipelineRole,
  isRetryablePipelineError,
  normalizeMemoryPatch,
  parseChapterTaskPackage,
  resolvePipelineAssignments,
  toChineseChapterNumeral,
  truncateMemoryText,
  type PipelineMember
} from '../../src/main/services/agent/chapter-pipeline'

function member(partial: Partial<PipelineMember>): PipelineMember {
  return {
    group_id: 'group',
    agent_id: partial.agent_id ?? partial.id ?? 'agent',
    turn_order: partial.turn_order ?? 0,
    can_initiate: 1,
    is_moderator: partial.is_moderator ?? 0,
    routing_rules: partial.routing_rules ?? '{}',
    id: partial.id ?? partial.agent_id ?? 'agent',
    name: partial.name ?? 'Agent',
    description: partial.description ?? null,
    role: partial.role ?? '',
    system_prompt: partial.system_prompt ?? '',
    model: partial.model ?? 'provider',
    tools: '[]',
    parameters: partial.parameters ?? '{}',
    category_id: null,
    created_at: '2026-01-01'
  }
}

describe('chapter pipeline task package', () => {
  it('parses JSON chapter task packages and always clamps to one chapter', () => {
    const task = parseChapterTaskPackage(JSON.stringify({
      novel_id: 'novel_001',
      chapter_index: 12,
      chapter_goal: '主角发现师父隐瞒了十年前的真相',
      user_directive: '本章氛围压抑，结尾要有反转',
      target_words: 3500,
      pov: '第三人称有限视角',
      must_include: ['雨夜', '旧信', '师父失控'],
      must_avoid: ['不要直接解释全部真相']
    }), { projectId: 'project', nextChapterIndex: 3 })

    expect(task).toMatchObject({
      novel_id: 'novel_001',
      chapter_index: 12,
      chapter_goal: '主角发现师父隐瞒了十年前的真相',
      target_words: 3500,
      pov: '第三人称有限视角',
      must_include: ['雨夜', '旧信', '师父失控'],
      must_avoid: ['不要直接解释全部真相'],
      single_chapter_only: true
    })
  })

  it('uses the project default target words when the instruction gives none', () => {
    const task = parseChapterTaskPackage('请写下一章', {
      projectId: 'project',
      nextChapterIndex: 4,
      defaultTargetWords: 2000
    })

    expect(task.target_words).toBe(2000)
  })

  it('lets an explicit target in the instruction override the project default', () => {
    const task = parseChapterTaskPackage('请写下一章，目标 5000 字', {
      projectId: 'project',
      nextChapterIndex: 4,
      defaultTargetWords: 2000
    })

    expect(task.target_words).toBe(5000)
  })

  it('falls back to the global default when neither instruction nor project set a target', () => {
    const task = parseChapterTaskPackage('请写下一章', {
      projectId: 'project',
      nextChapterIndex: 4
    })

    expect(task.target_words).toBe(3500)
  })

  it('infers plain-text chapter index, target length and revision intent', () => {
    const task = parseChapterTaskPackage('请修改第十二章，目标 4200 字，第一人称，必须包含旧信。', {
      projectId: 'project',
      nextChapterIndex: 9
    })

    expect(task.chapter_index).toBe(12)
    expect(task.target_words).toBe(4200)
    expect(task.pov).toBe('第一人称')
    expect(task.is_revision).toBe(true)
  })

  it('binds an implicit revision to the currently selected chapter', () => {
    const task = parseChapterTaskPackage('请润色当前章，保留剧情走向', {
      projectId: 'project',
      nextChapterIndex: 4,
      currentChapterId: 'chapter-2',
      currentChapterIndex: 2
    })

    expect(task.chapter_id).toBe('chapter-2')
    expect(task.chapter_index).toBe(2)
    expect(task.is_revision).toBe(true)
  })

  it('keeps a next-chapter request as a create even when a chapter is selected', () => {
    const task = parseChapterTaskPackage('请写下一章', {
      projectId: 'project',
      nextChapterIndex: 4,
      currentChapterId: 'chapter-2',
      currentChapterIndex: 2
    })

    expect(task.chapter_id).toBeNull()
    expect(task.chapter_index).toBe(4)
    expect(task.is_revision).toBe(false)
  })

  it('binds explicit current-chapter wording even without a revision verb', () => {
    const task = parseChapterTaskPackage('请续写当前章', {
      projectId: 'project', nextChapterIndex: 4, currentChapterId: 'chapter-2', currentChapterIndex: 2
    })
    expect(task).toMatchObject({ chapter_id: 'chapter-2', chapter_index: 2, is_revision: true })
  })

  it('does not treat a reference chapter as the write target of a next-chapter request', () => {
    const task = parseChapterTaskPackage('请写下一章，承接第三章结尾', {
      projectId: 'project', nextChapterIndex: 4, currentChapterId: 'chapter-3', currentChapterIndex: 3
    })
    expect(task).toMatchObject({ chapter_id: null, chapter_index: 4, is_revision: false })
  })

  it('keeps the current chapter target when the next chapter is only continuity context', () => {
    const task = parseChapterTaskPackage('请润色当前章，让结尾衔接下一章', {
      projectId: 'project', nextChapterIndex: 4, currentChapterId: 'chapter-2', currentChapterIndex: 2
    })
    expect(task).toMatchObject({ chapter_id: 'chapter-2', chapter_index: 2, is_revision: true })
  })

  it('ignores a negated next-chapter action and keeps the explicit current target', () => {
    const task = parseChapterTaskPackage('不要写下一章，只改当前章', {
      projectId: 'project', nextChapterIndex: 4, currentChapterId: 'chapter-2', currentChapterIndex: 2
    })
    expect(task).toMatchObject({ chapter_id: 'chapter-2', chapter_index: 2, is_revision: true })
  })

  it('treats the current chapter as a reference when a numbered chapter is the rewrite target', () => {
    const task = parseChapterTaskPackage('参考当前章的语气，重写第三章', {
      projectId: 'project', nextChapterIndex: 4, currentChapterId: 'chapter-2', currentChapterIndex: 2
    })
    expect(task).toMatchObject({ chapter_id: null, chapter_index: 3, is_revision: true })
  })
})

describe('chapter pipeline memory prompt formatting', () => {
  it('keeps the newest tail of long accumulated memories', () => {
    const text = `${'基础设定'.repeat(180)}最新变化：开始怀疑师父。`
    const formatted = truncateMemoryText(text, 900)
    expect(formatted.length).toBeLessThanOrEqual(900)
    expect(formatted).toContain('基础设定')
    expect(formatted).toContain('最新变化：开始怀疑师父。')
  })
})

describe('chapter pipeline role assignment', () => {
  it('honors explicit routing role before keyword inference', () => {
    expect(inferChapterPipelineRole(member({
      name: '万能主笔',
      role: '写手',
      routing_rules: JSON.stringify({ pipeline_role: 'critic' })
    }))).toBe('critic')
  })

  it('maps available members to required pipeline roles with fallbacks', () => {
    const planner = member({ agent_id: 'planner', name: '剧情规划师', role: 'Plot Planner', turn_order: 0 })
    const writer = member({ agent_id: 'writer', name: '正文主笔', role: 'Draft Writer', turn_order: 1 })
    const editor = member({ agent_id: 'editor', name: '风格编辑', role: 'Style Editor', turn_order: 2 })
    const critic = member({ agent_id: 'critic', name: '质检审稿', role: 'Critic', turn_order: 3 })

    const assignments = resolvePipelineAssignments([writer, critic, planner, editor])

    expect(assignments.plot_planner.agent_id).toBe('planner')
    expect(assignments.draft_writer.agent_id).toBe('writer')
    expect(assignments.style_editor.agent_id).toBe('editor')
    expect(assignments.critic.agent_id).toBe('critic')
    expect(assignments.scene_architect.agent_id).toBe('planner')
    expect(assignments.revision_integrator.agent_id).toBe('editor')
  })
})

describe('toChineseChapterNumeral', () => {
  it('converts arabic chapter numbers to Chinese', () => {
    expect(toChineseChapterNumeral(1)).toBe('一')
    expect(toChineseChapterNumeral(6)).toBe('六')
    expect(toChineseChapterNumeral(10)).toBe('十')
    expect(toChineseChapterNumeral(12)).toBe('十二')
    expect(toChineseChapterNumeral(20)).toBe('二十')
    expect(toChineseChapterNumeral(105)).toBe('一百零五')
  })
})

describe('composeCreatedChapterTitle', () => {
  it('always produces a numbered title', () => {
    expect(composeCreatedChapterTitle('选拔赛风云', 6)).toBe('第六章 选拔赛风云')
    expect(composeCreatedChapterTitle('边界条件探索', 7)).toBe('第七章 边界条件探索')
  })

  it('renumbers a model title that already carries a chapter label', () => {
    expect(composeCreatedChapterTitle('第五章 选拔赛风云', 6)).toBe('第六章 选拔赛风云')
  })

  it('does not turn a body sentence into the whole title', () => {
    expect(composeCreatedChapterTitle('傍晚的404寝室，泡面味混着烟味', 1)).toBe('第一章 傍晚的404寝室')
  })

  it('falls back to a bare numbered title when no usable topic exists', () => {
    expect(composeCreatedChapterTitle('', 3)).toBe('第三章')
    expect(composeCreatedChapterTitle('标题：', 3)).toBe('第三章')
  })
})

describe('ensureNumberedChapterTitle', () => {
  it('adds a chapter number when the existing title has none', () => {
    expect(ensureNumberedChapterTitle('选拔赛风云与降维打击', 5)).toBe('第五章 选拔赛风云与降维打击')
  })

  it('keeps a title that already carries a chapter number', () => {
    expect(ensureNumberedChapterTitle('第五章 选拔赛风云与降维打击', 5)).toBe('第五章 选拔赛风云与降维打击')
    expect(ensureNumberedChapterTitle('第6章 边界条件探索', 6)).toBe('第6章 边界条件探索')
  })
})

describe('isRetryablePipelineError', () => {
  it('retries transient stall / timeout / network / rate-limit errors', () => {
    expect(isRetryablePipelineError('Agent 已 120 秒没有继续输出，已中断本次调用')).toBe(true)
    expect(isRetryablePipelineError('Agent 在 90 秒内没有输出，已中断本次调用')).toBe(true)
    expect(isRetryablePipelineError('request timeout')).toBe(true)
    expect(isRetryablePipelineError('fetch failed: ECONNRESET')).toBe(true)
    expect(isRetryablePipelineError('429 Too Many Requests')).toBe(true)
    expect(isRetryablePipelineError('503 Service Unavailable overloaded')).toBe(true)
  })

  it('does not retry deterministic/config errors', () => {
    expect(isRetryablePipelineError('Agent「主笔」的工具配置不是合法 JSON')).toBe(false)
    expect(isRetryablePipelineError('最终章节篇幅不足：当前约 100 字')).toBe(false)
    expect(isRetryablePipelineError('正文质量检查未通过: 标点异常')).toBe(false)
  })
})

describe('chapter pipeline memory patch normalization', () => {
  it('normalizes flexible memory patch shapes', () => {
    const patch = normalizeMemoryPatch({
      timeline_events: ['主角在雨夜发现旧信'],
      character_updates: [{ name: '林照', update: '开始怀疑师父。' }],
      foreshadowing_updates: [{ content: '旧信署名异常', status: 'planted' }],
      new_facts: [{ subject: '十年前旧案', content: '师父隐瞒了旧案的一部分。', memory_type: 'story_bible' }],
      style_notes: '压抑、克制',
      next_chapter_seed: '主角追查母亲旧名。'
    }, 'fallback summary')

    expect(patch.chapter_summary).toBe('fallback summary')
    expect(patch.timeline_events[0]).toMatchObject({ content: '主角在雨夜发现旧信' })
    expect(patch.character_updates[0]).toMatchObject({ subject: '林照', content: '开始怀疑师父。' })
    expect(patch.foreshadowing_updates[0]).toMatchObject({ subject: '旧信署名异常', status: 'planted' })
    expect(patch.new_facts[0].metadata?.memory_type).toBe('story_bible')
    expect(patch.style_notes).toEqual(['压抑', '克制'])
    expect(patch.next_chapter_seed).toBe('主角追查母亲旧名。')
  })

  it('captures the chapter end state for next-chapter continuity', () => {
    const patch = normalizeMemoryPatch({
      chapter_end_state: '林照锁门离开402实验室，手里拿着ThinkPad，凌晨走在空走廊。'
    }, 'fallback summary')

    expect(patch.chapter_end_state).toBe('林照锁门离开402实验室，手里拿着ThinkPad，凌晨走在空走廊。')
  })

  it('leaves chapter_end_state undefined when not provided', () => {
    const patch = normalizeMemoryPatch({}, 'fallback summary')
    expect(patch.chapter_end_state).toBeUndefined()
  })
})

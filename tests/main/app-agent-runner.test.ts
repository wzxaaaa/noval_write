import { describe, expect, it } from 'vitest'
import {
  getChapterTargetPolicy,
  getTaskIntent,
  isAnaphoricInstruction,
  parseAgentDecision,
  prepareActionsForExecution,
  resolveIntentSourceText,
  shouldRequireAction,
  shouldStopAfterActionRound
} from '../../src/main/services/actions/app-agent-runner'

describe('app-agent-runner', () => {
  it('parses MiniMax tool-call style output into app actions', () => {
    const content = [
      '好嘞！让我先读取一下当前的大纲，了解整本小说的结构。',
      '<minimax:tool_call>',
      '< name: "get_project_context"',
      '< id: "null"',
      '< label: "null"',
      '< version: "null"',
      '< disabled: "null"',
      '< }',
      '< name: "read_outline"',
      '< id: "null"',
      '< type: "outline"',
      '< title: "null"',
      '< }',
      '< name: "list_chapters"',
      '< id: "null"',
      '< }'
    ].join('\n')

    const decision = parseAgentDecision(content)

    expect(decision?.actions).toEqual([
      { name: 'get_project_context', input: {} },
      { name: 'read_outline', input: { type: 'outline' } },
      { name: 'list_chapters', input: {} }
    ])
    expect(decision?.say).toBe('好嘞！让我先读取一下当前的大纲，了解整本小说的结构。')
    expect(decision?.done).toBe(false)
  })

  it('parses OpenAI-style tool_calls JSON', () => {
    const content = JSON.stringify({
      tool_calls: [
        {
          type: 'function',
          function: {
            name: 'read_outline',
            arguments: '{"type":"detailed"}'
          }
        }
      ],
      message: ''
    })

    expect(parseAgentDecision(content)?.actions).toEqual([
      { name: 'read_outline', input: { type: 'detailed' } }
    ])
  })

  it('parses generic XML tool_use output', () => {
    const content = [
      '我先读取细纲。',
      '<tool_use>',
      '<name>read_outline</name>',
      '<input>{"type":"detailed"}</input>',
      '</tool_use>'
    ].join('\n')

    const decision = parseAgentDecision(content)

    expect(decision?.actions).toEqual([
      { name: 'read_outline', input: { type: 'detailed' } }
    ])
    expect(decision?.say).toBe('我先读取细纲。')
  })

  it('parses bracket tool syntax used by other local agents', () => {
    const content = [
      '[TOOL: resolve_chapter ]',
      'reference: 第二章',
      '[/ TOOL]'
    ].join('\n')

    expect(parseAgentDecision(content)?.actions).toEqual([
      { name: 'resolve_chapter', input: { reference: '第二章' } }
    ])
  })

  it('parses function-style action calls from permissive models', () => {
    const content = 'read_outline({"type":"outline"})'

    expect(parseAgentDecision(content)?.actions).toEqual([
      { name: 'read_outline', input: { type: 'outline' } }
    ])
  })

  it('normalizes proxy JSON operation output into a chapter proposal action', () => {
    const content = JSON.stringify({
      success: true,
      operation: 'replace_text',
      target_id: '5bdcb5b5-5f68-422c-be4c-577c06f3b59b',
      new_text: '林辰把书合上，终于松了口气。'
    })

    expect(parseAgentDecision(content)?.actions).toEqual([
      {
        name: 'propose_chapter_edit',
        input: {
          chapterId: '5bdcb5b5-5f68-422c-be4c-577c06f3b59b',
          content: '林辰把书合上，终于松了口气。',
          mode: 'replace'
        }
      }
    ])
  })

  it('normalizes write_chapter tool JSON and keeps confirmation unless direct write is requested', () => {
    const decision = parseAgentDecision(JSON.stringify({
      tool: 'write_chapter',
      chapter_id: 'chapter-1',
      content: '雨声从窗缝里挤进来。'
    }))

    expect(decision?.actions).toEqual([
      {
        name: 'update_chapter_content',
        input: {
          chapterId: 'chapter-1',
          content: '雨声从窗缝里挤进来。'
        }
      }
    ])

    const intent = getTaskIntent('小漫把你改好的放进去')
    expect(prepareActionsForExecution(decision?.actions ?? [], intent)).toEqual([
      {
        name: 'propose_chapter_edit',
        input: {
          chapterId: 'chapter-1',
          content: '雨声从窗缝里挤进来。'
        }
      }
    ])
  })

  it('recovers tool calls from JSON-ish proxy output with unescaped quotes in chapter text', () => {
    const content = [
      '```json',
      '{',
      '  "tool": "write_chapter",',
      '  "chapter_id": "chapter-1",',
      '  "content": "草稿纸中间留下几个大字："底层规则 映射推导"，笔力透纸。"',
      '}',
      '```'
    ].join('\n')

    expect(parseAgentDecision(content)?.actions).toEqual([
      {
        name: 'update_chapter_content',
        input: {
          chapterId: 'chapter-1',
          content: '草稿纸中间留下几个大字："底层规则 映射推导"，笔力透纸。'
        }
      }
    ])
  })

  it('requires actions for outline planning requests', () => {
    expect(shouldRequireAction('小漫，帮我规划一下前十章的细纲吧')).toBe(true)
  })

  it('treats anti-AI-flavor requests as chapter body rewrite actions', () => {
    const intent = getTaskIntent('小漫，帮当前章祛味，去掉AI味和模板感')

    expect(shouldRequireAction('小漫，帮当前章祛味，去掉AI味和模板感')).toBe(true)
    expect(intent.bodyWriting).toBe(true)
    expect(intent.outlineOnly).toBe(false)
  })

  it('treats vague web-novel polish requests as current chapter body edits', () => {
    const request = '小漫，其实专业术语没必要这么多，毕竟咱们写的是网络小说。你看着帮忙处理一下'
    const intent = getTaskIntent(request)

    expect(shouldRequireAction(request)).toBe(true)
    expect(intent.bodyWriting).toBe(true)
    expect(intent.outlineOnly).toBe(false)
  })

  it('treats follow-up placement wording as a chapter body action', () => {
    const request = '小漫把你改好的放进去'
    const intent = getTaskIntent(request)

    expect(shouldRequireAction(request)).toBe(true)
    expect(intent.bodyWriting).toBe(true)
  })

  it('keeps next-scene design as advice instead of a write action', () => {
    const request = '请基于当前章节末尾设计下一场戏，给我一个 6 拍细纲'
    const intent = getTaskIntent(request)

    expect(shouldRequireAction(request)).toBe(false)
    expect(intent.bodyWriting).toBe(false)
  })

  it('still treats writing the next scene as chapter body writing', () => {
    const request = '请续写下一场正文'
    const intent = getTaskIntent(request)

    expect(shouldRequireAction(request)).toBe(true)
    expect(intent.bodyWriting).toBe(true)
  })

  it('requires target resolution for a numbered chapter request', () => {
    expect(getTaskIntent('请润色第二章').requiresResolvedChapterTarget).toBe(true)
    expect(getTaskIntent('请润色当前章').requiresResolvedChapterTarget).toBe(false)
  })

  it('keeps an explicit current chapter as the write target when another chapter is referenced', () => {
    const intent = getTaskIntent('参考第二章的伏笔，润色当前章')
    expect(intent.targetsCurrentChapter).toBe(true)
    expect(intent.requiresResolvedChapterTarget).toBe(false)
    expect(prepareActionsForExecution([
      { name: 'propose_chapter_edit', input: { chapterId: 'chapter-2', content: 'new current content' } }
    ], intent)).toEqual([
      { name: 'propose_chapter_edit', input: { content: 'new current content' } }
    ])
  })

  it('keeps a numbered chapter target when the current chapter is only a reference', () => {
    const intent = getTaskIntent('参考当前章的语气，重写第三章')
    expect(intent.targetsCurrentChapter).toBe(false)
    expect(intent.requiresResolvedChapterTarget).toBe(true)
    expect(prepareActionsForExecution([
      { name: 'propose_chapter_edit', input: { chapterId: 'chapter-3', content: 'new third chapter' } }
    ], intent)).toEqual([
      { name: 'propose_chapter_edit', input: { chapterId: 'chapter-3', content: 'new third chapter' } }
    ])
  })

  it('does not clear chapter context for read-only numbered chapter consultation', () => {
    const request = '分析第二章哪里拖沓，只给建议'
    const intent = getTaskIntent(request)

    expect(shouldRequireAction(request)).toBe(false)
    expect(intent.requiresResolvedChapterTarget).toBe(true)
    expect(getChapterTargetPolicy(false, intent)).toBe('preserve')
  })

  it('allows explicit direct-save wording to keep update_chapter_content', () => {
    const intent = getTaskIntent('小漫，把这版直接保存到正文，不用确认')

    expect(prepareActionsForExecution([
      { name: 'update_chapter_content', input: { chapterId: 'chapter-1', content: '最终正文' } }
    ], intent)).toEqual([
      { name: 'update_chapter_content', input: { chapterId: 'chapter-1', content: '最终正文' } }
    ])
  })

  it('does not treat negated direct-write wording as authorization', () => {
    const intent = getTaskIntent('润色当前章，但不要直接保存到正文，也不要入库')

    expect(intent.directWrite).toBe(false)
    expect(prepareActionsForExecution([
      { name: 'update_chapter_content', input: { chapterId: 'chapter-1', content: '修改后正文' } }
    ], intent)[0]?.name).toBe('propose_chapter_edit')
  })

  it('keeps outline-only planning away from chapter body actions', () => {
    const intent = getTaskIntent('小漫，帮我规划一下前十章的细纲吧')

    expect(prepareActionsForExecution([
      { name: 'get_project_context', input: {} },
      { name: 'upsert_outline', input: { type: 'detailed_outline', title: '前十章细纲：入职培训篇', content: '第一章：入职培训。' } },
      { name: 'list_chapters', input: {} },
      { name: 'propose_chapter_edit', input: { title: '第一章', content: '误写进正文的内容' } },
      { name: 'open_panel', input: { panel: 'chat' } }
    ], intent)).toEqual([
      { name: 'get_project_context', input: {} },
      { name: 'upsert_outline', input: { type: 'detailed', title: '前十章细纲：入职培训篇', content: '第一章：入职培训。' } },
      { name: 'open_panel', input: { panel: 'outline' } }
    ])
  })

  it('infers detailed outline type when permissive models omit type', () => {
    const intent = getTaskIntent('请制定前十章细纲')

    expect(prepareActionsForExecution([
      { name: 'upsert_outline', input: { title: '前十章细纲', content: '1. 入职培训' } },
      { name: 'read_outline', input: { type: 'null', title: '前十章细纲' } }
    ], intent)).toEqual([
      { name: 'upsert_outline', input: { type: 'detailed', title: '前十章细纲', content: '1. 入职培训' } },
      { name: 'read_outline', input: { type: 'detailed', title: '前十章细纲' } }
    ])
  })

  it('stops outline-only loops after a successful outline write', () => {
    const intent = getTaskIntent('帮我规划前十章细纲')

    expect(shouldStopAfterActionRound(intent, [], [
      { id: '1', name: 'upsert_outline', ok: true, message: '已写入细纲「前十章细纲」' }
    ])).toBe(true)
  })

  it('waits for both artifacts when outline and detailed outline are requested', () => {
    const intent = getTaskIntent('先创建一个大纲，然后把前十章细纲也写好')
    const outlineResult = {
      id: '1', name: 'upsert_outline', ok: true, message: 'saved', data: { type: 'outline' }
    }
    const detailedResult = {
      id: '2', name: 'upsert_outline', ok: true, message: 'saved', data: { type: 'detailed' }
    }

    expect(shouldStopAfterActionRound(intent, [], [outlineResult])).toBe(false)
    expect(shouldStopAfterActionRound(intent, [outlineResult], [detailedResult])).toBe(true)
  })

  it('does not stop after writing the wrong outline type', () => {
    const intent = getTaskIntent('请只写前十章细纲')
    expect(shouldStopAfterActionRound(intent, [], [
      { id: '1', name: 'upsert_outline', ok: true, message: 'saved wrong type', data: { type: 'outline' } }
    ])).toBe(false)
  })
})

describe('resolveIntentSourceText', () => {
  const msgs = (items: Array<['user' | 'assistant', string]>) =>
    items.map(([role, content]) => ({ role, content }))

  it('普通指令只用最后一条用户消息', () => {
    const out = resolveIntentSourceText(msgs([
      ['user', '帮我写第一章正文'],
      ['assistant', '好的'],
      ['user', '再给我列三个书名备选']
    ]))
    expect(out).toBe('再给我列三个书名备选')
  })

  it('短指代拼上上一条用户消息一起判断', () => {
    const out = resolveIntentSourceText(msgs([
      ['user', '帮我把第三章润色一下，去掉AI味'],
      ['assistant', '这是润色方案……'],
      ['user', '就按刚才说的做']
    ]))
    expect(out).toContain('第三章润色')
    expect(out).toContain('就按刚才说的做')
  })

  it('纯确认（好的/开始吧）也回看上文', () => {
    const out = resolveIntentSourceText(msgs([
      ['user', '把这版放入第二章正文'],
      ['assistant', '需要我现在写入吗？'],
      ['user', '开始吧']
    ]))
    expect(shouldRequireAction(out)).toBe(true)
  })

  it('最后一条不是用户消息时返回空串', () => {
    expect(resolveIntentSourceText(msgs([['user', 'a'], ['assistant', 'b']]))).toBe('')
  })
})

describe('isAnaphoricInstruction', () => {
  it('识别指代词', () => {
    expect(isAnaphoricInstruction('就按刚才说的做')).toBe(true)
    expect(isAnaphoricInstruction('把上面那版放进去')).toBe(true)
  })

  it('识别纯确认', () => {
    expect(isAnaphoricInstruction('好的')).toBe(true)
    expect(isAnaphoricInstruction('开始吧')).toBe(true)
  })

  it('完整指令不触发回看', () => {
    expect(isAnaphoricInstruction('帮我把第三章润色一下')).toBe(false)
    expect(isAnaphoricInstruction('中国四大名著是什么')).toBe(false)
  })
})

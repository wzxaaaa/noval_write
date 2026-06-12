import { describe, expect, it } from 'vitest'
import {
  getTaskIntent,
  parseAgentDecision,
  prepareActionsForExecution,
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

  it('requires actions for outline planning requests', () => {
    expect(shouldRequireAction('小漫，帮我规划一下前十章的细纲吧')).toBe(true)
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
})

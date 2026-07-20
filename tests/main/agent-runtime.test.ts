import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanToolSyntax, parseAgentToolCalls, shouldAbortAgentRun, streamWithWatchdog } from '../../src/main/services/agent/agent-runtime'

afterEach(() => {
  vi.useRealTimers()
})

describe('agent runtime tool syntax', () => {
  it('parses tool tags with spaces around the tool name', () => {
    const content = [
      '[TOOL: read_outline] [/TOOL]',
      '[TOOL: list_knowledge] [/TOOL]',
      '[TOOL: search_chapters] 猝死入职 [/TOOL]'
    ].join('\n')

    expect(parseAgentToolCalls(content)).toEqual([
      { tool: 'read_outline', input: '' },
      { tool: 'list_knowledge', input: '' },
      { tool: 'search_chapters', input: '猝死入职' }
    ])
  })

  it('parses lowercase tool tags and strips them from visible content', () => {
    const content = [
      '我先读取上下文。',
      '[tool : READ_OUTLINE]',
      'type: detailed',
      '[/ tool]',
      '接下来继续。'
    ].join('\n')

    expect(parseAgentToolCalls(content)).toEqual([
      { tool: 'read_outline', input: 'type: detailed' }
    ])
    expect(cleanToolSyntax(content)).toBe('我先读取上下文。\n\n接下来继续。')
  })

  it('recognizes tool results that should abort the current agent run', () => {
    expect(shouldAbortAgentRun({ abortAgentRun: true, reason: 'worker_timeout' })).toBe(true)
    expect(shouldAbortAgentRun({ abortAgentRun: false })).toBe(false)
    expect(shouldAbortAgentRun(null)).toBe(false)
  })

  it('interrupts a stream that never emits tokens', async () => {
    vi.useFakeTimers()
    let underlyingSignal: AbortSignal | null = null
    const promise = streamWithWatchdog(
      (signal) => {
        underlyingSignal = signal
        return new Promise<void>(() => {})
      },
      {
        getOutputLength: () => 0,
        firstTokenTimeoutMs: 100,
        idleTimeoutMs: 1000,
        totalTimeoutMs: 5000
      }
    )
    const assertion = expect(promise).rejects.toThrow('没有输出')

    await vi.advanceTimersByTimeAsync(1200)

    await assertion
    expect(underlyingSignal?.aborted).toBe(true)
  })

  it('interrupts a stream that becomes idle after partial output', async () => {
    vi.useFakeTimers()
    let outputLength = 1
    const promise = streamWithWatchdog(
      () => new Promise<void>(() => {}),
      {
        getOutputLength: () => outputLength,
        firstTokenTimeoutMs: 1000,
        idleTimeoutMs: 100,
        totalTimeoutMs: 5000
      }
    )
    const assertion = expect(promise).rejects.toThrow('没有继续输出')

    await vi.advanceTimersByTimeAsync(1200)
    outputLength = 1
    await vi.advanceTimersByTimeAsync(1200)

    await assertion
  })

  it('interrupts a stream when the abort signal fires', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const promise = streamWithWatchdog(
      () => new Promise<void>(() => {}),
      {
        getOutputLength: () => 0,
        firstTokenTimeoutMs: 5000,
        idleTimeoutMs: 5000,
        totalTimeoutMs: 5000,
        signal: controller.signal
      }
    )
    const assertion = expect(promise).rejects.toThrow('工作流已被用户停止')

    controller.abort()

    await assertion
  })

  it('interrupts a stream when custom degeneration guard fires', async () => {
    vi.useFakeTimers()
    const promise = streamWithWatchdog(
      () => new Promise<void>(() => {}),
      {
        getOutputLength: () => 100,
        getAbortReason: () => 'Agent 输出重复退化：短语连续重复',
        firstTokenTimeoutMs: 1000,
        idleTimeoutMs: 1000,
        totalTimeoutMs: 5000
      }
    )
    const assertion = expect(promise).rejects.toThrow('重复退化')

    await vi.advanceTimersByTimeAsync(1200)

    await assertion
  })
})

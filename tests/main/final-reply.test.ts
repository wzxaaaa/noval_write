import { describe, expect, it } from 'vitest'
import { composeFinalReply } from '../../src/main/services/actions/app-agent-runner'
import type { AppActionResult } from '../../src/shared/appActions'

const result = (name: string, message: string, ok = true): AppActionResult =>
  ({ id: name, name, ok, message } as AppActionResult)

/**
 * 回归：调用动作后，收尾逻辑只取 summarizeActionResults()，
 * 用户看到的永远是「已创建章节XX」这类机器状态行，
 * 模型真正想说的内容（判断、要点、下一步建议）被整个丢掉。
 */
describe('composeFinalReply', () => {
  it('模型的话是主体，动作状态附在后面', () => {
    const out = composeFinalReply(
      '我把第三章按三幕结构拆了，中段冲突留给你确认。',
      [result('create_chapter', '已创建章节《第三章》')]
    )
    expect(out).toBe('我把第三章按三幕结构拆了，中段冲突留给你确认。\n\n已创建章节《第三章》')
  })

  it('模型没说话时退回动作状态', () => {
    expect(composeFinalReply('', [result('create_chapter', '已创建章节《第三章》')]))
      .toBe('已创建章节《第三章》')
    expect(composeFinalReply(undefined, [result('create_chapter', '已创建章节《第三章》')]))
      .toBe('已创建章节《第三章》')
  })

  it('没有动作时只返回模型的话', () => {
    expect(composeFinalReply('这个我不太建议这么写。', [])).toBe('这个我不太建议这么写。')
  })

  it('模型已经把状态写进正文时不重复贴', () => {
    const out = composeFinalReply(
      '已创建章节《第三章》，我按三幕结构拆的。',
      [result('create_chapter', '已创建章节《第三章》')]
    )
    expect(out).toBe('已创建章节《第三章》，我按三幕结构拆的。')
  })

  it('多条状态里只要有一条没提到就整体附上', () => {
    const out = composeFinalReply(
      '已创建章节《第三章》。',
      [result('create_chapter', '已创建章节《第三章》'), result('upsert_outline', '已更新细纲')]
    )
    expect(out).toContain('已更新细纲')
  })

  it('两边都空时返回空串，交给调用方兜底', () => {
    expect(composeFinalReply('', [])).toBe('')
    expect(composeFinalReply('   ', [])).toBe('')
  })
})

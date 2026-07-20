import { describe, expect, it } from 'vitest'
import { isConversationalProbe, shouldRequireAction } from '../../src/main/services/actions/app-agent-runner'

/**
 * 回归用例来源：给"目标"正则加入"小说"之后，所有含「写…小说」的闲聊
 * 都被误判成写入指令，用户问"你愿意写小说吗"会拿到
 * "我这次没有成功调用软件动作"这句死胡同回复。
 */
describe('shouldRequireAction — 闲聊不能被当成操作指令', () => {
  const conversational = [
    '你愿意写小说吗',
    '你会写小说吗',
    '你喜欢写小说吗',
    '你能不能写小说',
    '你觉得写小说难吗',
    '你介意写这种题材吗',
    '写小说最重要的是什么',
    '我想跟你聊聊小说',
    '什么是网文的钩子',
    '为什么我的小说没人看',
    '网文的开头怎么写'
  ]

  it.each(conversational)('「%s」应走对话路径', text => {
    expect(shouldRequireAction(text)).toBe(false)
  })
})

describe('shouldRequireAction — 真正的操作指令仍然要触发动作', () => {
  const actionable = [
    '帮我写一部小说',
    '用番茄风格写这一章',
    '把这段放进正文',
    '帮我把大纲整理一下',
    '续写当前章节',
    '创建一个新章节',
    // 带问号但明确要求落到软件里的，仍然是动作
    '把这段放进去好吗'
  ]

  it.each(actionable)('「%s」应走动作路径', text => {
    expect(shouldRequireAction(text)).toBe(true)
  })
})

describe('isConversationalProbe', () => {
  it('疑问句尾', () => {
    expect(isConversationalProbe('你在吗')).toBe(true)
    expect(isConversationalProbe('这样对吧')).toBe(true)
    expect(isConversationalProbe('真的？')).toBe(true)
  })

  it('征询意愿与能力', () => {
    expect(isConversationalProbe('你愿不愿意帮我')).toBe(true)
    expect(isConversationalProbe('能不能换个风格')).toBe(true)
  })

  it('明确要求写入的不算闲聊，即使带问号', () => {
    expect(isConversationalProbe('把这段放进去好吗')).toBe(false)
    expect(isConversationalProbe('帮我写入正文好吗')).toBe(false)
  })

  it('祈使句不算闲聊', () => {
    expect(isConversationalProbe('创建一个新章节')).toBe(false)
    expect(isConversationalProbe('续写当前章节')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { normalizeAssistantContent, sanitizeChatMessages, trimChatHistoryByBudget, type ChatMessageLike } from '../../src/shared/chatMessages'

const user = (content: string): ChatMessageLike => ({ role: 'user', content })
const assistant = (content: string): ChatMessageLike => ({ role: 'assistant', content })
const system = (content: string): ChatMessageLike => ({ role: 'system', content })

describe('sanitizeChatMessages', () => {
  // 实际线上报错：400 Invalid request: the message at position 8
  // with role 'assistant' must not be empty
  it('清掉历史里混入的空 assistant 消息', () => {
    const history = [
      user('1'), assistant('2'), user('3'), assistant('4'),
      user('5'), assistant('6'), user('7'), assistant('8'),
      assistant(''),
      user('请帮我完整细化这个大纲')
    ]
    const out = sanitizeChatMessages(history)
    expect(out.every(message => message.content.trim() !== '')).toBe(true)
  })

  it('只有空白字符也算空', () => {
    expect(sanitizeChatMessages([user('a'), assistant('   \n\t ')])).toHaveLength(1)
  })

  it('清掉空消息后不会留下连续同角色', () => {
    const out = sanitizeChatMessages([user('a'), assistant(''), user('b')])
    expect(out.map(message => message.role)).toEqual(['user'])
    expect(out[0].content).toBe('a\n\nb')
  })

  it('强制 user / assistant 交替', () => {
    const out = sanitizeChatMessages([user('a'), user('b'), assistant('c'), assistant('d'), user('e')])
    expect(out.map(message => message.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('合并时不丢内容', () => {
    expect(sanitizeChatMessages([user('a'), user('b')])[0].content).toBe('a\n\nb')
  })

  it('system 消息全部保留在最前面', () => {
    const out = sanitizeChatMessages([system('s1'), system('s2'), user('a'), assistant('b')])
    expect(out.slice(0, 2).map(message => message.role)).toEqual(['system', 'system'])
  })

  it('丢掉开头抢跑的 assistant，首条对话必须是 user', () => {
    const out = sanitizeChatMessages([assistant('抢跑'), user('a'), assistant('b')])
    expect(out[0].role).toBe('user')
  })

  it('正常对话原样返回', () => {
    const history = [system('s'), user('a'), assistant('b'), user('c')]
    expect(sanitizeChatMessages(history)).toEqual(history)
  })

  it('边界输入不炸', () => {
    expect(sanitizeChatMessages([])).toEqual([])
    expect(sanitizeChatMessages(null as never)).toEqual([])
    expect(sanitizeChatMessages([assistant(''), user('  ')])).toEqual([])
  })
})

describe('normalizeAssistantContent', () => {
  it('空内容返回 null，调用方据此跳过落库', () => {
    expect(normalizeAssistantContent('')).toBeNull()
    expect(normalizeAssistantContent('   ')).toBeNull()
    expect(normalizeAssistantContent(null)).toBeNull()
    expect(normalizeAssistantContent(undefined)).toBeNull()
  })

  it('非空内容原样返回，不裁掉有意义的首尾空白', () => {
    expect(normalizeAssistantContent(' x ')).toBe(' x ')
  })
})

describe('trimChatHistoryByBudget', () => {
  it('预算内的历史原样返回', () => {
    const history = [system('s'), user('a'), assistant('b'), user('c')]
    expect(trimChatHistoryByBudget(history, 1000)).toEqual(history)
  })

  it('超出预算时从最旧的对话消息开始丢，system 全保留', () => {
    const old = user('旧'.repeat(500))
    const recent = [assistant('中'.repeat(100)), user('新问题')]
    const out = trimChatHistoryByBudget([system('规则'), old, ...recent], 250)
    expect(out[0].role).toBe('system')
    expect(out).not.toContainEqual(old)
    expect(out[out.length - 1].content).toBe('新问题')
  })

  it('最后一条消息即使单条超预算也保留', () => {
    const huge = user('长'.repeat(9999))
    const out = trimChatHistoryByBudget([user('旧'), huge], 10)
    expect(out).toEqual([huge])
  })

  it('边界输入不炸', () => {
    expect(trimChatHistoryByBudget([], 100)).toEqual([])
    expect(trimChatHistoryByBudget(null as never, 100)).toEqual([])
  })
})

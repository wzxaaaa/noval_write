const HANDLED_WRITE_ACTIONS = new Set([
  'create_chapter',
  'propose_chapter_edit',
  'update_chapter_content',
  'upsert_outline'
])

export function shouldAutoApplyAssistantDraft(userInstruction: string, result?: unknown): boolean {
  if (hasSuccessfulHandledWriteAction(result)) return false
  if (isOutlineOnlyInstruction(userInstruction)) return false
  return hasBodyWritingIntent(userInstruction)
}

export function isOutlineOnlyInstruction(text: string): boolean {
  const compact = normalizeIntentText(text)
  if (!compact) return false

  return hasOutlineIntent(compact) && !hasBodyWritingIntent(compact)
}

export function hasBodyWritingIntent(text: string): boolean {
  const compact = normalizeIntentText(text)
  if (!compact) return false

  const vagueBodyEdit = /处理一下|处理下|改一下|改下|调整一下|调整下|优化一下|优化下|精简|简化|删掉|少点|少一点|别太多|不要太多|没必要这么多|专业术语|术语|网文|网络小说|口语化|读起来更顺|更自然|更像人写|改好的|这版|这一版|刚才那版|上面那版|放进去|放进来/.test(compact)

  return /正文|小说正文|章节正文|成稿|正文稿|最终稿|续写|润色|祛味|去掉ai味|去ai味|去ai感|去机器味|去模板感|改写|重写|扩写|补写|开篇|开头|写开头|写一段|放入正文|放到正文|放进正文|替换正文|更新正文/.test(compact) ||
    /(?:写|续写|生成|完成|创作).{0,4}(?:下一场|下一幕)|(?:下一场|下一幕).{0,6}(?:正文|写出来|成稿)/.test(compact) ||
    /(?:完成|写|创作|生成|补全|续写|润色|祛味|去掉ai味|去ai味|去ai感|去机器味|去模板感|改写|重写|扩写).{0,8}第[零〇一二两三四五六七八九十百千万\d]+章/.test(compact) ||
    /第[零〇一二两三四五六七八九十百千万\d]+章.{0,8}(?:正文|成稿|写完|完成|续写|润色|祛味|去掉ai味|去ai味|去ai感|去机器味|去模板感|改写|重写|扩写)/.test(compact) ||
    vagueBodyEdit
}

function hasOutlineIntent(compact: string): boolean {
  return /大纲|细纲|纲要|提纲|卷纲|分卷|分章|章节规划|章节拆解|故事梗概|剧情梗概|总体结构|整体结构|主线结构|六卷结构|三幕结构|章数|总字数|总篇幅/.test(compact)
}

function hasSuccessfulHandledWriteAction(result: unknown): boolean {
  if (!isRecord(result) || !Array.isArray(result.actionResults)) return false

  return result.actionResults.some(action => {
    if (!isRecord(action) || action.ok !== true || typeof action.name !== 'string') return false
    return HANDLED_WRITE_ACTIONS.has(action.name)
  })
}

function normalizeIntentText(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

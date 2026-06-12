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

  return /正文|小说正文|章节正文|成稿|正文稿|最终稿|续写|润色|改写|重写|扩写|补写|下一场|下一幕|开篇|开头|写开头|写一段|放入正文|放到正文|放进正文|替换正文|更新正文/.test(compact) ||
    /(?:完成|写|创作|生成|补全|续写|润色|改写|重写|扩写).{0,8}第[零〇一二两三四五六七八九十百千万\d]+章/.test(compact) ||
    /第[零〇一二两三四五六七八九十百千万\d]+章.{0,8}(?:正文|成稿|写完|完成|续写|润色|改写|重写|扩写)/.test(compact)
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
  return text.replace(/\s+/g, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

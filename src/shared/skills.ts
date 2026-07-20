/**
 * 技能（Skill）共享定义。
 *
 * 技能是一份用户导入的写作方法论：一个包含 SKILL.md 的文件夹、zip 包，
 * 或者单个 markdown 文件。导入后可以挂载给小漫（对话 Agent）或写作团队
 * （九个岗位共享），其正文会作为额外规则注入 system prompt。
 */

/** 可以挂载技能的目标。 */
export type SkillTarget = 'xiaoman' | 'writingTeam'

export const SKILL_TARGETS: SkillTarget[] = ['xiaoman', 'writingTeam']

export const SKILL_TARGET_LABELS: Record<SkillTarget, string> = {
  xiaoman: '小漫',
  writingTeam: '写作团队'
}

export const SKILL_TARGET_HINTS: Record<SkillTarget, string> = {
  xiaoman: '注入侧边栏对话助手',
  writingTeam: '注入九个写作岗位'
}

/** 技能来源类型。 */
export type SkillSourceKind = 'folder' | 'zip' | 'markdown'

export interface SkillRecord {
  id: string
  name: string
  description: string
  version: string
  /** 安装目录（userData/skills/<id>），删除时整目录移除。 */
  install_path: string
  /** 相对 install_path 的主文件路径，通常是 SKILL.md。 */
  entry_file: string
  source_kind: SkillSourceKind
  /** 用户选择的原始路径，仅作展示。 */
  source_label: string
  content_chars: number
  /** JSON 字符串数组：可被 Agent 按需读取的子文档相对路径。 */
  doc_paths: string
  installed_at: string
}

/** 技能挂载关系：每个目标挂载的 skill id 列表。 */
export type SkillBindings = Record<SkillTarget, string[]>

export const EMPTY_SKILL_BINDINGS: SkillBindings = {
  xiaoman: [],
  writingTeam: []
}

export function normalizeSkillBindings(value: unknown): SkillBindings {
  const source = isRecord(value) ? value : {}
  const normalized: SkillBindings = { xiaoman: [], writingTeam: [] }

  for (const target of SKILL_TARGETS) {
    const raw = source[target]
    if (!Array.isArray(raw)) continue
    const seen = new Set<string>()
    for (const item of raw) {
      if (typeof item !== 'string') continue
      const id = item.trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      normalized[target].push(id)
    }
  }

  return normalized
}

/**
 * 单个技能被注入 prompt 时的最大字符数。
 * 40000 足够放下社区里最长的方法论技能（writing-novel 约 3 万字符）而不截断。
 */
export const SKILL_INJECTION_CHAR_LIMIT = 40000

/**
 * 一个挂载目标上所有技能的合计上限。
 * 超出后不再拼接后续技能，并在块尾注明被跳过的技能名，
 * 避免用户把六个技能全挂上去时静默撑爆 context。
 */
export const SKILL_INJECTION_TOTAL_CHAR_LIMIT = 100000

/** 提示词里每个技能最多列出多少个子文档路径。 */
export const SKILL_DOC_LIST_LIMIT = 40

export interface SkillFrontmatter {
  name?: string
  description?: string
  version?: string
}

/**
 * 解析 SKILL.md 顶部的 YAML frontmatter。
 *
 * 只处理技能包实际会用到的两种写法，不引入 YAML 依赖：
 * - 扁平的 `key: value`
 * - 块标量 `key: |` / `key: >`，后跟缩进的多行内容
 *
 * 顶层以外的缩进键（比如 `metadata:` 下的子键）会被忽略。
 */
export function parseSkillFrontmatter(content: string): {
  frontmatter: SkillFrontmatter
  body: string
} {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (!match) {
    return { frontmatter: {}, body: content.replace(/^﻿/, '') }
  }

  const frontmatter: SkillFrontmatter = {}
  const lines = match[1].split(/\r?\n/)

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    // 只认顶层键，缩进行要么属于块标量、要么是嵌套结构。
    if (/^\s/.test(line)) continue

    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!pair) continue

    const key = pair[1].toLowerCase()
    if (key !== 'name' && key !== 'description' && key !== 'version') continue

    const inline = pair[2].trim()
    let value: string

    if (inline === '|' || inline === '>' || /^[|>][-+]?$/.test(inline)) {
      // 块标量：吃掉后续所有缩进行，折叠式（>）用空格连接，字面式（|）保留换行。
      const folded = inline.startsWith('>')
      const blockLines: string[] = []
      while (index + 1 < lines.length && (/^\s+/.test(lines[index + 1]) || lines[index + 1].trim() === '')) {
        index++
        blockLines.push(lines[index].trim())
      }
      while (blockLines.length > 0 && blockLines[blockLines.length - 1] === '') blockLines.pop()
      value = blockLines.join(folded ? ' ' : '\n').trim()
    } else {
      value = stripQuotes(inline)
    }

    if (!value) continue
    if (key === 'name') frontmatter.name = value
    else if (key === 'description') frontmatter.description = value
    else if (key === 'version') frontmatter.version = value
  }

  return { frontmatter, body: content.slice(match[0].length) }
}

/**
 * 从技能正文推断展示信息：优先用 frontmatter，其次用一级标题和首段。
 */
export function deriveSkillMeta(content: string, fallbackName: string): {
  name: string
  description: string
  version: string
} {
  const { frontmatter, body } = parseSkillFrontmatter(content)

  const headingMatch = /^#\s+(.+)$/m.exec(body)
  const heading = headingMatch ? cleanInline(headingMatch[1]) : ''

  const firstParagraph = body
    .split(/\r?\n\s*\r?\n/)
    .map(block => block.trim())
    .find(block => block && !block.startsWith('#') && !block.startsWith('```') && !block.startsWith('|'))

  return {
    name: frontmatter.name?.trim() || heading || fallbackName,
    description: truncate(frontmatter.description?.trim() || cleanInline(firstParagraph ?? ''), 220),
    version: frontmatter.version?.trim() || ''
  }
}

/**
 * 把若干技能正文组装成注入 system prompt 的规则块。
 * 没有技能时返回空串，调用方据此跳过拼接。
 */
export function buildSkillPromptBlock(
  skills: Array<{ name: string; content: string; docPaths?: string[] }>,
  options: { docToolName?: string } = {}
): string {
  const usable = skills.filter(skill => skill.content.trim())
  if (usable.length === 0) return ''

  const sections: string[] = []
  const skipped: string[] = []
  let budget = SKILL_INJECTION_TOTAL_CHAR_LIMIT

  for (const skill of usable) {
    if (budget <= 0) {
      skipped.push(skill.name)
      continue
    }
    const body = truncate(
      stripSkillFrontmatter(skill.content).trim(),
      Math.min(SKILL_INJECTION_CHAR_LIMIT, budget)
    )
    budget -= body.length

    const docs = (skill.docPaths ?? []).slice(0, SKILL_DOC_LIST_LIMIT)
    const docList = docs.length > 0
      ? `\n<docs>\n${docs.join('\n')}\n</docs>`
      : ''

    sections.push(`<skill name="${escapeAttribute(skill.name)}">\n${body}${docList}\n</skill>`)
  }

  if (skipped.length > 0) {
    sections.push(`（以下技能因总长度超限未被载入，请到设置里取消挂载或精简：${skipped.join('、')}）`)
  }

  const hasDocs = usable.some(skill => (skill.docPaths?.length ?? 0) > 0)
  const docHint = hasDocs && options.docToolName
    ? `\n\n技能里的 <docs> 列出了该技能附带的子文档。主文档提到"详见某某.md"时，用 ${options.docToolName} 读取对应文件再执行，不要凭印象猜内容。只在确实需要那一步的细节时才读，不要一次性全读。`
    : ''

  return `【已挂载写作技能 — 必须遵守】
下面是用户为你挂载的写作方法论。它们的优先级高于你的默认写作习惯，但低于用户在对话中的当前指令。
如果多个技能之间有冲突，以排在后面的技能为准；如果技能与用户当前要求冲突，以用户要求为准。
技能里描述的流程、格式和检查清单，凡是适用于当前任务的，都要实际执行，不要只是嘴上认同。${docHint}

${sections.join('\n\n')}`
}

export function stripSkillFrontmatter(content: string): string {
  return parseSkillFrontmatter(content).body
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

function cleanInline(value: string): string {
  return value
    .replace(/[*_`#>]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n\n……技能内容过长，已截断……`
}

function escapeAttribute(value: string): string {
  return value.replace(/"/g, "'").replace(/[\r\n]+/g, ' ')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

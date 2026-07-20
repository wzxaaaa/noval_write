import { readdir, readFile, stat } from 'fs/promises'
import { extname, join, relative, resolve, sep } from 'path'
import type { SkillRecord, SkillTarget } from '../../../shared/skills'
import { skillRepo } from '../../db/repositories/skill.repo'

/** 单次读取子文档返回给模型的最大字符数。 */
const MAX_DOC_CHARS = 20000
/** 清单里最多列出的子文档数量，避免提示词被文件名撑满。 */
export const MAX_LISTED_DOCS = 40
/** 可以被模型读取的子文档扩展名。 */
const READABLE_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml'])

export interface SkillDocRef {
  skillId: string
  skillName: string
  /** 相对技能安装目录的路径，统一用正斜杠。 */
  path: string
}

/**
 * 扫描技能安装目录，列出模型可读的子文档（不含主文件 SKILL.md）。
 * 安装时调用一次并落库，避免每轮对话都去遍历磁盘。
 */
export async function scanSkillDocs(installPath: string, entryFile: string): Promise<string[]> {
  const found: string[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6 || found.length >= 200) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (found.length >= 200) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!READABLE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue

      const rel = relative(installPath, full).split(sep).join('/')
      if (rel === entryFile.split(sep).join('/')) continue
      found.push(rel)
    }
  }

  await walk(installPath, 0)
  return found.sort()
}

/** 汇总某个挂载目标下所有技能的可读子文档，供提示词展示。 */
export function listSkillDocsForTarget(target: SkillTarget): SkillDocRef[] {
  let skills: SkillRecord[]
  try {
    skills = skillRepo.getBoundSkills(target)
  } catch {
    return []
  }

  const refs: SkillDocRef[] = []
  for (const skill of skills) {
    for (const path of parseDocPaths(skill.doc_paths)) {
      refs.push({ skillId: skill.id, skillName: skill.name, path })
    }
  }
  return refs
}

/**
 * 读取某个挂载技能下的一份子文档。
 *
 * 只接受落库时登记过的相对路径——这一步同时挡住了 `../` 穿越和绝对路径，
 * 因为攻击者构造的路径根本不在清单里。读取前还会再做一次目录归属校验，
 * 防止数据库被改写后越权读到技能目录以外的文件。
 */
export async function readSkillDoc(
  target: SkillTarget,
  docPath: string,
  skillHint?: string
): Promise<{ ok: true; skillName: string; path: string; content: string } | { ok: false; message: string }> {
  const normalized = normalizeRequestedPath(docPath)
  if (!normalized) {
    return { ok: false, message: '文档路径不合法。请使用技能清单里列出的相对路径。' }
  }

  let skills: SkillRecord[]
  try {
    skills = skillRepo.getBoundSkills(target)
  } catch {
    return { ok: false, message: '当前没有可用的技能。' }
  }
  if (skills.length === 0) {
    return { ok: false, message: '当前没有挂载任何技能，没有可读的子文档。' }
  }

  const candidates = skillHint
    ? skills.filter(skill => matchesSkill(skill, skillHint))
    : skills
  const searchPool = candidates.length > 0 ? candidates : skills

  for (const skill of searchPool) {
    const registered = parseDocPaths(skill.doc_paths)
    const hit = registered.find(path => path === normalized || path.toLowerCase() === normalized.toLowerCase())
    if (!hit) continue

    const targetPath = resolve(join(skill.install_path, ...hit.split('/')))
    if (!isInside(skill.install_path, targetPath)) {
      return { ok: false, message: '拒绝读取技能目录以外的文件。' }
    }

    try {
      const fileStat = await stat(targetPath)
      if (!fileStat.isFile()) {
        return { ok: false, message: `「${hit}」不是一个文件。` }
      }
      const raw = await readFile(targetPath, 'utf8')
      const content = raw.length > MAX_DOC_CHARS
        ? `${raw.slice(0, MAX_DOC_CHARS)}\n\n……文档过长已截断，如需后续内容请说明要看哪一部分……`
        : raw
      return { ok: true, skillName: skill.name, path: hit, content }
    } catch {
      return { ok: false, message: `读取「${hit}」失败，文件可能已被删除。` }
    }
  }

  const available = searchPool
    .flatMap(skill => parseDocPaths(skill.doc_paths).map(path => `${skill.name}/${path}`))
    .slice(0, 20)
  return {
    ok: false,
    message: available.length > 0
      ? `没有找到「${docPath}」。可读的子文档有：\n${available.join('\n')}`
      : `没有找到「${docPath}」，当前挂载的技能没有附带子文档。`
  }
}

export function parseDocPaths(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/** 归一化模型给的路径：去掉前导斜杠、反斜杠转正斜杠、拒绝穿越片段。 */
function normalizeRequestedPath(input: string): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
  if (!trimmed) return null
  if (/^[A-Za-z]:/.test(trimmed)) return null
  const segments = trimmed.split('/')
  if (segments.some(segment => segment === '..' || segment === '' || segment === '.')) return null
  return segments.join('/')
}

function matchesSkill(skill: SkillRecord, hint: string): boolean {
  const needle = hint.trim().toLowerCase()
  if (!needle) return false
  return skill.id === hint ||
    skill.name.toLowerCase() === needle ||
    skill.name.toLowerCase().includes(needle) ||
    needle.includes(skill.name.toLowerCase())
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), candidate)
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(`..${sep}`)
}

import { getDb } from '../connection'
import { settingsRepo } from './settings.repo'
import {
  EMPTY_SKILL_BINDINGS,
  normalizeSkillBindings,
  SKILL_TARGETS,
  type SkillBindings,
  type SkillRecord,
  type SkillSourceKind,
  type SkillTarget
} from '../../../shared/skills'

const BINDINGS_KEY = 'skill_bindings'

export interface SkillCreate {
  id: string
  name: string
  description?: string
  version?: string
  install_path: string
  entry_file: string
  source_kind: SkillSourceKind
  source_label?: string
  content_chars?: number
  doc_paths?: string[]
}

export class SkillRepo {
  create(params: SkillCreate): SkillRecord {
    getDb().prepare(
      `INSERT INTO skills
        (id, name, description, version, install_path, entry_file, source_kind, source_label, content_chars, doc_paths)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      params.id,
      params.name,
      params.description ?? '',
      params.version ?? '',
      params.install_path,
      params.entry_file,
      params.source_kind,
      params.source_label ?? '',
      params.content_chars ?? 0,
      JSON.stringify(params.doc_paths ?? [])
    )
    return this.getById(params.id)!
  }

  getById(id: string): SkillRecord | undefined {
    return getDb().prepare('SELECT * FROM skills WHERE id = ?').get(id) as SkillRecord | undefined
  }

  list(): SkillRecord[] {
    return getDb()
      .prepare('SELECT * FROM skills ORDER BY datetime(installed_at) DESC')
      .all() as SkillRecord[]
  }

  rename(id: string, name: string): void {
    const trimmed = name.trim()
    if (!trimmed) return
    getDb().prepare('UPDATE skills SET name = ? WHERE id = ?').run(trimmed, id)
  }

  delete(id: string): void {
    getDb().prepare('DELETE FROM skills WHERE id = ?').run(id)
    // 同步摘掉挂载关系，避免留下指向已删除技能的悬空 id。
    const bindings = this.getBindings()
    let changed = false
    for (const target of SKILL_TARGETS) {
      const next = bindings[target].filter(skillId => skillId !== id)
      if (next.length !== bindings[target].length) {
        bindings[target] = next
        changed = true
      }
    }
    if (changed) this.setBindings(bindings)
  }

  getBindings(): SkillBindings {
    const stored = normalizeSkillBindings(settingsRepo.getJson(BINDINGS_KEY))
    const existingIds = new Set(this.list().map(skill => skill.id))
    return {
      xiaoman: stored.xiaoman.filter(id => existingIds.has(id)),
      writingTeam: stored.writingTeam.filter(id => existingIds.has(id))
    }
  }

  setBindings(bindings: SkillBindings): SkillBindings {
    const existingIds = new Set(this.list().map(skill => skill.id))
    const normalized = normalizeSkillBindings(bindings)
    const safe: SkillBindings = {
      xiaoman: normalized.xiaoman.filter(id => existingIds.has(id)),
      writingTeam: normalized.writingTeam.filter(id => existingIds.has(id))
    }
    settingsRepo.set(BINDINGS_KEY, safe)
    return safe
  }

  /** 返回挂载到某个目标的技能记录，保持用户设置的顺序。 */
  getBoundSkills(target: SkillTarget): SkillRecord[] {
    const ids = this.getBindings()[target] ?? EMPTY_SKILL_BINDINGS[target]
    if (ids.length === 0) return []
    const byId = new Map(this.list().map(skill => [skill.id, skill]))
    return ids
      .map(id => byId.get(id))
      .filter((skill): skill is SkillRecord => skill !== undefined)
  }
}

export const skillRepo = new SkillRepo()

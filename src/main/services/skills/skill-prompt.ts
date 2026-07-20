import { buildSkillPromptBlock, type SkillTarget } from '../../../shared/skills'
import { skillRepo } from '../../db/repositories/skill.repo'
import { readSkillContent } from './skill-installer'
import { parseDocPaths } from './skill-docs'

/** 两条链路调用子文档的方式不同，提示词里要写各自的名字。 */
const DOC_TOOL_NAMES: Record<SkillTarget, string> = {
  xiaoman: 'read_skill_doc 动作',
  writingTeam: '[TOOL:read_skill_doc] 相对路径 [/TOOL]'
}

/**
 * 读取挂载到某个目标的全部技能，拼成可直接追加到 system prompt 的规则块。
 * 没有挂载技能、或技能文件读不到时返回空串，调用方直接跳过拼接。
 */
export async function buildSkillPromptForTarget(target: SkillTarget): Promise<string> {
  let skills: ReturnType<typeof skillRepo.getBoundSkills>
  try {
    skills = skillRepo.getBoundSkills(target)
  } catch {
    return ''
  }
  if (skills.length === 0) return ''

  const loaded = await Promise.all(
    skills.map(async skill => ({
      name: skill.name,
      content: await readSkillContent(skill),
      docPaths: parseDocPaths(skill.doc_paths)
    }))
  )

  return buildSkillPromptBlock(loaded, { docToolName: DOC_TOOL_NAMES[target] })
}

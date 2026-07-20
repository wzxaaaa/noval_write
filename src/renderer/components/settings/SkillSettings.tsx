import React from 'react'
import {
  EMPTY_SKILL_BINDINGS,
  SKILL_TARGETS,
  SKILL_TARGET_HINTS,
  SKILL_TARGET_LABELS,
  type SkillBindings,
  type SkillRecord,
  type SkillTarget
} from '../../../shared/skills'

const SOURCE_LABELS: Record<SkillRecord['source_kind'], string> = {
  folder: '文件夹',
  zip: '压缩包',
  markdown: '单文件'
}

function formatChars(chars: number): string {
  if (chars >= 10000) return `${(chars / 10000).toFixed(1)} 万字符`
  if (chars >= 1000) return `${(chars / 1000).toFixed(1)}k 字符`
  return `${chars} 字符`
}

export function SkillSettings() {
  const [skills, setSkills] = React.useState<SkillRecord[]>([])
  const [bindings, setBindings] = React.useState<SkillBindings>(EMPTY_SKILL_BINDINGS)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [loaded, setLoaded] = React.useState(false)

  const refresh = React.useCallback(async () => {
    const [nextSkills, nextBindings] = await Promise.all([
      window.electronAPI.skill.list(),
      window.electronAPI.skill.getBindings()
    ])
    setSkills(nextSkills)
    setBindings(nextBindings)
  }, [])

  React.useEffect(() => {
    void refresh()
      .catch(err => setError((err as Error).message || '读取技能列表失败'))
      .finally(() => setLoaded(true))
  }, [refresh])

  const handleImport = async (properties: Array<'openFile' | 'openDirectory'>) => {
    setError(null)
    const files = await window.electronAPI.file.openFileDialog({
      properties,
      filters: properties.includes('openFile')
        ? [{ name: '技能包', extensions: ['zip', 'md', 'markdown', 'txt'] }]
        : undefined
    })
    const sourcePath = files?.[0]
    if (!sourcePath) return

    setBusy(true)
    try {
      await window.electronAPI.skill.import(sourcePath)
      await refresh()
    } catch (err) {
      setError((err as Error).message || '导入技能失败')
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (skill: SkillRecord) => {
    if (!window.confirm(`删除技能「${skill.name}」？挂载关系会一并移除。`)) return
    setBusy(true)
    setError(null)
    try {
      await window.electronAPI.skill.delete(skill.id)
      await refresh()
    } catch (err) {
      setError((err as Error).message || '删除技能失败')
    } finally {
      setBusy(false)
    }
  }

  const toggleBinding = async (target: SkillTarget, skillId: string) => {
    const current = bindings[target]
    const next: SkillBindings = {
      ...bindings,
      [target]: current.includes(skillId)
        ? current.filter(id => id !== skillId)
        : [...current, skillId]
    }

    setBindings(next)
    setError(null)
    try {
      setBindings(await window.electronAPI.skill.setBindings(next))
    } catch (err) {
      setError((err as Error).message || '保存挂载设置失败')
      await refresh().catch(() => {})
    }
  }

  return (
    <div className="skill-settings">
      <section className="settings-section">
        <div className="settings-section-header">
          <h3>技能</h3>
          {busy && <span>处理中...</span>}
        </div>
        <p className="skill-intro">
          导入写作方法论后勾选挂载目标，技能正文会作为额外规则加入对应 Agent 的提示词。
        </p>
        <div className="skill-import-actions">
          <button disabled={busy} onClick={() => void handleImport(['openDirectory'])}>
            导入文件夹
          </button>
          <button disabled={busy} onClick={() => void handleImport(['openFile'])}>
            导入压缩包 / 单文件
          </button>
        </div>
        {error && <div className="skill-error">{error}</div>}
      </section>

      <section className="settings-section">
        <div className="settings-section-header">
          <h3>已安装</h3>
          <span>{skills.length > 0 ? `${skills.length} 个` : ''}</span>
        </div>

        {!loaded ? (
          <div className="skill-empty">正在读取...</div>
        ) : skills.length === 0 ? (
          <div className="skill-empty">
            还没有技能。选一个包含 SKILL.md 的文件夹，或者一个技能压缩包。
          </div>
        ) : (
          <ul className="skill-list">
            {skills.map(skill => (
              <li key={skill.id} className="skill-item">
                <div className="skill-item-main">
                  <div className="skill-item-head">
                    <span className="skill-item-name">{skill.name}</span>
                    {skill.version && <span className="skill-item-version">v{skill.version}</span>}
                    <span className="skill-item-source">{SOURCE_LABELS[skill.source_kind]}</span>
                    <span className="skill-item-source" title="技能正文长度，越长占用的上下文越多">
                      {formatChars(skill.content_chars)}
                    </span>
                  </div>
                  {skill.description && (
                    <p className="skill-item-desc">{skill.description}</p>
                  )}
                  <div className="skill-item-targets">
                    {SKILL_TARGETS.map(target => {
                      const checked = bindings[target].includes(skill.id)
                      return (
                        <button
                          key={target}
                          type="button"
                          className={`skill-target-chip${checked ? ' active' : ''}`}
                          title={SKILL_TARGET_HINTS[target]}
                          aria-pressed={checked}
                          disabled={busy}
                          onClick={() => void toggleBinding(target, skill.id)}
                        >
                          {SKILL_TARGET_LABELS[target]}
                        </button>
                      )
                    })}
                  </div>
                </div>
                <button
                  type="button"
                  className="skill-item-delete"
                  title="删除该技能"
                  aria-label={`删除 ${skill.name}`}
                  disabled={busy}
                  onClick={() => void handleDelete(skill)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

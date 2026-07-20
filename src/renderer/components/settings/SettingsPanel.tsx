import React from 'react'
import { ProviderConfigContent } from '../ai/ProviderConfig'
import { AppearanceSettings } from './AppearanceSettings'
import { SkillSettings } from './SkillSettings'
import { ModalDialog } from '../common/ModalDialog'

export type SettingsTab = 'api' | 'appearance' | 'skills'

interface SettingsPanelProps {
  mode: 'modal' | 'panel'
  initialTab?: SettingsTab
  onClose: () => void
}

export function SettingsPanel({ mode, initialTab = 'appearance', onClose }: SettingsPanelProps) {
  const [activeTab, setActiveTab] = React.useState<SettingsTab>(initialTab)
  const settingsBody = (
    <>
      <div className="settings-tabs" aria-label="设置分类">
        <button
          type="button"
          aria-pressed={activeTab === 'appearance'}
          className={activeTab === 'appearance' ? 'active' : ''}
          onClick={() => setActiveTab('appearance')}
        >
          外观
        </button>
        <button
          type="button"
          aria-pressed={activeTab === 'api'}
          className={activeTab === 'api' ? 'active' : ''}
          onClick={() => setActiveTab('api')}
        >
          模型 / API
        </button>
        <button
          type="button"
          aria-pressed={activeTab === 'skills'}
          className={activeTab === 'skills' ? 'active' : ''}
          onClick={() => setActiveTab('skills')}
        >
          技能
        </button>
      </div>
      <div className="settings-content">
        {activeTab === 'appearance' && <AppearanceSettings />}
        {activeTab === 'api' && <ProviderConfigContent />}
        {activeTab === 'skills' && <SkillSettings />}
      </div>
    </>
  )

  if (mode === 'modal') {
    return (
      <ModalDialog title="设置" onClose={onClose} className="settings-modal">
        <div className="settings-shell settings-shell-modal">
          {settingsBody}
        </div>
      </ModalDialog>
    )
  }

  return (
    <div className="settings-shell settings-shell-panel">
      <div className="modal-header settings-header">
        <h2>设置</h2>
        <button type="button" onClick={onClose} aria-label="关闭设置">✕</button>
      </div>
      {settingsBody}
    </div>
  )
}

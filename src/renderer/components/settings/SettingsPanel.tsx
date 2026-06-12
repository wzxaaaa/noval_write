import React from 'react'
import { ProviderConfigContent } from '../ai/ProviderConfig'
import { AppearanceSettings } from './AppearanceSettings'

export type SettingsTab = 'api' | 'appearance'

interface SettingsPanelProps {
  mode: 'modal' | 'panel'
  initialTab?: SettingsTab
  onClose: () => void
}

export function SettingsPanel({ mode, initialTab = 'appearance', onClose }: SettingsPanelProps) {
  const [activeTab, setActiveTab] = React.useState<SettingsTab>(initialTab)
  const content = (
    <div className={`settings-shell settings-shell-${mode}`}>
      <div className="modal-header settings-header">
        <h2>设置</h2>
        <button onClick={onClose}>✕</button>
      </div>
      <div className="settings-tabs">
        <button className={activeTab === 'appearance' ? 'active' : ''} onClick={() => setActiveTab('appearance')}>
          外观
        </button>
        <button className={activeTab === 'api' ? 'active' : ''} onClick={() => setActiveTab('api')}>
          模型 / API
        </button>
      </div>
      <div className="settings-content">
        {activeTab === 'appearance' ? <AppearanceSettings /> : <ProviderConfigContent />}
      </div>
    </div>
  )

  if (mode === 'modal') {
    return (
      <div className="modal-overlay">
        <div className="modal settings-modal">
          {content}
        </div>
      </div>
    )
  }

  return content
}

import React, { useState } from 'react'
import { AppShell } from './components/layout/AppShell'
import { Sidebar } from './components/layout/Sidebar'
import { StatusBar } from './components/layout/StatusBar'
import { NovelEditor } from './components/editor/NovelEditor'
import { ChatPanel } from './components/ai/ChatPanel'
import { AgentPanel } from './components/agent/AgentPanel'
import { KnowledgePanel } from './components/knowledge/KnowledgePanel'
import { OutlinePanel } from './components/outline/OutlinePanel'
import { AgentConfigForm } from './components/agent/AgentConfigForm'
import { ProjectManager } from './components/project/ProjectManager'
import type { AppUIEffect } from '../shared/appActions'
import { SettingsPanel, type SettingsTab } from './components/settings/SettingsPanel'
import { useUIStore } from './stores/ui.store'
import type { AppearanceSettings } from '../shared/appearance'
import { emitAgentChapterProposal } from './lib/agentProposal'

type Panel = 'chat' | 'agent' | 'knowledge' | 'outline' | 'none'

export default function App() {
  const [activePanel, setActivePanel] = useState<Panel>('chat')
  const [showSettings, setShowSettings] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('appearance')
  const [showAgentConfig, setShowAgentConfig] = useState(false)
  const [showProjectManager, setShowProjectManager] = useState(true)
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)
  const [currentChapterId, setCurrentChapterId] = useState<string | null>(null)
  const appearance = useUIStore(s => s.appearance)
  const setAppearance = useUIStore(s => s.setAppearance)
  const hasImageBackground = appearance.backgroundType === 'image' && Boolean(appearance.backgroundImageUrl)

  React.useEffect(() => {
    window.electronAPI.settings.getAppearance().then(setAppearance).catch(() => {})
  }, [setAppearance])

  const handleSelectProject = (id: string, chapterId: string | null = null) => {
    setCurrentProjectId(id)
    setCurrentChapterId(chapterId)
    setShowProjectManager(false)
  }

  const handleProjectDeleted = React.useCallback((id: string) => {
    if (id === currentProjectId) {
      setCurrentProjectId(null)
      setCurrentChapterId(null)
    }
  }, [currentProjectId])

  const openSettings = React.useCallback((tab: SettingsTab = 'appearance') => {
    setSettingsInitialTab(tab)
    setShowSettings(true)
  }, [])

  const handleAgentUIEffect = React.useCallback((effect: AppUIEffect) => {
    switch (effect.type) {
      case 'open_panel':
        if (effect.panel === 'settings') {
          openSettings('appearance')
        } else {
          setActivePanel(effect.panel)
        }
        break
      case 'select_chapter':
        setCurrentChapterId(effect.chapterId)
        break
      case 'chapter_proposal':
        emitAgentChapterProposal({
          chapterId: effect.chapterId,
          html: effect.html,
          oldHtml: effect.oldHtml,
          sourceName: effect.sourceName || '小漫正文提案'
        })
        setCurrentChapterId(effect.chapterId)
        break
      case 'refresh_chapters':
        window.dispatchEvent(new CustomEvent('noval:chapters-updated', { detail: { projectId: effect.projectId } }))
        break
      case 'chapter_updated':
        window.dispatchEvent(new CustomEvent('noval:chapter-updated', { detail: effect }))
        window.dispatchEvent(new CustomEvent('noval:chapters-updated', { detail: { projectId: effect.projectId } }))
        break
      case 'refresh_outlines':
        window.dispatchEvent(new CustomEvent('noval:outline-updated', {
          detail: {
            projectId: effect.projectId,
            types: effect.types
          }
        }))
        break
      case 'refresh_knowledge':
        window.dispatchEvent(new CustomEvent('noval:knowledge-updated', { detail: { projectId: effect.projectId } }))
        break
    }
  }, [openSettings])

  React.useEffect(() => {
    const unsubscribe = window.electronAPI.appAgent.onAction(event => {
      event.uiEffects?.forEach(handleAgentUIEffect)
    })

    return unsubscribe
  }, [handleAgentUIEffect])

  React.useEffect(() => {
    const handleAgentUIEffectEvent = (event: Event) => {
      handleAgentUIEffect((event as CustomEvent<AppUIEffect>).detail)
    }
    window.addEventListener('noval:agent-ui-effect', handleAgentUIEffectEvent)
    return () => window.removeEventListener('noval:agent-ui-effect', handleAgentUIEffectEvent)
  }, [handleAgentUIEffect])

  return (
    <div
      className={`app-root theme-${appearance.theme} ${hasImageBackground ? 'has-appearance-image' : ''}`}
      style={buildAppearanceStyle(appearance)}
    >
      <AppShell
        sidebar={
          <Sidebar
            activePanel={activePanel}
            onPanelChange={setActivePanel}
            projectId={currentProjectId}
            onChapterSelect={setCurrentChapterId}
            currentChapterId={currentChapterId}
            onNewProject={() => setShowProjectManager(true)}
            onOpenSettings={() => openSettings('appearance')}
          />
        }
        main={
          currentProjectId ? (
            <NovelEditor
              chapterId={currentChapterId}
              projectId={currentProjectId}
              onSelectChapter={setCurrentChapterId}
            />
          ) : (
            <div className="welcome-screen">
              <h1>Noval Write</h1>
              <p>AI 驱动的智能小说编辑器</p>
              <button onClick={() => setShowProjectManager(true)}>
                开始创作
              </button>
            </div>
          )
        }
        panel={
          activePanel !== 'none' ? (
            <div className="right-panel">
              {activePanel === 'chat' && (
                <ChatPanel
                  projectId={currentProjectId}
                  chapterId={currentChapterId}
                  currentPanel={activePanel}
                  onOpenSettings={openSettings}
                  onChapterSelect={setCurrentChapterId}
                />
              )}
              {activePanel === 'agent' && (
                <AgentPanel
                  projectId={currentProjectId}
                  chapterId={currentChapterId}
                  onChapterSelect={setCurrentChapterId}
                  onOpenConfig={() => setShowAgentConfig(true)}
                />
              )}
              {activePanel === 'knowledge' && (
                <KnowledgePanel projectId={currentProjectId} />
              )}
              {activePanel === 'outline' && (
                <OutlinePanel projectId={currentProjectId} />
              )}
            </div>
          ) : null
        }
        statusBar={<StatusBar projectId={currentProjectId} chapterId={currentChapterId} />}
      />

      {showSettings && (
        <SettingsPanel
          mode="modal"
          initialTab={settingsInitialTab}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showAgentConfig && (
        <AgentConfigForm
          projectId={currentProjectId}
          onClose={() => setShowAgentConfig(false)}
        />
      )}

      {showProjectManager && (
        <ProjectManager
          onSelectProject={handleSelectProject}
          onProjectDeleted={handleProjectDeleted}
          onClose={() => setShowProjectManager(false)}
        />
      )}
    </div>
  )
}

function buildAppearanceStyle(appearance: AppearanceSettings): React.CSSProperties {
  const fit = appearance.backgroundFit
  const backgroundImage = appearance.backgroundType === 'image' && appearance.backgroundImageUrl
    ? `url("${appearance.backgroundImageUrl.replace(/"/g, '\\"')}")`
    : 'none'

  return {
    '--appearance-bg-color': appearance.backgroundColor,
    '--appearance-bg-image': backgroundImage,
    '--appearance-bg-opacity': String(appearance.backgroundOpacity),
    '--appearance-bg-blur': `${appearance.backgroundBlur}px`,
    '--appearance-bg-size': fit === 'repeat' ? 'auto' : fit,
    '--appearance-bg-repeat': fit === 'repeat' ? 'repeat' : 'no-repeat',
    '--appearance-surface-opacity': String(appearance.surfaceOpacity)
  } as React.CSSProperties
}

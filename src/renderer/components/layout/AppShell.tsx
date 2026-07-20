import React from 'react'
import { useUIStore } from '../../stores/ui.store'

interface AppShellProps {
  sidebar: React.ReactNode
  main: React.ReactNode
  panel: React.ReactNode | null
  panelVisible?: boolean
  statusBar: React.ReactNode
}

export function AppShell({ sidebar, main, panel, panelVisible = true, statusBar }: AppShellProps) {
  const { theme, sidebarWidth, panelWidth, focusMode } = useUIStore()

  return (
    <div className={`app-shell theme-${theme} ${focusMode ? 'focus-mode' : ''}`}>
      <div className="app-layout">
        <div className="app-sidebar" style={{ width: sidebarWidth }}>
          {sidebar}
        </div>
        <div className="app-main">
          {main}
        </div>
        {panel && (
          <div className="app-panel" style={{ width: panelVisible ? panelWidth : 0, display: panelVisible ? undefined : 'none' }}>
            {panel}
          </div>
        )}
      </div>
      <div className="app-statusbar">
        {statusBar}
      </div>
    </div>
  )
}

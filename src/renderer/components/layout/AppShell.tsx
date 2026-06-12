import React from 'react'
import { useUIStore } from '../../stores/ui.store'

interface AppShellProps {
  sidebar: React.ReactNode
  main: React.ReactNode
  panel: React.ReactNode | null
  statusBar: React.ReactNode
}

export function AppShell({ sidebar, main, panel, statusBar }: AppShellProps) {
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
          <div className="app-panel" style={{ width: panelWidth }}>
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

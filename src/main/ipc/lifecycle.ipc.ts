import { BrowserWindow, ipcMain } from 'electron'
import { assertTrustedIpcSender } from '../utils/approved-paths'

interface CloseState {
  approved: boolean
  waitingForRenderer: boolean
}

const closeStates = new WeakMap<BrowserWindow, CloseState>()

export function protectWindowClose(window: BrowserWindow): void {
  const state: CloseState = { approved: false, waitingForRenderer: false }
  closeStates.set(window, state)

  window.on('close', (event) => {
    if (state.approved) return
    if (window.webContents.isDestroyed() || window.webContents.isLoadingMainFrame()) return

    event.preventDefault()
    if (state.waitingForRenderer) return
    state.waitingForRenderer = true
    window.webContents.send('app:beforeClose')
  })
}

export function registerLifecycleHandlers(): void {
  ipcMain.handle('app:completeClose', (event, saved: boolean) => {
    assertTrustedIpcSender(event)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return

    const state = closeStates.get(window)
    if (!state) return
    state.waitingForRenderer = false

    if (saved) {
      state.approved = true
      setImmediate(() => {
        if (!window.isDestroyed()) window.close()
      })
    }
  })
}

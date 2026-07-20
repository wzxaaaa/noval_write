import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { initDatabase } from './db/connection'
import { registerAllHandlers } from './ipc'
import { protectWindowClose } from './ipc/lifecycle.ipc'
import { isTrustedRendererUrl } from './utils/approved-paths'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const packagedRendererUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).href
  const configuredRendererUrl = process.env.ELECTRON_RENDERER_URL
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    },
    title: '二维漫写 - AI 小说编辑器',
    show: false
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    try {
      const url = new URL(details.url)
      if (['http:', 'https:', 'mailto:'].includes(url.protocol)) {
        shell.openExternal(details.url)
      }
    } catch {
      // Ignore malformed external navigation requests.
    }
    return { action: 'deny' }
  })

  const guardNavigation = (event: Electron.Event, url: string): void => {
    if (isTrustedRendererUrl(url, configuredRendererUrl, packagedRendererUrl)) return

    event.preventDefault()
    try {
      const target = new URL(url)
      if (['http:', 'https:', 'mailto:'].includes(target.protocol)) {
        void shell.openExternal(url).catch(() => undefined)
      }
    } catch {
      // Ignore malformed navigation targets.
    }
  }

  mainWindow.webContents.on('will-navigate', guardNavigation)
  mainWindow.webContents.on('will-redirect', guardNavigation)
  protectWindowClose(mainWindow)

  if (configuredRendererUrl) {
    mainWindow.loadURL(configuredRendererUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  initDatabase()
  registerAllHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

import { app } from 'electron'
import { join } from 'path'

export function getUserDataPath(...segments: string[]): string {
  return join(app.getPath('userData'), ...segments)
}

export function getAppDataPath(...segments: string[]): string {
  return join(app.getPath('appData'), 'noval-write', ...segments)
}

export function getDefaultProjectPath(): string {
  return join(app.getPath('documents'), 'NovalWrite')
}

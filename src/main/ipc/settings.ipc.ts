import { app, ipcMain } from 'electron'
import { copyFile, mkdir, readFile, stat } from 'fs/promises'
import { extname, join } from 'path'
import {
  DEFAULT_APPEARANCE_SETTINGS,
  mergeAppearanceSettings,
  normalizeAppearanceSettings,
  type AppearanceSettings
} from '../../shared/appearance'
import { settingsRepo } from '../db/repositories/settings.repo'

const APPEARANCE_KEY = 'appearance'
const MAX_BACKGROUND_BYTES = 20 * 1024 * 1024
const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

export function registerSettingsHandlers(): void {
  ipcMain.handle('settings:getAppearance', async () => {
    return withImageUrl(readAppearance())
  })

  ipcMain.handle('settings:updateAppearance', async (_event, updates: Partial<AppearanceSettings>) => {
    const next = mergeAppearanceSettings(readAppearance(), updates)
    settingsRepo.set(APPEARANCE_KEY, stripRuntimeFields(next))
    return withImageUrl(next)
  })

  ipcMain.handle('settings:importBackgroundImage', async (_event, sourcePath: string) => {
    const importedPath = await importBackgroundImage(sourcePath)
    const next = mergeAppearanceSettings(readAppearance(), {
      backgroundType: 'image',
      backgroundImagePath: importedPath
    })
    settingsRepo.set(APPEARANCE_KEY, stripRuntimeFields(next))
    return withImageUrl(next)
  })

  ipcMain.handle('settings:clearBackgroundImage', async () => {
    const next = mergeAppearanceSettings(readAppearance(), {
      backgroundType: 'color',
      backgroundImagePath: null,
      backgroundImageUrl: null
    })
    settingsRepo.set(APPEARANCE_KEY, stripRuntimeFields(next))
    return withImageUrl(next)
  })
}

function readAppearance(): AppearanceSettings {
  return normalizeAppearanceSettings({
    ...DEFAULT_APPEARANCE_SETTINGS,
    ...settingsRepo.getJson<Partial<AppearanceSettings>>(APPEARANCE_KEY)
  })
}

async function importBackgroundImage(sourcePath: string): Promise<string> {
  const ext = extname(sourcePath).toLowerCase()
  if (!IMAGE_MIME[ext]) {
    throw new Error('请选择 jpg、png、webp 或 gif 图片')
  }

  const fileStat = await stat(sourcePath)
  if (!fileStat.isFile()) {
    throw new Error('请选择有效的图片文件')
  }
  if (fileStat.size > MAX_BACKGROUND_BYTES) {
    throw new Error('背景图片不能超过 20MB')
  }

  const dir = join(app.getPath('userData'), 'backgrounds')
  await mkdir(dir, { recursive: true })
  const targetPath = join(dir, `appearance-background-${Date.now()}${ext}`)
  await copyFile(sourcePath, targetPath)
  return targetPath
}

async function withImageUrl(settings: AppearanceSettings): Promise<AppearanceSettings> {
  if (!settings.backgroundImagePath) {
    return { ...settings, backgroundImageUrl: null }
  }

  try {
    const ext = extname(settings.backgroundImagePath).toLowerCase()
    const mime = IMAGE_MIME[ext]
    if (!mime) return { ...settings, backgroundImageUrl: null }
    const bytes = await readFile(settings.backgroundImagePath)
    return {
      ...settings,
      backgroundImageUrl: `data:${mime};base64,${bytes.toString('base64')}`
    }
  } catch {
    return { ...settings, backgroundImageUrl: null }
  }
}

function stripRuntimeFields(settings: AppearanceSettings): AppearanceSettings {
  return {
    ...settings,
    backgroundImageUrl: null
  }
}

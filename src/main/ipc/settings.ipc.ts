import { app, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { copyFile, mkdir, readFile, realpath, stat } from 'fs/promises'
import { extname, isAbsolute, join, relative } from 'path'
import {
  DEFAULT_APPEARANCE_SETTINGS,
  mergeAppearanceSettings,
  normalizeAppearanceSettings,
  type AppearanceSettings
} from '../../shared/appearance'
import { settingsRepo } from '../db/repositories/settings.repo'
import { assertTrustedIpcSender, consumeApprovedPath } from '../utils/approved-paths'

const APPEARANCE_KEY = 'appearance'
const MAX_BACKGROUND_BYTES = 20 * 1024 * 1024
const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

let backgroundImageCache: { path: string; size: number; mtimeMs: number; url: string } | null = null

export function registerSettingsHandlers(): void {
  ipcMain.handle('settings:getAppearance', async (event) => {
    assertTrustedIpcSender(event)
    return withImageUrl(readAppearance())
  })

  ipcMain.handle('settings:updateAppearance', async (event, updates: Partial<AppearanceSettings>) => {
    assertTrustedIpcSender(event)
    const next = mergeAppearanceSettings(readAppearance(), sanitizeAppearanceUpdates(updates))
    const safeNext = await withImageUrl(next)
    settingsRepo.set(APPEARANCE_KEY, stripRuntimeFields(safeNext))
    return safeNext
  })

  ipcMain.handle('settings:importBackgroundImage', async (event, sourcePath: string) => {
    assertTrustedIpcSender(event)
    const importedPath = await importBackgroundImage(sourcePath)
    const next = mergeAppearanceSettings(readAppearance(), {
      backgroundType: 'image',
      backgroundImagePath: importedPath
    })
    const safeNext = await withImageUrl(next)
    if (!safeNext.backgroundImagePath || !safeNext.backgroundImageUrl) {
      throw new Error('背景图片读取失败，请重新选择图片')
    }
    settingsRepo.set(APPEARANCE_KEY, stripRuntimeFields(safeNext))
    return safeNext
  })

  ipcMain.handle('settings:clearBackgroundImage', async (event) => {
    assertTrustedIpcSender(event)
    backgroundImageCache = null
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
  const approvedSourcePath = consumeApprovedPath(sourcePath, 'background-image')
  if (!approvedSourcePath) {
    throw new Error('Background image path was not selected by the user')
  }

  const ext = extname(approvedSourcePath).toLowerCase()
  if (!IMAGE_MIME[ext]) {
    throw new Error('请选择 jpg、png、webp 或 gif 图片')
  }

  const fileStat = await stat(approvedSourcePath)
  if (!fileStat.isFile()) {
    throw new Error('请选择有效的图片文件')
  }
  if (fileStat.size > MAX_BACKGROUND_BYTES) {
    throw new Error('背景图片不能超过 20MB')
  }

  const dir = join(app.getPath('userData'), 'backgrounds')
  await mkdir(dir, { recursive: true })
  const targetPath = join(dir, `appearance-background-${randomUUID()}${ext}`)
  await copyFile(approvedSourcePath, targetPath)
  backgroundImageCache = null
  return targetPath
}

async function withImageUrl(settings: AppearanceSettings): Promise<AppearanceSettings> {
  if (!settings.backgroundImagePath) {
    return { ...settings, backgroundImageUrl: null }
  }

  try {
    const managedPath = await getManagedBackgroundPath(settings.backgroundImagePath)
    if (!managedPath) {
      return { ...settings, backgroundImagePath: null, backgroundImageUrl: null }
    }

    const ext = extname(managedPath).toLowerCase()
    const mime = IMAGE_MIME[ext]
    if (!mime) return { ...settings, backgroundImageUrl: null }
    const fileStat = await stat(managedPath)
    if (!fileStat.isFile() || fileStat.size > MAX_BACKGROUND_BYTES) {
      return { ...settings, backgroundImagePath: null, backgroundImageUrl: null }
    }

    if (
      backgroundImageCache?.path === managedPath &&
      backgroundImageCache.size === fileStat.size &&
      backgroundImageCache.mtimeMs === fileStat.mtimeMs
    ) {
      return {
        ...settings,
        backgroundImagePath: managedPath,
        backgroundImageUrl: backgroundImageCache.url
      }
    }

    const bytes = await readFile(managedPath)
    const url = `data:${mime};base64,${bytes.toString('base64')}`
    backgroundImageCache = { path: managedPath, size: fileStat.size, mtimeMs: fileStat.mtimeMs, url }
    return {
      ...settings,
      backgroundImagePath: managedPath,
      backgroundImageUrl: url
    }
  } catch {
    return { ...settings, backgroundImagePath: null, backgroundImageUrl: null }
  }
}

async function getManagedBackgroundPath(candidatePath: string): Promise<string | null> {
  try {
    const managedDirectory = await realpath(join(app.getPath('userData'), 'backgrounds'))
    const candidate = await realpath(candidatePath)
    const relativePath = relative(managedDirectory, candidate)
    if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) return null
    return candidate
  } catch {
    return null
  }
}

export function sanitizeAppearanceUpdates(updates: Partial<AppearanceSettings>): Partial<AppearanceSettings> {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return {}

  const safe: Partial<AppearanceSettings> = {}
  if (updates.theme !== undefined) safe.theme = updates.theme
  if (updates.backgroundType !== undefined) safe.backgroundType = updates.backgroundType
  if (updates.backgroundColor !== undefined) safe.backgroundColor = updates.backgroundColor
  if (updates.backgroundOpacity !== undefined) safe.backgroundOpacity = updates.backgroundOpacity
  if (updates.backgroundBlur !== undefined) safe.backgroundBlur = updates.backgroundBlur
  if (updates.backgroundFit !== undefined) safe.backgroundFit = updates.backgroundFit
  if (updates.surfaceOpacity !== undefined) safe.surfaceOpacity = updates.surfaceOpacity
  return safe
}

function stripRuntimeFields(settings: AppearanceSettings): AppearanceSettings {
  return {
    ...settings,
    backgroundImageUrl: null
  }
}

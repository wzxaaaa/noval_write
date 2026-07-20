export type ThemeMode = 'dark' | 'light'
export type BackgroundType = 'color' | 'image'
export type BackgroundFit = 'cover' | 'contain' | 'repeat'

export interface AppearanceSettings {
  theme: ThemeMode
  backgroundType: BackgroundType
  backgroundColor: string
  backgroundImagePath: string | null
  backgroundImageUrl: string | null
  backgroundOpacity: number
  backgroundBlur: number
  backgroundFit: BackgroundFit
  surfaceOpacity: number
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  theme: 'light',
  backgroundType: 'color',
  backgroundColor: '#f6f7fb',
  backgroundImagePath: null,
  backgroundImageUrl: null,
  backgroundOpacity: 0.28,
  backgroundBlur: 0,
  backgroundFit: 'cover',
  surfaceOpacity: 0.94
}

export function normalizeAppearanceSettings(input: unknown): AppearanceSettings {
  const record = isRecord(input) ? input : {}
  return {
    theme: normalizeTheme(record.theme),
    backgroundType: normalizeBackgroundType(record.backgroundType),
    backgroundColor: normalizeColor(record.backgroundColor),
    backgroundImagePath: normalizeNullableString(record.backgroundImagePath),
    backgroundImageUrl: normalizeNullableString(record.backgroundImageUrl),
    backgroundOpacity: clampNumber(record.backgroundOpacity, 0, 1, DEFAULT_APPEARANCE_SETTINGS.backgroundOpacity),
    backgroundBlur: clampNumber(record.backgroundBlur, 0, 24, DEFAULT_APPEARANCE_SETTINGS.backgroundBlur),
    backgroundFit: normalizeBackgroundFit(record.backgroundFit),
    surfaceOpacity: clampNumber(record.surfaceOpacity, 0.72, 1, DEFAULT_APPEARANCE_SETTINGS.surfaceOpacity)
  }
}

export function mergeAppearanceSettings(current: AppearanceSettings, updates: Partial<AppearanceSettings>): AppearanceSettings {
  return normalizeAppearanceSettings({ ...current, ...updates })
}

function normalizeTheme(value: unknown): ThemeMode {
  return value === 'light' ? 'light' : 'dark'
}

function normalizeBackgroundType(value: unknown): BackgroundType {
  return value === 'image' ? 'image' : 'color'
}

function normalizeBackgroundFit(value: unknown): BackgroundFit {
  if (value === 'contain' || value === 'repeat') return value
  return 'cover'
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function normalizeColor(value: unknown): string {
  if (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim())) {
    return value.trim()
  }
  return DEFAULT_APPEARANCE_SETTINGS.backgroundColor
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

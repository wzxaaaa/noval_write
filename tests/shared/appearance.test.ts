import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE_SETTINGS, mergeAppearanceSettings, normalizeAppearanceSettings } from '../../src/shared/appearance'

describe('appearance settings', () => {
  it('normalizes invalid appearance values to safe defaults', () => {
    const settings = normalizeAppearanceSettings({
      theme: 'blue',
      backgroundType: 'wallpaper',
      backgroundColor: 'red',
      backgroundOpacity: 2,
      backgroundBlur: -3,
      backgroundFit: 'stretch',
      surfaceOpacity: 0.2
    })

    expect(settings.theme).toBe('dark')
    expect(settings.backgroundType).toBe('color')
    expect(settings.backgroundColor).toBe(DEFAULT_APPEARANCE_SETTINGS.backgroundColor)
    expect(settings.backgroundOpacity).toBe(1)
    expect(settings.backgroundBlur).toBe(0)
    expect(settings.backgroundFit).toBe('cover')
    expect(settings.surfaceOpacity).toBe(0.72)
  })

  it('merges partial updates while preserving existing image path', () => {
    const settings = mergeAppearanceSettings(
      { ...DEFAULT_APPEARANCE_SETTINGS, backgroundImagePath: 'C:/image.png' },
      { theme: 'light', backgroundType: 'image', backgroundOpacity: 0.5 }
    )

    expect(settings.theme).toBe('light')
    expect(settings.backgroundType).toBe('image')
    expect(settings.backgroundImagePath).toBe('C:/image.png')
    expect(settings.backgroundOpacity).toBe(0.5)
  })
})

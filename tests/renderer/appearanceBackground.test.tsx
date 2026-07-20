import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APPEARANCE_SETTINGS, type AppearanceSettings } from '../../src/shared/appearance'
import { buildAppearanceStyle } from '../../src/renderer/App'
import {
  AppearanceSettings as AppearanceSettingsPanel,
  buildBackgroundPreviewStyle
} from '../../src/renderer/components/settings/AppearanceSettings'
import { useUIStore } from '../../src/renderer/stores/ui.store'

const imageUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
const imageAppearance: AppearanceSettings = {
  ...DEFAULT_APPEARANCE_SETTINGS,
  backgroundType: 'image',
  backgroundImagePath: 'C:\\NovalWrite\\backgrounds\\wallpaper.jpg',
  backgroundImageUrl: imageUrl,
  backgroundOpacity: 0.65,
  backgroundFit: 'contain'
}

describe('appearance image backgrounds', () => {
  beforeEach(() => {
    useUIStore.setState({
      appearance: { ...DEFAULT_APPEARANCE_SETTINGS },
      theme: DEFAULT_APPEARANCE_SETTINGS.theme
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows the imported image in the settings preview and updates the shared appearance state', async () => {
    const openFileDialog = vi.fn(async () => ['C:\\Selected\\wallpaper.jpg'])
    const importBackgroundImage = vi.fn(async () => imageAppearance)
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        file: { openFileDialog },
        settings: { importBackgroundImage }
      }
    })

    const view = render(<AppearanceSettingsPanel />)
    fireEvent.click(view.getByRole('button', { name: '上传图片' }))

    await waitFor(() => {
      const preview = view.getByRole('img', { name: '当前背景图片预览' }) as HTMLElement
      expect(preview.style.backgroundImage).toContain(imageUrl)
      expect(view.getByRole('button', { name: '更换图片' })).toBeTruthy()
    })

    expect(openFileDialog).toHaveBeenCalledWith({
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
      properties: ['openFile']
    })
    expect(importBackgroundImage).toHaveBeenCalledWith('C:\\Selected\\wallpaper.jpg')
    expect(view.queryByText('背景色')).toBeNull()
    expect(useUIStore.getState().appearance).toEqual(imageAppearance)
  })

  it('builds matching image styles for the app background and the settings preview', () => {
    const appStyle = buildAppearanceStyle(imageAppearance) as Record<string, string>
    const previewStyle = buildBackgroundPreviewStyle(imageAppearance)

    expect(appStyle['--appearance-bg-image']).toBe(`url("${imageUrl}")`)
    expect(appStyle['--appearance-bg-opacity']).toBe('0.65')
    expect(appStyle['--appearance-bg-size']).toBe('contain')
    expect(previewStyle.backgroundImage).toBe(`url("${imageUrl}")`)
    expect(previewStyle.backgroundSize).toBe('contain')
    expect(previewStyle.backgroundRepeat).toBe('no-repeat')
  })

  it('keeps content opacity user-controlled while glass chrome stays fixed in CSS', () => {
    useUIStore.setState({
      appearance: { ...imageAppearance, surfaceOpacity: 0.82 },
      theme: imageAppearance.theme
    })

    const view = render(<AppearanceSettingsPanel />)
    const contentOpacity = view.getByRole('slider', { name: /内容底色 82%/ }) as HTMLInputElement
    const lowSurfaceStyle = buildAppearanceStyle({
      ...imageAppearance,
      surfaceOpacity: 0.72
    }) as Record<string, string>
    const opaqueSurfaceStyle = buildAppearanceStyle({
      ...imageAppearance,
      surfaceOpacity: 1
    }) as Record<string, string>

    expect(contentOpacity.value).toBe('0.82')
    expect(lowSurfaceStyle['--appearance-surface-opacity']).toBe('0.72')
    expect(opaqueSurfaceStyle['--appearance-surface-opacity']).toBe('1')
  })

  it('allows runtime data images and keeps the app shell transparent in image mode', () => {
    const html = readFileSync(resolve('src/renderer/index.html'), 'utf8')
    const css = readFileSync(resolve('src/renderer/styles/global.css'), 'utf8')

    expect(html).toContain("img-src 'self' data: blob:")
    expect(css).toMatch(/\.app-root\.has-appearance-image \.app-shell\s*\{\s*background:\s*transparent;/)
    expect(css).toMatch(/\.app-root\.has-appearance-image\s*\{[\s\S]*?--image-glass-chrome-opacity:\s*0\.56;/)
    expect(css).toMatch(/\.app-root\.has-appearance-image \.app-sidebar,[\s\S]*?\.app-root\.has-appearance-image \.app-panel\s*\{[\s\S]*?--image-glass-chrome-opacity/)
    expect(css).toMatch(/\.app-root\.has-appearance-image \.novel-editor-content\s*\{[\s\S]*?--appearance-surface-opacity/)
    expect(css).not.toMatch(/\.app-root\.has-appearance-image \.app-(?:sidebar|panel|statusbar)[^{]*\{[^}]*--appearance-surface-opacity/)
  })
})

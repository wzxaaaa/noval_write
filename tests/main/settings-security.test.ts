import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => 'C:\\NovalWrite') },
  ipcMain: { handle: vi.fn() }
}))

vi.mock('../../src/main/db/repositories/settings.repo', () => ({
  settingsRepo: {
    getJson: vi.fn(),
    set: vi.fn()
  }
}))

import { sanitizeAppearanceUpdates } from '../../src/main/ipc/settings.ipc'

describe('appearance settings security', () => {
  it('drops renderer-controlled background paths and runtime URLs', () => {
    const updates = sanitizeAppearanceUpdates({
      theme: 'dark',
      backgroundOpacity: 0.5,
      backgroundImagePath: 'C:\\Users\\user\\secret.png',
      backgroundImageUrl: 'data:image/png;base64,attacker-controlled'
    })

    expect(updates).toEqual({ theme: 'dark', backgroundOpacity: 0.5 })
    expect(updates).not.toHaveProperty('backgroundImagePath')
    expect(updates).not.toHaveProperty('backgroundImageUrl')
  })
})

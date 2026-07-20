import { create } from 'zustand'
import { DEFAULT_APPEARANCE_SETTINGS, type AppearanceSettings, type ThemeMode } from '../../shared/appearance'

interface UIState {
  theme: ThemeMode
  appearance: AppearanceSettings
  sidebarWidth: number
  panelWidth: number
  fontSize: number
  focusMode: boolean
  setTheme: (theme: ThemeMode) => void
  setAppearance: (appearance: AppearanceSettings) => void
  setSidebarWidth: (width: number) => void
  setPanelWidth: (width: number) => void
  setFontSize: (size: number) => void
  setFocusMode: (focusMode: boolean) => void
}

export const useUIStore = create<UIState>((set) => ({
  theme: DEFAULT_APPEARANCE_SETTINGS.theme,
  appearance: DEFAULT_APPEARANCE_SETTINGS,
  sidebarWidth: 260,
  panelWidth: 380,
  fontSize: 17,
  focusMode: false,
  setTheme: (theme) => set((state) => ({ theme, appearance: { ...state.appearance, theme } })),
  setAppearance: (appearance) => set({ appearance, theme: appearance.theme }),
  setSidebarWidth: (width) => set({ sidebarWidth: width }),
  setPanelWidth: (width) => set({ panelWidth: width }),
  setFontSize: (size) => set({ fontSize: Math.min(24, Math.max(14, size)) }),
  setFocusMode: (focusMode) => set({ focusMode })
}))

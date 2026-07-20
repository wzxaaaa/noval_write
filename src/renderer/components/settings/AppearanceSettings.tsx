import React from 'react'
import { mergeAppearanceSettings, type AppearanceSettings as AppearanceSettingsData } from '../../../shared/appearance'
import { useUIStore } from '../../stores/ui.store'

const COLOR_PRESETS = ['#f6f7fb', '#ffffff', '#eef2f6', '#101417', '#151b1f', '#17212b', '#e8f3ff', '#ecfdf5']

export function AppearanceSettings() {
  const appearance = useUIStore(s => s.appearance)
  const setAppearance = useUIStore(s => s.setAppearance)
  const [saving, setSaving] = React.useState(false)

  const applyAppearance = async (updates: Partial<AppearanceSettingsData>) => {
    const optimistic = mergeAppearanceSettings(appearance, updates)
    setAppearance(optimistic)
    setSaving(true)
    try {
      const saved = await window.electronAPI.settings.updateAppearance(updates)
      setAppearance(saved)
    } catch (err) {
      window.alert((err as Error).message || '保存外观设置失败')
    } finally {
      setSaving(false)
    }
  }

  const handleUploadBackground = async () => {
    const files = await window.electronAPI.file.openFileDialog({
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
      properties: ['openFile']
    })
    const filePath = files?.[0]
    if (!filePath) return

    setSaving(true)
    try {
      const saved = await window.electronAPI.settings.importBackgroundImage(filePath)
      setAppearance(saved)
    } catch (err) {
      window.alert((err as Error).message || '导入背景图片失败')
    } finally {
      setSaving(false)
    }
  }

  const handleClearImage = async () => {
    setSaving(true)
    try {
      const saved = await window.electronAPI.settings.clearBackgroundImage()
      setAppearance(saved)
    } catch (err) {
      window.alert((err as Error).message || '清除背景图片失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="appearance-settings">
      <section className="settings-section">
        <div className="settings-section-header">
          <h3>主题</h3>
          {saving && <span>保存中...</span>}
        </div>
        <div className="segmented-control">
          <button
            className={appearance.theme === 'dark' ? 'active' : ''}
            onClick={() => void applyAppearance({ theme: 'dark' })}
          >
            深色
          </button>
          <button
            className={appearance.theme === 'light' ? 'active' : ''}
            onClick={() => void applyAppearance({ theme: 'light' })}
          >
            浅色
          </button>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-header">
          <h3>背景</h3>
        </div>
        <div className="segmented-control">
          <button
            className={appearance.backgroundType === 'color' ? 'active' : ''}
            onClick={() => void applyAppearance({ backgroundType: 'color' })}
          >
            纯色
          </button>
          <button
            className={appearance.backgroundType === 'image' ? 'active' : ''}
            onClick={() => void applyAppearance({ backgroundType: 'image' })}
            disabled={!appearance.backgroundImagePath}
          >
            图片
          </button>
        </div>

        {appearance.backgroundType === 'color' ? (
          <>
            <label className="appearance-field">
              <span>背景色</span>
              <div className="color-row">
                <input
                  type="color"
                  value={appearance.backgroundColor}
                  onChange={e => void applyAppearance({ backgroundColor: e.target.value, backgroundType: 'color' })}
                />
                <input
                  value={appearance.backgroundColor}
                  onChange={e => void applyAppearance({ backgroundColor: e.target.value })}
                  maxLength={7}
                />
              </div>
            </label>

            <div className="color-presets">
              {COLOR_PRESETS.map(color => (
                <button
                  key={color}
                  className={appearance.backgroundColor === color ? 'active' : ''}
                  style={{ background: color }}
                  title={color}
                  aria-label={`使用背景色 ${color}`}
                  onClick={() => void applyAppearance({ backgroundColor: color, backgroundType: 'color' })}
                />
              ))}
            </div>
          </>
        ) : appearance.backgroundImageUrl ? (
          <div
            className="background-image-preview"
            role="img"
            aria-label="当前背景图片预览"
            style={buildBackgroundPreviewStyle(appearance)}
          >
            <span>当前背景图片</span>
          </div>
        ) : (
          <div className="background-image-preview background-image-preview-empty">
            图片预览不可用，请重新上传
          </div>
        )}

        <div className="background-image-actions">
          <button disabled={saving} onClick={() => void handleUploadBackground()}>
            {appearance.backgroundImagePath ? '更换图片' : '上传图片'}
          </button>
          {appearance.backgroundImagePath && (
            <button disabled={saving} onClick={() => void handleClearImage()}>移除图片</button>
          )}
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-header">
          <h3>图片显示</h3>
        </div>
        <label className="appearance-field">
          <span>图片透明度 {Math.round(appearance.backgroundOpacity * 100)}%</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={appearance.backgroundOpacity}
            onChange={e => void applyAppearance({ backgroundOpacity: Number(e.target.value), backgroundType: appearance.backgroundImagePath ? 'image' : appearance.backgroundType })}
          />
        </label>
        <label className="appearance-field">
          <span>背景模糊 {appearance.backgroundBlur}px</span>
          <input
            type="range"
            min={0}
            max={24}
            step={1}
            value={appearance.backgroundBlur}
            onChange={e => void applyAppearance({ backgroundBlur: Number(e.target.value) })}
          />
        </label>
        <label className="appearance-field">
          <span>适配方式</span>
          <select
            value={appearance.backgroundFit}
            onChange={e => void applyAppearance({ backgroundFit: e.target.value as AppearanceSettingsData['backgroundFit'] })}
          >
            <option value="cover">填充</option>
            <option value="contain">适应</option>
            <option value="repeat">平铺</option>
          </select>
        </label>
        <label className="appearance-field">
          <span>内容底色 {Math.round(appearance.surfaceOpacity * 100)}%</span>
          <input
            type="range"
            min={0.72}
            max={1}
            step={0.02}
            value={appearance.surfaceOpacity}
            onChange={e => void applyAppearance({ surfaceOpacity: Number(e.target.value) })}
          />
        </label>
      </section>
    </div>
  )
}

export function buildBackgroundPreviewStyle(appearance: AppearanceSettingsData): React.CSSProperties {
  return {
    backgroundImage: appearance.backgroundImageUrl
      ? `url("${appearance.backgroundImageUrl.replace(/"/g, '\\"')}")`
      : 'none',
    backgroundSize: appearance.backgroundFit === 'repeat' ? 'auto' : appearance.backgroundFit,
    backgroundRepeat: appearance.backgroundFit === 'repeat' ? 'repeat' : 'no-repeat'
  }
}

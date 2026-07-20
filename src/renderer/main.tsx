import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/global.css'
import { flushPendingEditorWrites } from './components/editor/editorPersistence'

let closeFlushInProgress = false
window.electronAPI.lifecycle.onBeforeClose(() => {
  if (closeFlushInProgress) return
  closeFlushInProgress = true

  void flushPendingEditorWrites()
    .then(() => window.electronAPI.lifecycle.completeClose(true))
    .catch(async (error) => {
      console.error('Could not save pending editor changes before close:', error)
      window.alert('最近的修改保存失败，应用将保持打开。请重试。')
      await window.electronAPI.lifecycle.completeClose(false)
      closeFlushInProgress = false
    })
})

const root = createRoot(document.getElementById('root')!)
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

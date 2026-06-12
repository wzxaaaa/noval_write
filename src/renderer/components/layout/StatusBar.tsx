import React from 'react'
import { useEditorStore } from '../../stores/editor.store'

interface StatusBarProps {
  projectId: string | null
  chapterId: string | null
}

export function StatusBar({ projectId, chapterId }: StatusBarProps) {
  const { wordCount, isDirty, isSaving, lastSaved } = useEditorStore()

  return (
    <div className="statusbar">
      <div className="statusbar-left">
        {chapterId && <span>字数: {wordCount}</span>}
        {isDirty && <span className="status-dot">● 未保存</span>}
        {isSaving && <span>保存中...</span>}
      </div>
      <div className="statusbar-right">
        {lastSaved && <span>上次保存: {new Date(lastSaved).toLocaleTimeString('zh-CN')}</span>}
      </div>
    </div>
  )
}

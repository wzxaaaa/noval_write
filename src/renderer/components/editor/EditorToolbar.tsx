import React from 'react'
import type { Editor } from '@tiptap/react'
import { useUIStore } from '../../stores/ui.store'

interface EditorToolbarProps {
  editor: Editor | null
}

export function EditorToolbar({ editor }: EditorToolbarProps) {
  const { fontSize, setFontSize, focusMode, setFocusMode } = useUIStore()

  if (!editor) return null

  const buttons = [
    { label: 'B', action: () => editor.chain().focus().toggleBold().run(), active: editor.isActive('bold'), title: '粗体' },
    { label: 'I', action: () => editor.chain().focus().toggleItalic().run(), active: editor.isActive('italic'), title: '斜体' },
    { label: 'S', action: () => editor.chain().focus().toggleStrike().run(), active: editor.isActive('strike'), title: '删除线' },
    { label: 'H1', action: () => editor.chain().focus().toggleHeading({ level: 1 }).run(), active: editor.isActive('heading', { level: 1 }), title: '标题 1' },
    { label: 'H2', action: () => editor.chain().focus().toggleHeading({ level: 2 }).run(), active: editor.isActive('heading', { level: 2 }), title: '标题 2' },
    { label: 'H3', action: () => editor.chain().focus().toggleHeading({ level: 3 }).run(), active: editor.isActive('heading', { level: 3 }), title: '标题 3' },
    { label: '•', action: () => editor.chain().focus().toggleBulletList().run(), active: editor.isActive('bulletList'), title: '无序列表' },
    { label: '1.', action: () => editor.chain().focus().toggleOrderedList().run(), active: editor.isActive('orderedList'), title: '有序列表' },
    { label: '>', action: () => editor.chain().focus().toggleBlockquote().run(), active: editor.isActive('blockquote'), title: '引用' },
    { label: '―', action: () => editor.chain().focus().setHorizontalRule().run(), active: false, title: '分割线' },
  ]

  return (
    <div className="editor-toolbar">
      <div className="toolbar-group">
        {buttons.map(btn => (
          <button
            key={btn.title}
            onClick={btn.action}
            className={btn.active ? 'active' : ''}
            title={btn.title}
          >
            {btn.label}
          </button>
        ))}
      </div>

      <div className="toolbar-spacer" />

      <label className="font-size-control" title="正文字号">
        <span>字</span>
        <input
          type="range"
          min={14}
          max={24}
          value={fontSize}
          onChange={e => setFontSize(Number(e.target.value))}
        />
        <span>{fontSize}</span>
      </label>

      <button
        onClick={() => setFocusMode(!focusMode)}
        className={focusMode ? 'active' : ''}
        title={focusMode ? '退出专注模式' : '进入专注模式'}
      >
        ⛶
      </button>
    </div>
  )
}

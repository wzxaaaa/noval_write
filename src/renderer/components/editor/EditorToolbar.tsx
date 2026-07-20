import React from 'react'
import type { Editor } from '@tiptap/react'
import { useUIStore } from '../../stores/ui.store'

interface EditorToolbarProps {
  editor: Editor | null
}

/** 中文段落首行缩进：两个全角空格。 */
const FIRST_LINE_INDENT = '　　'

interface ParagraphInfo {
  pos: number
  text: string
}

function collectIndentableParagraphs(editor: Editor): ParagraphInfo[] {
  const paragraphs: ParagraphInfo[] = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph' && node.textContent.trim() !== '') {
      paragraphs.push({ pos, text: node.textContent })
    }
  })
  return paragraphs
}

function isFullyIndented(editor: Editor): boolean {
  const paragraphs = collectIndentableParagraphs(editor)
  return paragraphs.length > 0 && paragraphs.every(p => p.text.startsWith(FIRST_LINE_INDENT))
}

/**
 * 一键首行缩进（可逆）：全部段落已缩进则移除；否则把每段段首的
 * 零散空白归一成恰好两个全角空格。从后往前处理，避免位置偏移。
 */
function toggleFirstLineIndent(editor: Editor): void {
  const paragraphs = collectIndentableParagraphs(editor)
  if (paragraphs.length === 0) return

  const removing = paragraphs.every(p => p.text.startsWith(FIRST_LINE_INDENT))
  const tr = editor.state.tr

  for (const { pos, text } of [...paragraphs].reverse()) {
    const start = pos + 1
    const leadingLength = text.match(/^[\s　]+/)?.[0].length ?? 0
    if (leadingLength > 0) tr.delete(start, start + leadingLength)
    if (!removing) tr.insertText(FIRST_LINE_INDENT, start)
  }

  editor.view.dispatch(tr)
  editor.commands.focus()
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
    { label: '⇥', action: () => toggleFirstLineIndent(editor), active: isFullyIndented(editor), title: '一键首行缩进：全文段首加两格全角空格（再点一次取消）' },
  ]

  return (
    <div className="editor-toolbar" role="toolbar" aria-label="正文格式工具栏">
      <div className="toolbar-group">
        {buttons.map(btn => (
          <button
            type="button"
            key={btn.title}
            onClick={btn.action}
            className={btn.active ? 'active' : ''}
            title={btn.title}
            aria-label={btn.title}
            aria-pressed={btn.active}
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
          aria-label="正文字号"
          onChange={e => setFontSize(Number(e.target.value))}
        />
        <span>{fontSize}</span>
      </label>

      <button
        type="button"
        onClick={() => setFocusMode(!focusMode)}
        className={focusMode ? 'active' : ''}
        title={focusMode ? '退出专注模式' : '进入专注模式'}
        aria-label={focusMode ? '退出专注模式' : '进入专注模式'}
        aria-pressed={focusMode}
      >
        ⛶
      </button>
    </div>
  )
}

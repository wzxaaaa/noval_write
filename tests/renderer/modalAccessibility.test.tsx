import React from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModalDialog } from '../../src/renderer/components/common/ModalDialog'
import { EditorToolbar } from '../../src/renderer/components/editor/EditorToolbar'
import { useUIStore } from '../../src/renderer/stores/ui.store'
import type { Editor } from '@tiptap/react'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ModalDialog accessibility', () => {
  it('labels the dialog, isolates the background, focuses the close button and closes with Escape', async () => {
    function Harness() {
      const [open, setOpen] = React.useState(true)
      return (
        <>
          <button type="button">背景操作</button>
          {open && (
            <ModalDialog title="测试设置" onClose={() => setOpen(false)}>
              <div className="modal-body">
                <button type="button">保存</button>
              </div>
            </ModalDialog>
          )}
        </>
      )
    }

    const view = render(<Harness />)
    const dialog = view.getByRole('dialog', { name: '测试设置' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')

    const closeButton = view.getByRole('button', { name: '关闭测试设置' })
    await waitFor(() => expect(document.activeElement).toBe(closeButton))
    const backgroundButton = view.getByText('背景操作').closest('button')!
    await waitFor(() => expect(backgroundButton.getAttribute('aria-hidden')).toBe('true'))

    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull())
    expect(backgroundButton.hasAttribute('aria-hidden')).toBe(false)
  })

  it('keeps the initial project-selection dialog open and traps focus when closing is disabled', async () => {
    const onClose = vi.fn()
    const view = render(
      <ModalDialog title="项目管理" onClose={onClose} canClose={false}>
        <div className="modal-body">
          <button type="button">第一个操作</button>
          <button type="button">最后一个操作</button>
        </div>
      </ModalDialog>
    )

    const dialog = view.getByRole('dialog', { name: '项目管理' })
    const firstButton = view.getByRole('button', { name: '第一个操作' })
    const lastButton = view.getByRole('button', { name: '最后一个操作' })

    expect(view.queryByRole('button', { name: '关闭项目管理' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(firstButton))

    lastButton.focus()
    fireEvent.keyDown(lastButton, { key: 'Tab' })
    expect(document.activeElement).toBe(firstButton)

    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(view.getByRole('dialog', { name: '项目管理' })).toBeTruthy()
  })
})

describe('EditorToolbar accessibility', () => {
  it('exposes every formatting control through a labelled toolbar', () => {
    useUIStore.setState({ fontSize: 17, focusMode: false })
    const chain: Record<string, () => unknown> = {}
    const chainMethod = () => chain
    Object.assign(chain, {
      focus: chainMethod,
      toggleBold: chainMethod,
      toggleItalic: chainMethod,
      toggleStrike: chainMethod,
      toggleHeading: chainMethod,
      toggleBulletList: chainMethod,
      toggleOrderedList: chainMethod,
      toggleBlockquote: chainMethod,
      setHorizontalRule: chainMethod,
      run: vi.fn(() => true)
    })
    const editor = {
      chain: () => chain,
      isActive: vi.fn(() => false),
      state: { doc: { descendants: vi.fn() } }
    } as unknown as Editor

    const view = render(<EditorToolbar editor={editor} />)
    const toolbar = view.getByRole('toolbar', { name: '正文格式工具栏' })

    expect(toolbar).toBeTruthy()
    expect(view.getByRole('button', { name: '粗体' }).getAttribute('aria-pressed')).toBe('false')
    expect(view.getByRole('button', { name: '一键首行缩进：全文段首加两格全角空格（再点一次取消）' })).toBeTruthy()
    expect(view.getByRole('slider', { name: '正文字号' })).toBeTruthy()
    expect(view.getByRole('button', { name: '进入专注模式' })).toBeTruthy()
  })
})

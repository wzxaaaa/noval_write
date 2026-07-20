import React from 'react'
import * as Dialog from '@radix-ui/react-dialog'

interface ModalDialogProps {
  title: string
  onClose: () => void
  canClose?: boolean
  className?: string
  style?: React.CSSProperties
  children: React.ReactNode
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

/**
 * Shared modal shell. Radix supplies the modal semantics, focus trap, focus
 * restoration and background focus isolation; this wrapper keeps the app's
 * existing visual structure and close behavior consistent.
 */
export function ModalDialog({
  title,
  onClose,
  canClose = true,
  className = '',
  style,
  children
}: ModalDialogProps) {
  const contentRef = React.useRef<HTMLDivElement>(null)
  const closeButtonRef = React.useRef<HTMLButtonElement>(null)

  const focusInitialControl = React.useCallback((event: Event) => {
    event.preventDefault()
    const target = closeButtonRef.current
      ?? contentRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
      ?? contentRef.current
    target?.focus()
  }, [])

  return (
    <Dialog.Root
      open
      onOpenChange={open => {
        if (!open && canClose) onClose()
      }}
    >
      <Dialog.Overlay className="modal-overlay">
        <Dialog.Content
          ref={contentRef}
          className={`modal ${className}`.trim()}
          style={style}
          aria-modal="true"
          aria-describedby={undefined}
          onOpenAutoFocus={focusInitialControl}
          onEscapeKeyDown={event => {
            if (!canClose) event.preventDefault()
          }}
          onPointerDownOutside={event => event.preventDefault()}
        >
          <div className="modal-header">
            <Dialog.Title asChild>
              <h2>{title}</h2>
            </Dialog.Title>
            {canClose && (
              <Dialog.Close asChild>
                <button ref={closeButtonRef} type="button" aria-label={`关闭${title}`}>
                  ×
                </button>
              </Dialog.Close>
            )}
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Overlay>
    </Dialog.Root>
  )
}

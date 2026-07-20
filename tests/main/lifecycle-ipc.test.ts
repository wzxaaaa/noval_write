import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  fromWebContents: vi.fn(),
  assertTrustedIpcSender: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle },
  BrowserWindow: { fromWebContents: mocks.fromWebContents }
}))

vi.mock('../../src/main/utils/approved-paths', () => ({
  assertTrustedIpcSender: mocks.assertTrustedIpcSender
}))

import { protectWindowClose, registerLifecycleHandlers } from '../../src/main/ipc/lifecycle.ipc'

function fakeWindow(options: { loading?: boolean } = {}) {
  let closeListener: ((event: { preventDefault(): void }) => void) | null = null
  const window = {
    on: vi.fn((event: string, listener: typeof closeListener) => {
      if (event === 'close') closeListener = listener
    }),
    close: vi.fn(),
    isDestroyed: vi.fn(() => false),
    webContents: {
      isDestroyed: vi.fn(() => false),
      isLoadingMainFrame: vi.fn(() => Boolean(options.loading)),
      send: vi.fn()
    }
  }
  return { window, getCloseListener: () => closeListener! }
}

describe('window close persistence handshake', () => {
  beforeEach(() => vi.clearAllMocks())

  it('waits for a trusted renderer save confirmation before closing', async () => {
    const { window, getCloseListener } = fakeWindow()
    protectWindowClose(window as never)
    registerLifecycleHandlers()

    const closeEvent = { preventDefault: vi.fn() }
    getCloseListener()(closeEvent)
    expect(closeEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(window.webContents.send).toHaveBeenCalledWith('app:beforeClose')

    const completeHandler = mocks.handle.mock.calls.find(([channel]) => channel === 'app:completeClose')?.[1]
    expect(completeHandler).toBeTypeOf('function')
    const ipcEvent = { sender: window.webContents, senderFrame: { url: 'file:///renderer/index.html' } }
    mocks.fromWebContents.mockReturnValue(window)
    completeHandler(ipcEvent, true)
    await new Promise<void>(resolve => setImmediate(resolve))

    expect(mocks.assertTrustedIpcSender).toHaveBeenCalledWith(ipcEvent)
    expect(window.close).toHaveBeenCalledTimes(1)
  })

  it('keeps the window open after a failed flush and allows another close attempt', () => {
    const { window, getCloseListener } = fakeWindow()
    protectWindowClose(window as never)
    registerLifecycleHandlers()

    const completeHandler = mocks.handle.mock.calls.find(([channel]) => channel === 'app:completeClose')?.[1]
    mocks.fromWebContents.mockReturnValue(window)

    getCloseListener()({ preventDefault: vi.fn() })
    completeHandler({ sender: window.webContents, senderFrame: null }, false)
    getCloseListener()({ preventDefault: vi.fn() })

    expect(window.close).not.toHaveBeenCalled()
    expect(window.webContents.send).toHaveBeenCalledTimes(2)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

type InvokeHandler = (...args: unknown[]) => unknown

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, InvokeHandler>()
  return {
    handlers,
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      handlers.set(channel, handler)
    }),
    assertTrustedIpcSender: vi.fn(),
    getWritingTeam: vi.fn(),
    updateWritingAgent: vi.fn(),
    listOutlines: vi.fn(),
    getOutline: vi.fn(),
    createOutline: vi.fn(),
    updateOutline: vi.fn(),
    updateOutlineContent: vi.fn(),
    deleteOutline: vi.fn()
  }
})

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle }
}))

vi.mock('../../src/main/utils/approved-paths', () => ({
  assertTrustedIpcSender: mocks.assertTrustedIpcSender
}))

vi.mock('../../src/main/db/repositories/agent-config.repo', () => ({
  agentConfigRepo: {
    getWritingTeam: mocks.getWritingTeam,
    updateWritingAgent: mocks.updateWritingAgent
  }
}))

vi.mock('../../src/main/services/agent/orchestrator', () => ({
  Orchestrator: vi.fn()
}))

vi.mock('../../src/main/db/repositories/outline.repo', () => ({
  outlineRepo: {
    listByProject: mocks.listOutlines,
    getById: mocks.getOutline,
    create: mocks.createOutline,
    update: mocks.updateOutline,
    updateContent: mocks.updateOutlineContent,
    delete: mocks.deleteOutline
  }
}))

import { registerAgentHandlers } from '../../src/main/ipc/agent.ipc'
import { registerOutlineHandlers } from '../../src/main/ipc/outline.ipc'

beforeEach(() => {
  mocks.handlers.clear()
  mocks.handle.mockClear()
  mocks.assertTrustedIpcSender.mockReset()
  mocks.assertTrustedIpcSender.mockImplementation(() => {
    throw new Error('IPC request rejected: untrusted renderer origin')
  })
})

async function expectChannelsToReject(channels: string[]): Promise<void> {
  const untrustedEvent = { senderFrame: { url: 'https://attacker.example/' } }

  for (const channel of channels) {
    const handler = mocks.handlers.get(channel)
    expect(handler, `${channel} should be registered`).toBeTypeOf('function')
    await expect(handler!(untrustedEvent)).rejects.toThrow('untrusted renderer origin')
  }

  expect(mocks.assertTrustedIpcSender).toHaveBeenCalledTimes(channels.length)
}

describe('sensitive IPC sender validation', () => {
  it('rejects every Agent handler before running privileged work', async () => {
    registerAgentHandlers()

    await expectChannelsToReject([
      'agent:getWritingTeam',
      'agent:updateWritingAgent',
      'agent:runWritingWorkflow',
      'agent:stopWorkflow',
      'agent:sendWorkflowMessage'
    ])
    expect(mocks.getWritingTeam).not.toHaveBeenCalled()
    expect(mocks.updateWritingAgent).not.toHaveBeenCalled()
  })

  it('rejects every Outline handler before accessing outline data', async () => {
    registerOutlineHandlers()

    await expectChannelsToReject([
      'outline:list',
      'outline:get',
      'outline:create',
      'outline:update',
      'outline:saveContent',
      'outline:delete'
    ])
    expect(mocks.listOutlines).not.toHaveBeenCalled()
    expect(mocks.getOutline).not.toHaveBeenCalled()
    expect(mocks.createOutline).not.toHaveBeenCalled()
    expect(mocks.updateOutline).not.toHaveBeenCalled()
    expect(mocks.updateOutlineContent).not.toHaveBeenCalled()
    expect(mocks.deleteOutline).not.toHaveBeenCalled()
  })
})

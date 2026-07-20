import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { agentConfigRepo } from '../db/repositories/agent-config.repo'
import { Orchestrator, type WorkflowControl } from '../services/agent/orchestrator'
import { assertTrustedIpcSender } from '../utils/approved-paths'
import type { WritingAgentRole } from '../../shared/writingAgents'

interface ActiveWorkflow {
  orchestrator: Orchestrator
  runId: number
  projectId: string
}

let activeWorkflow: ActiveWorkflow | null = null
let nextWorkflowRunId = 0

export function registerAgentHandlers(): void {
  ipcMain.handle('agent:getWritingTeam', async (event) => {
    assertTrustedIpcSender(event)
    return agentConfigRepo.getWritingTeam()
  })

  ipcMain.handle('agent:updateWritingAgent', async (event, role: WritingAgentRole, updates: {
    provider_config_id?: string | null
    system_prompt?: string
    parameters?: Record<string, unknown>
  }) => {
    assertTrustedIpcSender(event)
    return agentConfigRepo.updateWritingAgent(role, updates)
  })

  ipcMain.handle('agent:runWritingWorkflow', async (event, projectId: string, inputContext: string, chapterId?: string | null) => {
    assertTrustedIpcSender(event)
    return runFixedWritingWorkflow(event, projectId, inputContext, chapterId)
  })

  // Stop running workflow
  ipcMain.handle('agent:stopWorkflow', async (event) => {
    assertTrustedIpcSender(event)
    if (!activeWorkflow) {
      return { ok: true, message: '工作流已停止' }
    }
    const workflowToStop = activeWorkflow
    const control = workflowToStop.orchestrator.getActiveControl()
    if (!control || control.abortController.signal.aborted) {
      activeWorkflow = null
      event.sender.send('agent:workflowEvent', {
        type: 'workflowComplete',
        summary: '工作流已停止。可以重新启动新的任务。',
        projectId: workflowToStop.projectId,
        runId: workflowToStop.runId
      })
      return { ok: true, message: '工作流已停止' }
    }
    control.stop()
    if (activeWorkflow?.runId === workflowToStop.runId) {
      activeWorkflow = null
    }
    event.sender.send('agent:workflowEvent', {
      type: 'workflowComplete',
      summary: '工作流已停止。可以重新启动新的任务。',
      projectId: workflowToStop.projectId,
      runId: workflowToStop.runId
    })
    return { ok: true }
  })

  // Send message to inject into running workflow
  ipcMain.handle('agent:sendWorkflowMessage', async (event, message: string) => {
    assertTrustedIpcSender(event)
    if (!activeWorkflow) {
      return { ok: false, message: '没有正在运行的工作流' }
    }
    const control = activeWorkflow.orchestrator.getActiveControl()
    if (!control || control.abortController.signal.aborted) {
      activeWorkflow = null
      return { ok: false, message: '工作流已停止或未在运行' }
    }
    control.injectMessage(message)
    return { ok: true }
  })
}

async function runFixedWritingWorkflow(event: IpcMainInvokeEvent, projectId: string, inputContext: string, chapterId?: string | null): Promise<{ ok: boolean; message?: string }> {
    const activeControl = activeWorkflow?.orchestrator.getActiveControl()
    if (activeWorkflow && activeControl && !activeControl.abortController.signal.aborted) {
      return { ok: false, message: '已有 Agent 工作流正在运行' }
    }

    const orchestrator = new Orchestrator()
    const runId = ++nextWorkflowRunId
    activeWorkflow = { orchestrator, runId, projectId }
    let workflowError: string | null = null
    const isCurrentRun = () => activeWorkflow?.runId === runId && activeWorkflow.orchestrator === orchestrator
    const sendWorkflowEvent = (payload: Record<string, unknown>) => {
      if (isCurrentRun()) event.sender.send('agent:workflowEvent', { ...payload, projectId, runId })
    }
    const sendChapterUpdate = (payload: Record<string, unknown>) => {
      if (isCurrentRun()) event.sender.send('agent:chapterUpdate', { ...payload, projectId, runId })
    }
    const sendChapterCreated = (payload: unknown) => {
      if (isCurrentRun()) event.sender.send('agent:chapterCreated', payload)
    }

    try {
      await orchestrator.runWritingWorkflow(projectId, inputContext, {
        onAgentStart: (agentId, agentName) => {
          sendWorkflowEvent({ type: 'agentStart', agentId, agentName })
        },
        onAgentToken: (agentId, token) => {
          sendWorkflowEvent({ type: 'agentToken', agentId, token })
        },
        onAgentThinking: (agentId, thinking) => {
          sendWorkflowEvent({ type: 'agentThinking', agentId, thinking })
        },
        onAgentComplete: (agentId, result) => {
          sendWorkflowEvent({ type: 'agentComplete', agentId, result })
        },
        onRoundComplete: (round) => {
          sendWorkflowEvent({ type: 'roundComplete', round })
        },
        onChapterWrite: (chapterId, oldContent, newContent) => {
          sendChapterUpdate({ chapterId, oldContent, newContent })
        },
        onChapterCreate: (chapter) => {
          sendChapterCreated(chapter)
        },
        onWorkflowComplete: (summary) => {
          sendWorkflowEvent({ type: 'workflowComplete', summary })
        },
        onError: (error) => {
          workflowError = error.message
          sendWorkflowEvent({ type: 'error', message: error.message })
        }
      }, { currentChapterId: chapterId ?? null })

      return workflowError ? { ok: false, message: workflowError } : { ok: true }
    } catch (err) {
      const message = (err as Error).message || 'Agent 工作流执行失败'
      sendWorkflowEvent({ type: 'error', message })
      return { ok: false, message }
    } finally {
      if (isCurrentRun()) {
        activeWorkflow = null
      }
    }
}

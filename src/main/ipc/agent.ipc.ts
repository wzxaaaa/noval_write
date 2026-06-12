import { ipcMain } from 'electron'
import { agentConfigRepo, type AgentConfigCreate } from '../db/repositories/agent-config.repo'
import { Orchestrator, type WorkflowControl } from '../services/agent/orchestrator'

interface ActiveWorkflow {
  orchestrator: Orchestrator
  runId: number
}

let activeWorkflow: ActiveWorkflow | null = null
let nextWorkflowRunId = 0

export function registerAgentHandlers(): void {
  // Agent CRUD
  ipcMain.handle('agent:list', async () => {
    return agentConfigRepo.list()
  })

  ipcMain.handle('agent:get', async (_event, id: string) => {
    return agentConfigRepo.getById(id)
  })

  ipcMain.handle('agent:create', async (_event, params: AgentConfigCreate) => {
    return agentConfigRepo.create(params)
  })

  ipcMain.handle('agent:update', async (_event, id: string, updates: Partial<AgentConfigCreate>) => {
    agentConfigRepo.update(id, updates)
  })

  ipcMain.handle('agent:delete', async (_event, id: string) => {
    agentConfigRepo.delete(id)
  })

  // Agent Groups
  ipcMain.handle('agent:listGroups', async (_event, projectId: string) => {
    return agentConfigRepo.listGroupsByProject(projectId)
  })

  ipcMain.handle('agent:listAllGroups', async () => {
    return agentConfigRepo.listGroups()
  })

  ipcMain.handle('agent:createGroup', async (_event, name: string, projectId?: string | null, collaborationMode?: string) => {
    return agentConfigRepo.createGroup(name, projectId ?? null, collaborationMode as any)
  })

  ipcMain.handle('agent:updateGroup', async (_event, id: string, updates: { name?: string; collaboration_mode?: string }) => {
    agentConfigRepo.updateGroup(id, updates as any)
  })

  ipcMain.handle('agent:getGroup', async (_event, id: string) => {
    return agentConfigRepo.getGroupById(id)
  })

  ipcMain.handle('agent:getGroupMembers', async (_event, groupId: string) => {
    return agentConfigRepo.getGroupMembers(groupId)
  })

  ipcMain.handle('agent:addGroupMember', async (_event, groupId: string, agentId: string, turnOrder: number, canInitiate?: boolean, isModerator?: boolean) => {
    agentConfigRepo.addGroupMember(groupId, agentId, turnOrder, canInitiate ?? true, isModerator ?? false)
  })

  ipcMain.handle('agent:removeGroupMember', async (_event, groupId: string, agentId: string) => {
    agentConfigRepo.removeGroupMember(groupId, agentId)
  })

  ipcMain.handle('agent:deleteGroup', async (_event, groupId: string) => {
    agentConfigRepo.deleteGroup(groupId)
  })

  ipcMain.handle('agent:bindProjectGroup', async (_event, projectId: string, groupId: string | null) => {
    agentConfigRepo.bindProjectGroup(projectId, groupId)
  })

  // Agent Categories
  ipcMain.handle('agent:listCategories', async () => {
    return agentConfigRepo.listCategories()
  })

  ipcMain.handle('agent:createCategory', async (_event, name: string) => {
    return agentConfigRepo.createCategory(name)
  })

  ipcMain.handle('agent:updateCategory', async (_event, id: string, name: string) => {
    agentConfigRepo.updateCategory(id, name)
  })

  ipcMain.handle('agent:deleteCategory', async (_event, id: string) => {
    agentConfigRepo.deleteCategory(id)
  })

  // Run workflow
  ipcMain.handle('agent:runWorkflow', async (event, groupId: string, projectId: string, inputContext: string) => {
    const activeControl = activeWorkflow?.orchestrator.getActiveControl()
    if (activeWorkflow && activeControl && !activeControl.abortController.signal.aborted) {
      return { ok: false, message: '已有 Agent 工作流正在运行' }
    }

    const orchestrator = new Orchestrator()
    const runId = ++nextWorkflowRunId
    activeWorkflow = { orchestrator, runId }
    let workflowError: string | null = null
    const isCurrentRun = () => activeWorkflow?.runId === runId && activeWorkflow.orchestrator === orchestrator
    const sendWorkflowEvent = (payload: Record<string, unknown>) => {
      if (isCurrentRun()) event.sender.send('agent:workflowEvent', payload)
    }
    const sendChapterUpdate = (payload: Record<string, unknown>) => {
      if (isCurrentRun()) event.sender.send('agent:chapterUpdate', payload)
    }
    const sendChapterCreated = (payload: unknown) => {
      if (isCurrentRun()) event.sender.send('agent:chapterCreated', payload)
    }

    try {
      await orchestrator.runWorkflow(groupId, projectId, inputContext, {
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
      })

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
  })

  // Stop running workflow
  ipcMain.handle('agent:stopWorkflow', async (event) => {
    if (!activeWorkflow) {
      return { ok: false, message: '没有正在运行的工作流' }
    }
    const workflowToStop = activeWorkflow
    const control = workflowToStop.orchestrator.getActiveControl()
    if (!control || control.abortController.signal.aborted) {
      activeWorkflow = null
      return { ok: false, message: '工作流已停止或未在运行' }
    }
    control.stop()
    if (activeWorkflow?.runId === workflowToStop.runId) {
      activeWorkflow = null
    }
    event.sender.send('agent:workflowEvent', { type: 'workflowComplete', summary: '工作流已停止。可以重新启动新的任务。' })
    return { ok: true }
  })

  // Send message to inject into running workflow
  ipcMain.handle('agent:sendWorkflowMessage', async (_event, message: string) => {
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

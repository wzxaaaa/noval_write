import { agentConfigRepo } from '../../db/repositories/agent-config.repo'
import type { ChapterRow } from '../../db/repositories/chapter.repo'
import type { AgentRunResult } from './agent-runtime'
import { ChapterPipelineRunner } from './chapter-pipeline'
import { WRITING_AGENT_DEFINITIONS } from '../../../shared/writingAgents'

export interface WorkflowCallbacks {
  onAgentStart: (agentId: string, agentName: string) => void
  onAgentToken: (agentId: string, token: string) => void
  onAgentThinking: (agentId: string, thinking: string) => void
  onAgentComplete: (agentId: string, result: AgentRunResult) => void
  onRoundComplete: (round: number) => void
  onWorkflowComplete: (summary: string) => void
  onChapterWrite: (chapterId: string, oldContent: string, newContent: string) => void
  onChapterCreate: (chapter: ChapterRow) => void
  onError: (error: Error) => void
}

export interface WorkflowControl {
  abortController: AbortController
  injectedMessages: string[]
  stop(): void
  injectMessage(message: string): void
}

export interface WritingWorkflowOptions {
  currentChapterId?: string | null
}

export class Orchestrator {
  private currentControl: WorkflowControl | null = null

  getActiveControl(): WorkflowControl | null {
    return this.currentControl
  }

  async runWritingWorkflow(
    projectId: string,
    inputContext: string,
    callbacks: WorkflowCallbacks,
    options: WritingWorkflowOptions = {}
  ): Promise<void> {
    const abortController = new AbortController()
    const injectedMessages: string[] = []
    const control: WorkflowControl = {
      abortController,
      injectedMessages,
      stop() { abortController.abort() },
      injectMessage(message: string) { injectedMessages.push(message) }
    }
    this.currentControl = control

    try {
      const members = agentConfigRepo.getWritingTeam().map(agent => {
        const definition = WRITING_AGENT_DEFINITIONS.find(item => item.role === agent.pipeline_role)
        return {
          ...agent,
          agent_id: agent.id,
          group_id: 'fixed-writing-team',
          turn_order: definition?.order ?? 0,
          can_initiate: 1,
          is_moderator: 0,
          routing_rules: JSON.stringify({ pipeline_role: agent.pipeline_role })
        }
      })

      await new ChapterPipelineRunner(projectId, callbacks, abortController.signal, injectedMessages, options.currentChapterId)
        .run(inputContext, members)
    } catch (err) {
      callbacks.onError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      this.currentControl = null
    }
  }
}

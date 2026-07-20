import { ipcMain } from 'electron'
import type { AppAgentMessageParams } from '../../shared/appActions'
import { runAppAgentMessage } from '../services/actions/app-agent-runner'
import { conversationRepo } from '../db/repositories/conversation.repo'
import { assertTrustedIpcSender } from '../utils/approved-paths'
import {
  abortStreamController,
  releaseStreamController,
  replaceStreamController
} from './stream-controller-registry'

// 活跃 appAgent 流的 AbortController，按 conversationId 索引
const activeAppAgentStreams = new Map<string, AbortController>()

export function registerAppAgentHandlers(): void {
  ipcMain.handle('appAgent:abortMessage', async (event, conversationId: string) => {
    assertTrustedIpcSender(event)
    abortStreamController(activeAppAgentStreams, conversationId)
  })

  ipcMain.handle('appAgent:sendMessage', async (event, params: AppAgentMessageParams) => {
    assertTrustedIpcSender(event)
    // 如果该对话已有活跃流，先终止
    const abortController = replaceStreamController(activeAppAgentStreams, params.conversationId)

    let fullText = ''
    let fullThinking = ''

    try {
      const result = await runAppAgentMessage(params, {
        onToken: (token) => {
          fullText += token
          if (activeAppAgentStreams.get(params.conversationId) === abortController) {
            event.sender.send('ai:token', { conversationId: params.conversationId, token })
          }
        },
        onThinking: (thinking) => {
          fullThinking += thinking
          if (activeAppAgentStreams.get(params.conversationId) === abortController) {
            event.sender.send('ai:thinking', { conversationId: params.conversationId, thinking })
          }
        },
        onActionEvent: (actionEvent) => {
          if (activeAppAgentStreams.get(params.conversationId) === abortController) {
            event.sender.send('appAgent:action', actionEvent)
          }
        }
      }, abortController.signal)

      return result
    } catch (err) {
      const isAbort = (err as Error).name === 'AbortError' || abortController.signal.aborted
      // 被终止时，已产出的内容仍然保存
      if (isAbort && fullText) {
        if (activeAppAgentStreams.get(params.conversationId) === abortController) {
          conversationRepo.addMessage(
            params.conversationId,
            'assistant',
            fullText,
            undefined,
            fullThinking ? { thinking: fullThinking } : {}
          )
        }
        return { content: fullText, conversationId: params.conversationId, actionResults: [], aborted: true }
      }
      return { conversationId: params.conversationId, actionResults: [], error: isAbort ? '已终止生成' : (err as Error).message }
    } finally {
      releaseStreamController(activeAppAgentStreams, params.conversationId, abortController)
    }
  })
}

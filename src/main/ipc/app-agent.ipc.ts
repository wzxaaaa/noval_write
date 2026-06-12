import { ipcMain } from 'electron'
import type { AppAgentMessageParams } from '../../shared/appActions'
import { runAppAgentMessage } from '../services/actions/app-agent-runner'

export function registerAppAgentHandlers(): void {
  ipcMain.handle('appAgent:sendMessage', async (event, params: AppAgentMessageParams) => {
    return runAppAgentMessage(params, {
      onActionEvent: (actionEvent) => {
        event.sender.send('appAgent:action', actionEvent)
      }
    })
  })
}

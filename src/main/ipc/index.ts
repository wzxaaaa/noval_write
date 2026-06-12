import { registerFileHandlers } from './file.ipc'
import { registerAIHandlers } from './ai.ipc'
import { registerKnowledgeHandlers } from './knowledge.ipc'
import { registerAgentHandlers } from './agent.ipc'
import { registerOutlineHandlers } from './outline.ipc'
import { registerAppAgentHandlers } from './app-agent.ipc'
import { registerSettingsHandlers } from './settings.ipc'

export function registerAllHandlers(): void {
  registerFileHandlers()
  registerAIHandlers()
  registerKnowledgeHandlers()
  registerAgentHandlers()
  registerOutlineHandlers()
  registerAppAgentHandlers()
  registerSettingsHandlers()
}

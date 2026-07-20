import { create } from 'zustand'
import type { AgentConfig, WorkflowEvent } from '../../preload/types'

interface CompletedSnapshot {
  tokens: string
  thinking: string
}

interface AgentState {
  agents: AgentConfig[]
  workflowEvents: WorkflowEvent[]
  isRunning: boolean

  inputContext: string
  runtimeInput: string
  agentTokenBuffer: Record<string, string>
  agentThinkingBuffer: Record<string, string>
  completedSnapshots: Record<number, CompletedSnapshot>
  expandedThinking: Record<string, boolean>
  proposalStatus: string | null

  setAgents: (agents: AgentConfig[]) => void
  addAgent: (agent: AgentConfig) => void
  updateAgent: (id: string, updates: Partial<AgentConfig>) => void
  removeAgent: (id: string) => void
  addWorkflowEvent: (event: WorkflowEvent) => void
  clearWorkflowEvents: () => void
  setRunning: (running: boolean) => void

  setInputContext: (value: string) => void
  setRuntimeInput: (value: string) => void
  setAgentTokenBuffer: (buffer: Record<string, string>) => void
  setAgentThinkingBuffer: (buffer: Record<string, string>) => void
  setCompletedSnapshots: (snapshots: Record<number, CompletedSnapshot>) => void
  setExpandedThinking: (state: Record<string, boolean>) => void
  setProposalStatus: (status: string | null) => void
  resetRuntimeState: () => void
  resetBuffers: () => void
}

export const useAgentStore = create<AgentState>((set) => ({
  agents: [],
  workflowEvents: [],
  isRunning: false,

  inputContext: '',
  runtimeInput: '',
  agentTokenBuffer: {},
  agentThinkingBuffer: {},
  completedSnapshots: {},
  expandedThinking: {},
  proposalStatus: null,

  setAgents: (agents) => set({ agents }),
  addAgent: (agent) => set((s) => ({ agents: [...s.agents, agent] })),
  updateAgent: (id, updates) => set((s) => ({
    agents: s.agents.map(a => a.id === id ? { ...a, ...updates } : a)
  })),
  removeAgent: (id) => set((s) => ({
    agents: s.agents.filter(a => a.id !== id)
  })),
  addWorkflowEvent: (event) => set((s) => ({
    workflowEvents: [...s.workflowEvents, event]
  })),
  clearWorkflowEvents: () => set({ workflowEvents: [] }),
  setRunning: (running) => set({ isRunning: running }),

  setInputContext: (inputContext) => set({ inputContext }),
  setRuntimeInput: (runtimeInput) => set({ runtimeInput }),
  setAgentTokenBuffer: (agentTokenBuffer) => set({ agentTokenBuffer }),
  setAgentThinkingBuffer: (agentThinkingBuffer) => set({ agentThinkingBuffer }),
  setCompletedSnapshots: (completedSnapshots) => set({ completedSnapshots }),
  setExpandedThinking: (expandedThinking) => set({ expandedThinking }),
  setProposalStatus: (proposalStatus) => set({ proposalStatus }),

  resetRuntimeState: () => set({
    agentTokenBuffer: {},
    agentThinkingBuffer: {},
    completedSnapshots: {},
    expandedThinking: {},
    proposalStatus: null,
    runtimeInput: '',
    inputContext: '',
    isRunning: false,
    workflowEvents: []
  }),

  resetBuffers: () => set({
    agentTokenBuffer: {},
    agentThinkingBuffer: {},
    completedSnapshots: {},
    expandedThinking: {},
    proposalStatus: null,
    workflowEvents: []
  })
}))

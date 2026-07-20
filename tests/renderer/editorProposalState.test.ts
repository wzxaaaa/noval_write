import { act } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useEditorStore } from '../../src/renderer/stores/editor.store'

describe('editor proposal state', () => {
  beforeEach(() => act(() => useEditorStore.getState().reset()))

  it('keeps newer editor content when a proposal was generated from a stale base', () => {
    act(() => {
      useEditorStore.getState().loadChapter('chapter-a', 'Chapter A', 'new user draft')
      useEditorStore.getState().applyAgentContent('AI proposal', 'old base', true)
    })

    const state = useEditorStore.getState()
    expect(state.content).toBe('new user draft')
    expect(state.agentProposedContent).toBe('AI proposal')
    expect(state.agentOldContent).toBe('new user draft')
    expect(state.agentProposalConflict).toBe(true)
  })

  it('only replaces conflicting content after explicit acceptance', () => {
    act(() => {
      useEditorStore.getState().loadChapter('chapter-a', 'Chapter A', 'new user draft')
      useEditorStore.getState().applyAgentContent('AI proposal', 'new user draft', true)
      useEditorStore.getState().acceptAgentChange()
    })

    const state = useEditorStore.getState()
    expect(state.content).toBe('AI proposal')
    expect(state.agentProposal).toBe(false)
    expect(state.isDirty).toBe(true)
  })

  it('keeps edits made while a conflict is awaiting a decision', () => {
    act(() => {
      useEditorStore.getState().loadChapter('chapter-a', 'Chapter A', 'new user draft')
      useEditorStore.getState().applyAgentContent('AI proposal', 'old base', true)
      useEditorStore.getState().setContent('newest user draft')
      useEditorStore.getState().rejectAgentChange()
    })

    expect(useEditorStore.getState().content).toBe('newest user draft')
  })
})

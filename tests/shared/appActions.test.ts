import { describe, expect, it } from 'vitest'
import { APP_ACTION_DEFINITIONS, getAppActionDefinition } from '../../src/shared/appActions'

describe('appActions', () => {
  it('keeps action names unique', () => {
    const names = APP_ACTION_DEFINITIONS.map(action => action.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('can look up every registered action definition', () => {
    for (const action of APP_ACTION_DEFINITIONS) {
      expect(getAppActionDefinition(action.name)).toEqual(action)
      expect(action.title).toBeTruthy()
      expect(action.description).toBeTruthy()
    }
  })

  it('separates ui and data write actions', () => {
    expect(getAppActionDefinition('open_panel')?.safety).toBe('ui')
    expect(getAppActionDefinition('upsert_outline')?.safety).toBe('write')
    expect(getAppActionDefinition('search_knowledge')?.safety).toBe('read')
    expect(getAppActionDefinition('propose_chapter_edit')?.safety).toBe('confirm')
    expect(getAppActionDefinition('resolve_chapter')?.safety).toBe('read')
  })
})

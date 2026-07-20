import { describe, expect, it } from 'vitest'
import {
  abortStreamController,
  releaseStreamController,
  replaceStreamController
} from '../../src/main/ipc/stream-controller-registry'

describe('stream controller registry', () => {
  it('does not let an older request release the replacement controller', () => {
    const registry = new Map<string, AbortController>()
    const first = replaceStreamController(registry, 'conversation-1')
    const second = replaceStreamController(registry, 'conversation-1')

    expect(first.signal.aborted).toBe(true)
    expect(registry.get('conversation-1')).toBe(second)

    releaseStreamController(registry, 'conversation-1', first)
    expect(registry.get('conversation-1')).toBe(second)

    releaseStreamController(registry, 'conversation-1', second)
    expect(registry.has('conversation-1')).toBe(false)
  })

  it('keeps an explicitly aborted controller registered until its request releases it', () => {
    const registry = new Map<string, AbortController>()
    const controller = replaceStreamController(registry, 'conversation-1')

    abortStreamController(registry, 'conversation-1')

    expect(controller.signal.aborted).toBe(true)
    expect(registry.get('conversation-1')).toBe(controller)

    releaseStreamController(registry, 'conversation-1', controller)
    expect(registry.has('conversation-1')).toBe(false)
  })
})

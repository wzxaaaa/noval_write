export type StreamControllerRegistry = Map<string, AbortController>

export function replaceStreamController(
  registry: StreamControllerRegistry,
  key: string
): AbortController {
  registry.get(key)?.abort()
  const controller = new AbortController()
  registry.set(key, controller)
  return controller
}

export function abortStreamController(
  registry: StreamControllerRegistry,
  key: string
): void {
  const controller = registry.get(key)
  if (!controller) return

  controller.abort()
}

export function releaseStreamController(
  registry: StreamControllerRegistry,
  key: string,
  controller: AbortController
): void {
  if (registry.get(key) === controller) {
    registry.delete(key)
  }
}

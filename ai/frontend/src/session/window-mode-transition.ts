export type WindowMode = 'window' | 'pet'

interface WindowModeTransitionDependencies {
  persist: (settings: Record<string, unknown>) => Promise<void>
  setPetMode: (enabled: boolean) => void | Promise<unknown>
}

/**
 * Save the renderer's authoritative mode before Electron destroys it.
 * The replacement renderer immediately reloads settings, so rebuilding first
 * would let the old persisted value switch the new window straight back.
 */
export async function persistAndApplyWindowMode(
  settings: Record<string, unknown>,
  windowMode: WindowMode,
  dependencies: WindowModeTransitionDependencies,
): Promise<void> {
  await dependencies.persist({ ...settings, windowMode })
  await dependencies.setPetMode(windowMode === 'pet')
}

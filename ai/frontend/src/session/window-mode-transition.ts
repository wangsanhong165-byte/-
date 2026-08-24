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
  const previousMode: WindowMode = settings.windowMode === 'pet' ? 'pet' : 'window'
  await dependencies.persist({ ...settings, windowMode })
  try {
    await dependencies.setPetMode(windowMode === 'pet')
  } catch (error) {
    try {
      await dependencies.persist({ ...settings, windowMode: previousMode })
    } catch (rollbackError) {
      const applyMessage = error instanceof Error ? error.message : String(error)
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      throw new Error(`${applyMessage}; settings rollback failed: ${rollbackMessage}`)
    }
    throw error
  }
}

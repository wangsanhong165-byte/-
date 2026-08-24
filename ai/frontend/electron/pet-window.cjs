const DEFAULT_MODEL_SIZE = Object.freeze({ width: 420, height: 620 })
const DEFAULT_CONVERSATION_SIZE = Object.freeze({ width: 360, height: 176 })

function compactSurfaceBounds(workArea, size, position) {
  const width = Math.max(1, Math.min(Math.round(size.width), Math.round(workArea.width)))
  const height = Math.max(1, Math.min(Math.round(size.height), Math.round(workArea.height)))
  return {
    x: position === 'left'
      ? Math.round(workArea.x + Math.min(32, Math.max(0, workArea.width - width)))
      : Math.round(workArea.x + workArea.width - width - Math.min(24, Math.max(0, workArea.width - width))),
    y: Math.round(workArea.y + workArea.height - height - Math.min(
      position === 'left' ? 32 : 24,
      Math.max(0, workArea.height - height),
    )),
    width,
    height,
  }
}

function getPetBounds(workArea) {
  return compactSurfaceBounds(workArea, DEFAULT_MODEL_SIZE, 'right')
}

function getPetConversationBounds(workArea) {
  return compactSurfaceBounds(workArea, DEFAULT_CONVERSATION_SIZE, 'left')
}

function fitBoundsToWorkArea(bounds, workArea) {
  const width = Math.min(bounds.width, workArea.width)
  const height = Math.min(bounds.height, workArea.height)
  return {
    x: Math.min(
      workArea.x + workArea.width - width,
      Math.max(workArea.x, bounds.x),
    ),
    y: Math.min(
      workArea.y + workArea.height - height,
      Math.max(workArea.y, bounds.y),
    ),
    width,
    height,
  }
}

function selectRestorableBounds({ current, normal, maximized, fullScreen }) {
  return maximized || fullScreen ? normal : current
}

module.exports = {
  DEFAULT_CONVERSATION_SIZE,
  DEFAULT_MODEL_SIZE,
  fitBoundsToWorkArea,
  getPetBounds,
  getPetConversationBounds,
  selectRestorableBounds,
}

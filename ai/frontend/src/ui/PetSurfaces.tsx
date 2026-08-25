import { useCallback, useEffect, useState, type PointerEvent, type WheelEvent } from 'react'

import { CharacterView } from '../character/CharacterView'
import { ChatView } from '../conversation/ChatView'
import { useActions } from '../core/store'
import type { PetConversationSnapshot } from '../session/electron-window-bridge'
import { electronWindowBridge } from '../session/electron-window-bridge'
import { InputBar } from './InputBar'

export function PetModelSurface() {
  useEffect(() => {
    const finishDrag = () => electronWindowBridge.endWindowDrag()
    window.addEventListener('pointerup', finishDrag)
    window.addEventListener('pointercancel', finishDrag)
    return () => {
      window.removeEventListener('pointerup', finishDrag)
      window.removeEventListener('pointercancel', finishDrag)
      electronWindowBridge.endWindowDrag()
    }
  }, [])

  const beginDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    electronWindowBridge.startWindowDrag()
  }

  const resize = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    electronWindowBridge.resizePetModel(event.deltaY > 0 ? 0.9 : 1.1)
  }

  return (
    <main className="pet-model-surface">
      <div
        className="pet-model-canvas"
        onPointerDown={beginDrag}
        onWheel={resize}
      >
        <CharacterView />
      </div>
    </main>
  )
}

export function PetConversationSurface() {
  const actions = useActions()
  const [snapshot, setSnapshot] = useState<PetConversationSnapshot | null>(null)

  const applySnapshot = useCallback((next: PetConversationSnapshot) => {
    setSnapshot(next)
    actions.setMessages(next.messages.slice(-4))
    actions.setActivity(next.activity)
    actions.setConnection(next.connection)
    actions.setStatusMessage(next.statusMessage)
    actions.setAudioPlaying(next.ttsActive)
    actions.setSetting('voiceInputEnabled', next.settings.voiceInputEnabled)
    actions.setSetting('windowMode', 'pet')
  }, [actions])

  useEffect(() => {
    let active = true
    const unsubscribe = electronWindowBridge.onPetSnapshot(applySnapshot)
    void electronWindowBridge.getPetSnapshot().then(current => {
      if (active && current) applySnapshot(current)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [applySnapshot])

  useEffect(() => {
    const finishDrag = () => electronWindowBridge.endWindowDrag()
    window.addEventListener('pointerup', finishDrag)
    window.addEventListener('pointercancel', finishDrag)
    return () => {
      window.removeEventListener('pointerup', finishDrag)
      window.removeEventListener('pointercancel', finishDrag)
      electronWindowBridge.endWindowDrag()
    }
  }, [])

  return (
    <main className="pet-conversation-surface">
      <header
        className="pet-conversation-titlebar"
        onPointerDown={event => {
          if (event.button === 0) electronWindowBridge.startWindowDrag()
        }}
      >
        <span>Shirone</span>
        <button
          type="button"
          aria-label="隐藏对话"
          title="隐藏对话"
          onPointerDown={event => event.stopPropagation()}
          onClick={() => electronWindowBridge.setPetConversationVisible(false)}
        >
          ×
        </button>
      </header>
      <div className="pet-conversation-content">
        <ChatView />
        <InputBar
          onSend={input => {
            if (input.images.length) return false
            electronWindowBridge.sendPetCommand({ type: 'send', text: input.text })
            return true
          }}
          onInterrupt={() => electronWindowBridge.sendPetCommand({ type: 'interrupt' })}
          recorderState={snapshot?.recorderState ?? 'idle'}
          recordingSupported={snapshot?.recordingSupported ?? false}
          onToggleRecording={() => electronWindowBridge.sendPetCommand({ type: 'toggle-recording' })}
        />
      </div>
    </main>
  )
}

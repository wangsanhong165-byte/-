import { useEffect, useRef, useCallback, useState } from 'react'
import {
  useActions,
  useSelector,
  selectActivity,
  selectConnection,
  selectMessages,
  selectSettings,
  selectStatusMessage,
  selectTtsActive,
} from '../core/store'
import { eventBus } from '../core/event-bus'
import { RuntimeAdapter } from '../runtime/adapter'
import { runtimeWebSocketUrl } from '../runtime/client'
import { AudioPlayer } from '../audio/player'
import {
  bytesToBase64,
  createDiagnosticWavBytes,
  LipSyncDiagnosticProbe,
} from '../audio/diagnostic'
import { AudioRecorder, type RecorderState } from '../audio/recorder'
import { DEFAULT_VISUAL_POLICY, fetchVisualPolicy, uploadVisualAttachment, type VisualPolicy } from '../runtime/visual'
import type { VisualAttachment } from '../runtime/event-types'
import { cameraSession } from '../vision/camera-session'
import { CameraWindow } from '../vision/CameraWindow'
import { StatusBar } from '../ui/StatusBar'
import { TitleBar } from '../ui/TitleBar'
import type { HistoryEntry } from '../conversation/HistoryPanel'
import type { AiActivity } from '../core/types'
import type { AppSettings } from '../core/store'
import type { ChatMessage } from '../core/types'
import { CompanionWorkspace } from '../ui/CompanionWorkspace'
import type { VisualComposerInput } from '../ui/InputBar'
import type { CharacterDescriptor } from '../ui/character-catalog'
import { requestLive2DModelLoad, synchronizeStartupLive2DModel } from './live2d-switch'
import { resolveHistoryCommand } from '../conversation/history-command'
import { assistantPlaceholderForTurn } from './turn-messages'
import { PermissionDialog } from '../ui/PermissionDialog'
import {
  normalizeLive2DPerformanceSettings,
  readModelPerformanceDefaults,
  resolvePersistedLive2DModel,
} from '../character/Live2DPerformanceSettings'
import { persistAndApplyWindowMode } from './window-mode-transition'
import { electronWindowBridge } from './electron-window-bridge'
import { PetModelSurface } from '../ui/PetSurfaces'
import { applyUiTheme, isUiThemeMode, DEFAULT_ACCENT_KEY } from '../core/ui-theme'

const WS_URL = runtimeWebSocketUrl(location)
let idCounter = 0
const nextId = () => `msg_${++idCounter}`

export function DesktopSessionWorkspace() {
  const surface = new URLSearchParams(window.location.search).get('surface')
  const actions = useActions()
  const clientRef = useRef<RuntimeAdapter | null>(null)
  const audioRef = useRef<AudioPlayer | null>(null)
  const recorderRef = useRef<AudioRecorder | null>(null)
  const [recorderState, setRecorderState] = useState<RecorderState>('idle')
  const [histories, setHistories] = useState<HistoryEntry[]>([])
  const [historyUid, setHistoryUid] = useState('')
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyRevision, setHistoryRevision] = useState(0)
  const [subtitleText, setSubtitleText] = useState('')
  const [accessoryParts, setAccessoryParts] = useState<Record<string, string>>({})
  const [accessoryState, setAccessoryState] = useState<Record<string, boolean>>({})
  const settings = useSelector(selectSettings)
  const ttsActive = useSelector(selectTtsActive)
  const activity = useSelector(selectActivity)
  const connection = useSelector(selectConnection)
  const messages = useSelector(selectMessages)
  const statusMessage = useSelector(selectStatusMessage)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const [cameraWindowOpen, setCameraWindowOpen] = useState(false)
  const cameraAttachmentsRef = useRef<VisualAttachment[]>([])
  const cameraSampleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const cameraAutoOpenedRef = useRef(false)
  const visualPolicyRef = useRef<VisualPolicy>(DEFAULT_VISUAL_POLICY)

  // Initialize Runtime adapter and Audio player
  useEffect(() => {
    const client = new RuntimeAdapter(WS_URL)
    const audio = new AudioPlayer()
    let diagnosticRun: {
      requestId: string
      turnId: string
      probe: LipSyncDiagnosticProbe
      stopTimer?: ReturnType<typeof setTimeout>
      finishTimer?: ReturnType<typeof setTimeout>
    } | null = null
    clientRef.current = client
    audioRef.current = audio
    void fetchVisualPolicy().then(policy => { visualPolicyRef.current = policy }).catch(() => {})

    const unsub1 = eventBus.on('connection:change', ({ connected }) => {
      actions.setConnection(connected ? 'connected' : 'disconnected')
      if (connected) {
        client.sendCommand('get_histories', {})
        // Sync proactive settings to backend on reconnect (use ref for latest)
        const s = settingsRef.current
        client.sendCommand('set_proactive', { enabled: s.proactive })
        client.sendCommand('set_proactive_idle', { seconds: s.proactiveIdleTime })
        client.sendCommand('set_screen_vision', { enabled: s.screenVisionEnabled })
        client.sendCommand('set_vision_source', { source: 'voice_camera', enabled: s.voiceCameraEnabled })
        client.sendCommand('set_vision_source', { source: 'voice_screen', enabled: s.voiceScreenEnabled })
        client.sendCommand('set_vision_source', { source: 'text_camera', enabled: s.textCameraEnabled })
        client.sendCommand('set_vision_source', { source: 'text_screen', enabled: s.textScreenEnabled })
      }
    })

    const unsub2 = eventBus.on('runtime:status', ({ message }) => {
      // activity is driven by CharacterStateMachine via character:activity event
      if (message) actions.setStatusMessage(message)
    })

    // activity single source: CharacterStateMachine (emitted by controllers)
    const unsubActivity = eventBus.on('character:activity', ({ activity }) => {
      actions.setActivity(activity as AiActivity)
    })

    // character state (emotion/intensity) driven by backend CharacterUpdate
    const unsubIntent = eventBus.on('runtime:character.intent', ({ emotion, intensity, behavior }) => {
      actions.setCharacter(emotion, intensity, behavior || emotion)
    })

    const unsubTurnMessage = eventBus.on('runtime:turn.started', ({ turnId, origin }) => {
      const placeholder = assistantPlaceholderForTurn(origin, turnId)
      if (placeholder) actions.addMessage(placeholder)
    })

    const unsub3 = eventBus.on('runtime:message', ({ text, reasoning }) => {
      actions.setStatusMessage('')
      actions.updateLastAssistant(text, reasoning)
      setSubtitleText(text)
    })

    const unsub4 = eventBus.on('runtime:chunk', ({ text }) => {
      actions.updateLastAssistant(text)
      setSubtitleText(text)
    })

    const unsub5 = eventBus.on('audio:play', ({ audio: b64, format, turnId, sequence }) => {
      actions.setAudioPlaying(true)
      audio.enqueue(b64, format, turnId, sequence)
    })

    const unsub6 = eventBus.on('audio:stop', ({ turnId }) => {
      if (audio.stop(turnId)) actions.setAudioPlaying(false)
    })

    const unsub7 = eventBus.on('runtime:tts.started', ({ turnId, sequence }) => {
      audio.beginTurn(turnId, sequence)
      actions.setAudioPlaying(true)
    })

    const unsub8 = eventBus.on('runtime:tts.completed', () => {})

    const finishDiagnostic = (
      run: NonNullable<typeof diagnosticRun>,
      error?: unknown,
    ) => {
      if (diagnosticRun !== run) return
      const result = run.probe.finish()
      eventBus.emit('runtime:turn.completed', {
        turnId: run.turnId,
        reason: error ? 'diagnostic_failed' : 'diagnostic_completed',
      })
      eventBus.emit('audio:diagnostic.result', {
        requestId: run.requestId,
        phase: !error && result.passed ? 'passed' : 'failed',
        message: error
          ? `诊断失败：${error instanceof Error ? error.message : String(error)}`
          : result.passed
            ? '真实音频播放、口型响应和中断闭嘴均通过'
            : '未达到音量、开口或闭嘴阈值，请检查浏览器音频权限和模型嘴型画像',
        ...result,
      })
      diagnosticRun = null
    }

    const unsubDiagnosticDebug = eventBus.on('character:performance_debug', ({ lipSync }) => {
      diagnosticRun?.probe.recordMouth(Number(lipSync.smoothedMouth ?? 0))
    })

    const unsubDiagnostic = eventBus.on('audio:diagnostic.request', ({ requestId }) => {
      void (async () => {
        if (diagnosticRun) {
          if (diagnosticRun.stopTimer) clearTimeout(diagnosticRun.stopTimer)
          if (diagnosticRun.finishTimer) clearTimeout(diagnosticRun.finishTimer)
          eventBus.emit('audio:stop', {
            turnId: diagnosticRun.turnId,
            reason: 'diagnostic_restarted',
          })
        }
        const run = {
          requestId,
          turnId: `diagnostic_${requestId}`,
          probe: new LipSyncDiagnosticProbe(),
        } as NonNullable<typeof diagnosticRun>
        diagnosticRun = run
        eventBus.emit('audio:diagnostic.result', {
          requestId,
          phase: 'running',
          message: '正在播放确定性测试音频，并在中途执行打断……',
        })
        try {
          await audio.resume()
          eventBus.emit('runtime:turn.started', {
            turnId: run.turnId,
            inputMode: 'text',
            origin: 'system',
          })
          audio.beginTurn(run.turnId, 0)
          const accepted = audio.enqueue(
            bytesToBase64(createDiagnosticWavBytes()),
            'wav',
            run.turnId,
            0,
          )
          if (!accepted) throw new Error('测试音频被播放队列拒绝')
          run.stopTimer = setTimeout(() => {
            eventBus.emit('audio:stop', {
              turnId: run.turnId,
              reason: 'diagnostic_interrupt',
            })
            // Performance telemetry is sampled at 4 Hz. Allow two complete
            // samples after interruption so the probe observes the smooth
            // release instead of racing the first stale mouth snapshot.
            run.finishTimer = setTimeout(() => finishDiagnostic(run), 650)
          }, 850)
        } catch (error) {
          finishDiagnostic(run, error)
        }
      })()
    })

    const unsub11 = eventBus.on('runtime:asr.result', ({ text }) => {
      if (!text) return
      actions.addMessage({ id: nextId(), role: 'user', text, timestamp: Date.now() })
      actions.addMessage({ id: nextId(), role: 'assistant', text: '', timestamp: Date.now() })
    })

    const unsub10 = eventBus.on('runtime:error', ({ message }) => {
      actions.addMessage({ id: nextId(), role: 'system', text: `[Error] ${message}`, timestamp: Date.now() })
    })

    // Handle command responses (e.g., get_histories)
    const unsub12 = eventBus.on('runtime:management.result', ({ action, data }) => {
      if (action === 'get_histories' && Array.isArray((data as any)?.histories)) {
        const h = (data as any).histories as HistoryEntry[]
        setHistories(h)
        setHistoryUid(current =>
          h.some(entry => entry.uid === current) ? current : h[0]?.uid || ''
        )
        setHistoryLoading(false)
        return
      }

      const effect = resolveHistoryCommand(action, data)
      if (effect) {
        setHistoryUid(effect.activeUid)
        setHistoryLoading(false)
        if (effect.clearMessages) actions.clearMessages()
        if (effect.messages) {
          const messages = effect.messages.flatMap((item, index): ChatMessage[] => {
            if (!item || typeof item !== 'object') return []
            const record = item as Record<string, unknown>
            const role = record.role
            const content = record.content
            if ((role !== 'user' && role !== 'assistant' && role !== 'system') || typeof content !== 'string') {
              return []
            }
            return [{
              id: `history_${effect.activeUid}_${index}`,
              role,
              text: content,
              timestamp: typeof record.timestamp === 'number' ? record.timestamp : Date.now() + index,
            }]
          })
          actions.setMessages(messages)
        }
        if (effect.refreshHistories) client.sendCommand('get_histories', {})
        setHistoryRevision(current => current + 1)
      } else if (action === 'delete_history') {
        setHistoryLoading(false)
        const deletedUid = String(data.history_uid ?? '')
        setHistoryUid(current => {
          if (current !== deletedUid) return current
          actions.clearMessages()
          return ''
        })
        client.sendCommand('get_histories', {})
      }
    })

    audio.setHandlers({
      onStart(item) {
        actions.setAudioPlaying(true)
        eventBus.emit('audio:start', {
          turnId: item.turnId,
          sequence: item.sequence,
          durationMs: item.durationMs ?? 0,
        })
      },
      onEnd(turnId) {
        actions.setAudioPlaying(false)
        eventBus.emit('audio:end', { turnId })
      },
      onVolume(vol) {
        diagnosticRun?.probe.recordVolume(vol)
        eventBus.emit('audio:volume', { volume: vol })
      },
    })

    // Load persisted settings on startup
    fetch('/api/settings').then(r => r.json()).then(data => {
      const s = data.settings || {}
      for (const [key, value] of Object.entries(s)) {
        try { actions.setSetting(key as keyof AppSettings, value) } catch (_) {}
      }
      // Sync proactive to backend (handles case where WS already connected)
      if (clientRef.current) {
        if ('proactive' in s) {
          clientRef.current.sendCommand('set_proactive', { enabled: s.proactive })
        }
        if ('proactiveIdleTime' in s) {
          clientRef.current.sendCommand('set_proactive_idle', { seconds: s.proactiveIdleTime })
        }
        if ('screenVisionEnabled' in s) {
          clientRef.current.sendCommand('set_screen_vision', { enabled: s.screenVisionEnabled })
        }
        if ('voiceCameraEnabled' in s) {
          clientRef.current.sendCommand('set_vision_source', { source: 'voice_camera', enabled: s.voiceCameraEnabled })
        }
        if ('voiceScreenEnabled' in s) {
          clientRef.current.sendCommand('set_vision_source', { source: 'voice_screen', enabled: s.voiceScreenEnabled })
        }
        if ('textCameraEnabled' in s) {
          clientRef.current.sendCommand('set_vision_source', { source: 'text_camera', enabled: s.textCameraEnabled })
        }
        if ('textScreenEnabled' in s) {
          clientRef.current.sendCommand('set_vision_source', { source: 'text_screen', enabled: s.textScreenEnabled })
        }
      }
      if ('alwaysOnTop' in s) {
        window.electronAPI?.setAlwaysOnTop(Boolean(s.alwaysOnTop))
      }
      if ('windowMode' in s) {
        window.electronAPI?.setPetMode(s.windowMode === 'pet')
      }
      const persistedModel = resolvePersistedLive2DModel(s)
      const startupModel = localStorage.getItem('live2d_model_name')
        || (window as any).__INITIAL_MODEL_INFO__?.name
      void synchronizeStartupLive2DModel(persistedModel, startupModel || '')
        .catch(error => eventBus.emit('character:runtime-telemetry', {
          type: 'model.startup-sync-failed',
          metadata: { message: error instanceof Error ? error.message : String(error) },
        }))
    }).catch(() => {})

    client.connect()

    // Listen for accessory events
    const unsubAccessoryLoaded = eventBus.on('accessory:loaded', ({ parts, state }) => {
      setAccessoryParts(parts)
      setAccessoryState(state)
    })
    const unsubAccessoryChanged = eventBus.on('accessory:state_changed', ({ parts, state }) => {
      setAccessoryParts(parts)
      setAccessoryState(state)
    })

    return () => {
      unsub1(); unsub2(); unsub3(); unsub4(); unsub5(); unsub6()
      unsub7(); unsub8(); unsub10(); unsub11(); unsub12()
      unsubDiagnostic(); unsubDiagnosticDebug()
      unsubActivity(); unsubIntent(); unsubTurnMessage()
      unsubAccessoryLoaded(); unsubAccessoryChanged()
      if (diagnosticRun?.stopTimer) clearTimeout(diagnosticRun.stopTimer)
      if (diagnosticRun?.finishTimer) clearTimeout(diagnosticRun.finishTimer)
      if (cameraSampleTimerRef.current) clearInterval(cameraSampleTimerRef.current)
      cameraSession.stop()
      client.disconnect(); void audio.dispose()
    }
  }, [])

  useEffect(() => {
    if (!AudioRecorder.isSupported()) return
    const recorder = new AudioRecorder()
    recorderRef.current = recorder
    recorder.setCallbacks({
      onData(samples, sampleRate) { clientRef.current?.sendAudioSamples(samples, sampleRate) },
      onEnd() {
        stopCameraSampling()
        const attachments = cameraAttachmentsRef.current
        cameraAttachmentsRef.current = []
        clientRef.current?.sendAudioEnd(attachments)
        if (cameraAutoOpenedRef.current) {
          cameraAutoOpenedRef.current = false
          setCameraWindowOpen(false)
          cameraSession.stop()
        }
      },
      onError(message) {
        console.warn('[Mic]', message)
        stopCameraSampling()
        cameraAttachmentsRef.current = []
        if (cameraAutoOpenedRef.current) {
          cameraAutoOpenedRef.current = false
          setCameraWindowOpen(false)
          cameraSession.stop()
        }
      },
      onStateChange(state) { setRecorderState(state) },
    })
    return () => {
      recorder.stop()
      recorderRef.current = null
    }
  }, [])

  const stopCameraSampling = useCallback(() => {
    if (cameraSampleTimerRef.current) {
      clearInterval(cameraSampleTimerRef.current)
      cameraSampleTimerRef.current = null
    }
  }, [])

  const ensureCameraSamplingStarted = useCallback(() => {
    stopCameraSampling()
    cameraAttachmentsRef.current = []
    const policy = visualPolicyRef.current
    const interval = policy.cameraSampleIntervalMs ?? DEFAULT_VISUAL_POLICY.cameraSampleIntervalMs ?? 2000
    const maxFrames = policy.cameraMaxFrames ?? DEFAULT_VISUAL_POLICY.cameraMaxFrames ?? 4
    cameraSampleTimerRef.current = setInterval(() => {
      if (cameraAttachmentsRef.current.length >= maxFrames) {
        stopCameraSampling()
        return
      }
      void cameraSession.captureFrame()
        .then(file => file ? uploadVisualAttachment(file, 'camera') : null)
        .then(attachment => {
          if (attachment) cameraAttachmentsRef.current.push(attachment)
        })
        .catch(() => {})
    }, interval)
  }, [stopCameraSampling])

  const closeCameraWindow = useCallback(() => {
    setCameraWindowOpen(false)
    cameraSession.stop()
    stopCameraSampling()
    cameraAttachmentsRef.current = []
    cameraAutoOpenedRef.current = false
  }, [stopCameraSampling])

  const toggleCameraWindow = useCallback(() => {
    if (cameraWindowOpen) {
      closeCameraWindow()
      return
    }
    setCameraWindowOpen(true)
  }, [cameraWindowOpen, closeCameraWindow])

  const handleSend = useCallback(async (input: VisualComposerInput): Promise<boolean> => {
    const { text, images } = input
    const client = clientRef.current
    const audio = audioRef.current
    if (!client) return false

    const attachments = [...images]
    const cameraKeptOpen = cameraWindowOpen || cameraAutoOpenedRef.current
    if (settingsRef.current.cameraEnabled && settingsRef.current.textCameraEnabled) {
      try {
        const policy = visualPolicyRef.current
        const maxImages = policy.maxImages ?? DEFAULT_VISUAL_POLICY.maxImages ?? 4
        if (attachments.length < maxImages) {
          const frame = await cameraSession.captureFrame()
          if (frame) {
            const attachment = await uploadVisualAttachment(frame, 'camera')
            if (attachment) attachments.push(attachment)
          }
        }
      } catch (error) {
        console.warn('[Camera] text turn camera frame skipped', error)
      } finally {
        if (!cameraKeptOpen) cameraSession.stop()
      }
    }

    const sent = attachments.length > 0
      ? client.sendVisual(text, attachments)
      : client.sendText(text)
    if (!sent) return false
    // Ensure AudioContext is ready (browser autoplay policy)
    audio?.resume()
    actions.setStatusMessage('Processing...')
    actions.addMessage({
      id: nextId(),
      role: 'user',
      text,
      imageCount: attachments.length || undefined,
      timestamp: Date.now(),
    })
    actions.addMessage({ id: nextId(), role: 'assistant', text: '', timestamp: Date.now() })
    return true
  }, [actions, cameraWindowOpen])

  const handleInterrupt = useCallback(() => {
    const client = clientRef.current
    const audio = audioRef.current
    audio?.stop()
    client?.sendInterrupt()
    actions.setStatusMessage('')
  }, [])

  const handleToggleRecording = useCallback(async () => {
    const recorder = recorderRef.current
    if (!recorder) return
    if (recorder.state === 'recording') {
      recorder.stop()
      return
    }
    const s = settingsRef.current
    if (s.cameraEnabled && s.voiceCameraEnabled) {
      cameraAutoOpenedRef.current = true
      setCameraWindowOpen(true)
      await cameraSession.ensureStarted().catch(() => {})
      ensureCameraSamplingStarted()
    }
    await recorder.start()
  }, [ensureCameraSamplingStarted])

  const handleAccessoryToggle = useCallback((label: string, enabled: boolean) => {
    // Keep the controlled checkbox responsive even if the renderer is between
    // generations; CharacterController will immediately confirm the same state.
    setAccessoryState(current => ({ ...current, [label]: enabled }))
    eventBus.emit('accessory:set', { label, enabled })
  }, [])

  const handleSettingChange = useCallback((key: string, value: unknown) => {
    const client = clientRef.current
    actions.setSetting(key as keyof AppSettings, value)

    if (key === 'alwaysOnTop') {
      window.electronAPI?.setAlwaysOnTop(value as boolean)
    } else if (key === 'activeCharacterId') {
      client?.sendCommand('switch_character', { character_id: value })
    } else if (key === 'live2dModel') {
      // Keep the bridge mapper aligned with the visual model. The LLM remains
      // model-agnostic, but its semantic intent must map through this profile.
      fetch('/api/set-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: value }),
      }).catch(() => {})
      eventBus.emit('character:switch_model', { name: value as string })
    } else if (key === 'proactive') {
      client?.sendCommand('set_proactive', { enabled: value })
    } else if (key === 'proactiveIdleTime') {
      client?.sendCommand('set_proactive_idle', { seconds: value })
    } else if (key === 'screenVisionEnabled') {
      client?.sendCommand('set_screen_vision', { enabled: value })
    } else if (key === 'cameraEnabled') {
      if (!value) closeCameraWindow()
      client?.sendCommand('set_vision_source', { source: 'voice_camera', enabled: Boolean(value) && settings.voiceCameraEnabled })
      client?.sendCommand('set_vision_source', { source: 'text_camera', enabled: Boolean(value) && settings.textCameraEnabled })
    } else if (key === 'voiceCameraEnabled') {
      client?.sendCommand('set_vision_source', { source: 'voice_camera', enabled: value })
    } else if (key === 'voiceScreenEnabled') {
      client?.sendCommand('set_vision_source', { source: 'voice_screen', enabled: value })
    } else if (key === 'textCameraEnabled') {
      client?.sendCommand('set_vision_source', { source: 'text_camera', enabled: value })
    } else if (key === 'textScreenEnabled') {
      client?.sendCommand('set_vision_source', { source: 'text_screen', enabled: value })
    } else if (key === 'windowMode') {
      const windowMode = value === 'pet' ? 'pet' : 'window'
      const previousWindowMode = settings.windowMode === 'pet' ? 'pet' : 'window'
      document.body.style.cursor = windowMode === 'pet' ? 'default' : ''
      void persistAndApplyWindowMode(settings as unknown as Record<string, unknown>, windowMode, {
        async persist(nextSettings) {
          const response = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: nextSettings }),
          })
          if (!response.ok) throw new Error(`settings save failed: ${response.status}`)
        },
        setPetMode(enabled) {
          return window.electronAPI?.setPetMode(enabled)
        },
      }).catch(error => {
        document.body.style.cursor = previousWindowMode === 'pet' ? 'default' : ''
        actions.setSetting('windowMode', previousWindowMode)
        actions.setStatusMessage(`窗口模式切换失败：${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }, [actions, settings, closeCameraWindow])

  useEffect(() => {
    return window.electronAPI?.onPetExitRequest?.(() => {
      handleSettingChange('windowMode', 'window')
    })
  }, [handleSettingChange])

  useEffect(() => {
    if (surface !== 'pet-model') return
    electronWindowBridge.publishPetSnapshot({
      messages,
      activity,
      connection,
      statusMessage,
      ttsActive,
      settings: {
        voiceInputEnabled: settings.voiceInputEnabled,
        windowMode: 'pet',
      },
      recorderState,
      recordingSupported: AudioRecorder.isSupported(),
    })
  }, [
    surface,
    messages,
    activity,
    connection,
    statusMessage,
    ttsActive,
    settings.voiceInputEnabled,
    recorderState,
  ])

  useEffect(() => {
    if (surface !== 'pet-model') return
    return electronWindowBridge.onPetCommand(command => {
      if (command.type === 'send') handleSend({ text: command.text, images: [] })
      else if (command.type === 'interrupt') handleInterrupt()
      else if (command.type === 'toggle-recording') void handleToggleRecording()
    })
  }, [surface, handleSend, handleInterrupt, handleToggleRecording, handleSettingChange])

  const handleCharacterActivate = useCallback(async (
    character: CharacterDescriptor,
    runtimeAlreadySwitched = false,
  ) => {
    const client = clientRef.current
    if (!client && !runtimeAlreadySwitched) throw new Error('runtime disconnected')
    const previousModel = settings.live2dModel
    const nextModel = character.live2dModel
    let modelSwitched = false
    try {
      if (nextModel && nextModel !== previousModel) {
        const response = await fetch('/api/set-model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: nextModel }),
        })
        if (!response.ok) throw new Error(`Live2D model switch failed: ${response.status}`)
        modelSwitched = true
        await requestLive2DModelLoad(nextModel)
      }
      if (!runtimeAlreadySwitched) {
        await client!.requestCommand('switch_character', { character_id: character.id })
      }
      actions.setSetting('activeCharacterId', character.id)
      if (nextModel) {
        actions.setSetting('live2dModel', nextModel)
      }
      if (client) {
        await client.requestCommand('get_histories', {}).catch(() => {})
      }
    } catch (error) {
      if (modelSwitched && previousModel) {
        try {
          const rollback = await fetch('/api/set-model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: previousModel }),
          })
          if (!rollback.ok) {
            throw new Error(`Live2D rollback failed: ${rollback.status}`)
          }
        } catch (rollbackError) {
          const originalMessage = error instanceof Error ? error.message : String(error)
          const rollbackMessage = rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError)
          throw new Error(`${originalMessage}; ${rollbackMessage}`)
        }
      }
      throw error
    }
  }, [actions, settings.live2dModel])

  // Apply the UI theme (dark/light/auto + accent preset). Server-persisted
  // settings are authoritative once loaded; invalid or missing values fall
  // back to the dark defaults. applyUiTheme also refreshes the localStorage
  // cache consumed by the pre-mount anti-flash script in index.html.
  useEffect(() => {
    const mode = isUiThemeMode(settings.uiTheme) ? settings.uiTheme : 'dark'
    const accentKey = typeof settings.accentColor === 'string' && settings.accentColor
      ? settings.accentColor
      : DEFAULT_ACCENT_KEY
    return applyUiTheme(mode, accentKey)
  }, [settings.uiTheme, settings.accentColor])

  // Persist settings to backend whenever they change
  useEffect(() => {
    const timer = setTimeout(() => {
      fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings }),
      }).catch(() => {})
    }, 500)
    return () => clearTimeout(timer)
  }, [settings])

  // Apply model-specific performance tuning after settings/model/profile changes.
  useEffect(() => {
    const tuning = normalizeLive2DPerformanceSettings(
      settings.live2dPerformanceProfiles?.[settings.live2dModel],
      readModelPerformanceDefaults(settings.live2dModel),
    )
    eventBus.emit('character:performance_tuning', tuning)
  }, [settings.live2dModel, settings.live2dPerformanceProfiles])

  useEffect(() => {
    eventBus.emit('character:actions_update', {
      model: settings.live2dModel,
      actions: settings.live2dActions?.[settings.live2dModel] ?? [],
    })
  }, [settings.live2dModel, settings.live2dActions])

  // Resume AudioContext on first user gesture (browser autoplay policy)
  const handleUserGesture = useCallback(() => {
    const audio = audioRef.current
    audio?.resume()
  }, [])

  if (surface === 'pet-model') {
    return (
      <div style={styles.wrapper} onClick={handleUserGesture}>
        <PetModelSurface />
        <PermissionDialog />
      </div>
    )
  }

  return (
    <div style={styles.wrapper} onClick={handleUserGesture}>
      {settings.windowMode !== 'pet' && <TitleBar />}
      <CompanionWorkspace
        settings={settings}
        requestCommand={(action, params = {}) => {
          const client = clientRef.current
          return client
            ? client.requestCommand(action, params)
            : Promise.reject(new Error('runtime disconnected'))
        }}
        recorderState={recorderState}
        recordingSupported={AudioRecorder.isSupported()}
         onToggleRecording={handleToggleRecording}
        cameraWindowOpen={cameraWindowOpen}
        onCameraWindowToggle={toggleCameraWindow}
        histories={histories}
        historyUid={historyUid}
        historyLoading={historyLoading}
        historyRevision={historyRevision}
      subtitleText={subtitleText}
      subtitleSpeaking={ttsActive}
        accessoryParts={accessoryParts}
        accessoryState={accessoryState}
        onSend={handleSend}
        onInterrupt={handleInterrupt}
        onLoadHistory={(uid) => {
          setHistoryLoading(true)
          void clientRef.current?.requestCommand('load_history', { history_uid: uid })
            .catch(() => setHistoryLoading(false))
        }}
        onDeleteHistory={(uid) => {
          setHistoryLoading(true)
          void clientRef.current?.requestCommand('delete_history', { history_uid: uid })
            .catch(() => setHistoryLoading(false))
        }}
        onCreateHistory={() => {
          setHistoryLoading(true)
          void clientRef.current?.requestCommand('create_history', {})
            .catch(() => setHistoryLoading(false))
        }}
        onSettingChange={handleSettingChange}
        onCharacterActivate={handleCharacterActivate}
        onAccessoryToggle={handleAccessoryToggle}
      />
      {settings.windowMode !== 'pet' && <StatusBar />}
      <CameraWindow open={cameraWindowOpen} onClose={closeCameraWindow} />
      <PermissionDialog />
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: { height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' },
}

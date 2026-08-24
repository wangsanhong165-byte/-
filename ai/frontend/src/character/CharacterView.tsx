// Character View — Live2D model display component with ModelManager
// Uses CubismWebFramework for rendering

import { memo, useRef, useEffect, useState, useCallback } from 'react'
import { useSelector, selectCharacter, selectSettings } from '../core/store'
import { theme } from '../core/theme'
import { eventBus } from '../core/event-bus'
import { initRenderer, resizeRenderer, destroyRenderer, render, setViewOffset, setViewScale, resetView, getViewTransform, getRenderEnvironment } from './live2d/renderer'
import { ModelManager, type ModelState } from './live2d/ModelManager'
import { CharacterController } from './controllers'
import { initCubismFramework, disposeCubismFramework } from './live2d/core'
import { PetModeController } from './PetModeController'
import { AvatarController } from './AvatarController'
import { ComponentManager } from './ComponentManager'
import { Live2DModelAdapter } from './Live2DModelAdapter'
import { observeElementResize } from './observe-resize'
import { normalizeAvatarViewport } from './AvatarCapabilityProfile'
import { resolveLive2DRenderDpr } from './Live2DPerformanceSettings'
import { isWindowDragging } from './window-drag-state'
import {
  getViewportStorageKey,
  readPersistedViewport,
  savePersistedViewport,
  type ViewportScope,
} from './live2d/viewport-persistence'

function modelUrl(name: string): string {
  return `/live2d-models/${name}/${name}.model3.json`
}

function applyModelViewport(modelName: string, scope: ViewportScope): void {
  const profiles = (window as any).__INITIAL_MODEL_INFO__?.avatarProfiles as
    | Record<string, {
      viewport?: { x?: number; y?: number; scale?: number }
      petViewport?: { x?: number; y?: number; scale?: number }
    }>
    | undefined
  let persisted
  try {
    persisted = readPersistedViewport(window.localStorage, modelName, scope)
  } catch (_) {
    persisted = undefined
  }
  const profile = profiles?.[modelName]
  const configured = scope === 'pet' ? profile?.petViewport : profile?.viewport
  const viewport = normalizeAvatarViewport(persisted ?? configured)
  resetView()
  setViewScale(viewport.scale)
  setViewOffset(viewport.x, viewport.y)
}

function persistModelViewport(modelName: string, scope: ViewportScope): void {
  if (!modelName) return
  try {
    savePersistedViewport(window.localStorage, modelName, getViewTransform(), scope)
  } catch (_) {}
}

/** Initialize components from avatar config or fallback to legacy accessories.
 *  Looks up per-model config from the full avatar config injected by the server. */
function _initComponents(compMgr: ComponentManager, ctrl: CharacterController,
                         modelName: string): void {
  // Clear previous model's accessory state to avoid stale labels
  ctrl.clearAccessories()

  try {
    const initInfo = (window as any).__INITIAL_MODEL_INFO__
    const avatarCfg = initInfo?.avatar

    // Per-model config: look up modelName key in the full avatar_cfg dict
    const modelCfg = (avatarCfg && typeof avatarCfg === 'object' && avatarCfg[modelName])
      ? avatarCfg[modelName]
      : (avatarCfg?.components ? avatarCfg : null)

    if (modelCfg) {
      const avatarComponents = modelCfg.components

      // Build parts/state arrays regardless of whether components are empty.
      // IMPORTANT: When components is {} (empty), still emit empty state to clear UI.
      // Do NOT fall through to legacy fallback — that uses the INITIAL model's
      // accessories, not the switched-to model's.
      const parts: Record<string, string> = {}
      const state: Record<string, boolean> = {}
      if (avatarComponents) {
        for (const [key, cfg] of Object.entries(avatarComponents)) {
          const c = cfg as Record<string, any>
          const label = c.display_name || key
          // Always add to parts so SettingsPanel can render the toggle list.
          // For expression-based components, use the expression name as value.
          // For param_ids/part_ids components, use the key as a placeholder
          // (ComponentManager handles actual parameter changes via the change callback).
          parts[label] = c.expression || key
          state[label] = c.default_state ?? false
        }
      }

      // Set accessory parts on the controller so toggle works.
      // NOTE: setAccessoryParts always sets state=true; we fix it below.
      ctrl.setAccessoryParts(parts)
      const availableParts = ctrl.getAccessoryParts()
      for (const label of Object.keys(state)) {
        if (!(label in availableParts)) delete state[label]
      }
      const registeredComponents = avatarComponents
        ? Object.fromEntries(Object.entries(avatarComponents).filter(([key, cfg]) => {
          const label = (cfg as Record<string, any>).display_name || key
          return label in availableParts
        }))
        : {}
      // Override the all-true default_state with actual config values
      for (const [label, enabled] of Object.entries(state)) {
        ctrl.setAccessoryEnabled(label, enabled)
      }

      // Register components if there are any
      if (Object.keys(registeredComponents).length > 0) {
        compMgr.attach(ctrl.mixer)
        compMgr.registerComponents(registeredComponents)
      }

      // ── Persist component state on change ──
      const _saveComponentState = () => {
        try {
          localStorage.setItem(`live2d_components_${modelName}`, JSON.stringify(ctrl.getAccessoryState()))
        } catch (_) {}
      }

      ctrl.onAccessoryChange((label, enabled) => {
        if (Object.keys(registeredComponents).length > 0) {
          const compKey = Object.entries(registeredComponents).find(
            ([, cfg]) => (cfg as any).display_name === label
          )?.[0] || label
          compMgr.setEnabled(compKey, enabled)
        }
        eventBus.emit('accessory:state_changed', {
          label, enabled,
          parts: ctrl.getAccessoryParts(),
          state: ctrl.getAccessoryState(),
        })
        _saveComponentState()
      })

      // ── Restore persisted component state over defaults ──
      try {
        const saved = localStorage.getItem(`live2d_components_${modelName}`)
        if (saved) {
          const parsed: Record<string, boolean> = JSON.parse(saved)
          for (const [label, enabled] of Object.entries(parsed)) {
            if (label in state) {  // only restore known components
              state[label] = enabled
              ctrl.setAccessoryEnabled(label, enabled)
            }
          }
          // If ComponentManager has registered components, sync them too
          if (Object.keys(registeredComponents).length > 0) {
            for (const [label, enabled] of Object.entries(parsed)) {
              const compKey = Object.entries(registeredComponents).find(
                ([, cfg]) => (cfg as any).display_name === label
              )?.[0]
              if (compKey && label in state) {
                compMgr.setEnabled(compKey, enabled)
              }
            }
          }
        }
      } catch (_) {}

      // Emit using the restored state, NOT ctrl.getAccessoryState() which always returns all-true.
      eventBus.emit('accessory:loaded', { parts: { ...availableParts }, state: { ...state } })
      return  // ← CRITICAL: don't fall through to legacy fallback
    }

    // Legacy fallback (no per-model config found)
    if (initInfo?.accessories) {
      ctrl.setAccessoryParts(initInfo.accessories as Record<string, string>)
      ctrl.resetAccessories()
      ctrl.onAccessoryChange((label, enabled) => {
        eventBus.emit('accessory:state_changed', {
          label, enabled,
          parts: ctrl.getAccessoryParts(),
          state: ctrl.getAccessoryState(),
        })
      })
      eventBus.emit('accessory:loaded', {
        parts: ctrl.getAccessoryParts(),
        state: ctrl.getAccessoryState(),
      })
    } else {
      // No components for this model — emit empty state to clear UI
      eventBus.emit('accessory:loaded', { parts: {}, state: {} })
    }
  } catch (_) {}
}

export const CharacterView = memo(function CharacterView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ctrlRef = useRef<CharacterController | null>(null)
  const avatarRef = useRef<AvatarController | null>(null)
  const componentMgrRef = useRef<ComponentManager | null>(null)
  const modelMgrRef = useRef<ModelManager | null>(null)
  const adapterRef = useRef<Live2DModelAdapter | null>(null)
  const modelNameRef = useRef('')
  const animRef = useRef<number>(0)
  const animRunningRef = useRef(false)     // guards against duplicate animation loops
  const lastTimeRef = useRef(0)
  const [loadState, setLoadState] = useState<ModelState>('unloaded')
  const character = useSelector(selectCharacter)
  const settings = useSelector(selectSettings)
  const { emotion, activity } = character
  const mountCount = useRef(0)
  // Drag and zoom state
  const dragRef = useRef({ isDragging: false, didMove: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0, scale: 1 })
  const petModeRef = useRef(settings.windowMode === 'pet')
  petModeRef.current = settings.windowMode === 'pet'
  // Guards against duplicate event handlers and animation loops
  const petInitRef = useRef(false)
  const clickCountRef = useRef(0)          // total click events processed (debug)
  const clickFeedbackRef = useRef(true)    // gate: model reacts to click/drag interactions

  // Build the model URL from a model name
  const getModelUrl = useCallback((modelName?: string): string => {
    if (modelName) return modelUrl(modelName)
    // Model memory: use persisted model from localStorage, fall back to server default
    const saved = localStorage.getItem('live2d_model_name')
    if (saved) return modelUrl(saved)
    return (window as any).__INITIAL_MODEL_INFO__?.url
      || '/live2d-models/Design_genius_White/Design_genius_White.model3.json'
  }, [])

  // Initialize Live2D once
  useEffect(() => {
    mountCount.current += 1
    console.log('[CharacterView] useEffect mount #', mountCount.current)

    const canvas = canvasRef.current
    if (!canvas) return

    let alive = true        // guards against stale async completions (StrictMode double-mount)

    // Initialize CubismFramework (singleton, idempotent)
    initCubismFramework()

    const ctrl = new CharacterController()
    const modelMgr = new ModelManager()
    const avatarCtrl = new AvatarController()
    const compMgr = new ComponentManager()
    const adapter = new Live2DModelAdapter()
    ctrlRef.current = ctrl
    modelMgrRef.current = modelMgr
    avatarRef.current = avatarCtrl
    componentMgrRef.current = compMgr
    adapterRef.current = adapter

    // Wire AvatarController to CharacterController + ComponentManager
    // so server-side avatar protocol messages drive actual model parameters
    avatarCtrl.wire(ctrl, compMgr)
    avatarCtrl.attach()

    if (!initRenderer(canvas)) {
      setLoadState('error')
      return
    }

    const emitRenderEnvironment = () => {
      const environment = getRenderEnvironment()
      if (environment) eventBus.emit('character:render_environment', environment)
    }
    const unsubRenderEnvironmentRequest = eventBus.on(
      'character:render_environment_request',
      emitRenderEnvironment,
    )

    let attachedGeneration = 0
    const attachCommittedModel = (expectedName: string, generation: number): boolean => {
      const handle = modelMgr.getModel()
      const renderer = modelMgr.getRenderer()
      const diagnostics = modelMgr.getDiagnostics()
      const profiles = (window as any).__INITIAL_MODEL_INFO__?.avatarProfiles as
        | Record<string, { model?: string }>
        | undefined
      const profileModel = profiles?.[expectedName]?.model ?? ''
      const hasProfile = Boolean(profiles?.[expectedName])
      const consistent = Boolean(handle && renderer)
        && diagnostics.requestedModel === expectedName
        && diagnostics.loadedModel === expectedName
        && (!hasProfile || profileModel === expectedName)
        && diagnostics.generation === generation
        && diagnostics.rendererGeneration === generation
      console.log('[Live2D] load identity', { ...diagnostics, profileModel })
      if (!consistent) {
        console.error('[Live2D] refusing mismatched model attach', {
          expectedName, ...diagnostics, profileModel,
        })
        setLoadState('error')
        return false
      }
      if (attachedGeneration === generation && adapter.isAttached) return true

      ctrl.detach()
      adapter.detach()
      applyModelViewport(expectedName, petModeRef.current ? 'pet' : 'stage')
      modelNameRef.current = expectedName
      ctrl.setModelName(expectedName, modelMgr.getExpressionNames())
      ctrl.setNativeMotionPlayer(modelMgr.getNativeMotionPlayer())
      adapter.attach(handle!)
      adapter.setPoseController(modelMgr.getPoseController())
      ctrl.attach(adapter, generation)
      _initComponents(compMgr, ctrl, expectedName)
      syncLive2dSettings(ctrl, settings)
      ctrl.exprCtrl.apply('neutral', 1, 0)
      attachedGeneration = generation
      return true
    }

    // --- Async model loader ---
    ;(async () => {
      setLoadState('loading')
      if (!(window as any).__INITIAL_MODEL_INFO__) {
        try {
          const response = await fetch('/api/model-info')
          if (response.ok) {
            ;(window as any).__INITIAL_MODEL_INFO__ = await response.json()
            console.log('[Live2D] Loaded development model configuration')
          }
        } catch (error) {
          console.warn('[Live2D] Development model configuration unavailable:', error)
        }
      }
      const url = (window as any).__PENDING_MODEL_URL__ || getModelUrl()
      delete (window as any).__PENDING_MODEL_URL__

      const result = await modelMgr.load(url)
      if (!alive) return                     // StrictMode unmounted us
      if (result.status === 'superseded') return
      if (result.status !== 'loaded' || !modelMgr.getModel()) {
        setLoadState('unavailable')
        return
      }

      const modelName = result.modelName
      if (!attachCommittedModel(modelName, result.generation)) return
      eventBus.emit('character:interaction', { type: 'presence', intensity: 0.4 })
      eventBus.emit('character:interaction', {
        type: 'time',
        value: new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening',
        intensity: 0.3,
      })

      const hDiag = modelMgr.getModel()!
      console.log('[Live2D] model loaded: canvas=%dx%d, params=%d',
        hDiag.canvasWidth, hDiag.canvasHeight,
        hDiag.frameworkModel.getParameterCount())
      setLoadState('loaded')
      emitRenderEnvironment()
    })()

      let running = true
      function animate(time: number) {
        if (!running) return
        const previousFrameTime = lastTimeRef.current
        const intervalMs = previousFrameTime > 0 ? Math.max(0, time - previousFrameTime) : 0
        const dt = Math.min(intervalMs / 1000, 0.05)
        lastTimeRef.current = time

      const workStarted = performance.now()
      ctrl.update(dt)
      const controllerDone = performance.now()
      ctrl.mixer.resolve()
      ctrl.mixer.apply(adapter)
      const mixDone = performance.now()
      adapter.updateModel(dt)
      const modelDone = performance.now()

      const h2 = adapter.getHandleForRenderer()
      if (h2) {
        render(h2, modelMgr.getRenderer())
      }
      const renderDone = performance.now()
        if (previousFrameTime > 0) {
          ctrl.recordFrameTiming({
            intervalMs,
            workMs: renderDone - workStarted,
            controllerMs: controllerDone - workStarted,
            mixMs: mixDone - controllerDone,
            modelMs: modelDone - mixDone,
            renderMs: renderDone - modelDone,
          })
        }

      animRef.current = requestAnimationFrame(animate)
    }
    // Guard: cancel any existing animation loop before starting a new one.
    // Prevents double animation loops (StrictMode double-mount, rapid model switch).
    if (animRunningRef.current) {
      cancelAnimationFrame(animRef.current)
    }
      animRunningRef.current = true
      lastTimeRef.current = 0
      animRef.current = requestAnimationFrame(animate)
    console.log('[Live2D] animation loop started')

    // ── Mouse tracking (always follow cursor, no click needed) ──
    const getMousePos = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1   // -1..1
      const y = ((e.clientY - rect.top) / rect.height) * -2 + 1   // 1..-1 (flip Y)
      return { x, y }
    }

    const onMouseEnter = (e: MouseEvent) => {
      const { x, y } = getMousePos(e)
      ctrl.setMousePos(x, y)
    }

    const onMouseMove = (e: MouseEvent) => {
      // Skip mouse tracking during drag to prevent character from "drifting"
      if (dragRef.current.isDragging) return
      const { x, y } = getMousePos(e)
      ctrl.setMousePos(x, y)
    }

    const onMouseLeave = () => {
      if (dragRef.current.isDragging) return
      ctrl.resetMousePosition()  // Return to center without changing enabled state
    }

    canvas.addEventListener('mouseenter', onMouseEnter)
    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('mouseleave', onMouseLeave)

    // ── Drag to pan ──
    const onMouseDown = (e: MouseEvent) => {
      if (petModeRef.current) return
      const drag = dragRef.current
      drag.isDragging = true
      drag.didMove = false
      drag.startX = e.clientX
      drag.startY = e.clientY
      drag.offsetX = getViewTransform().x
      drag.offsetY = getViewTransform().y
      canvas.style.cursor = 'grabbing'
    }

    const onMouseUp = () => {
      const drag = dragRef.current
      if (!drag.isDragging) return
      drag.isDragging = false
      canvas.style.cursor = ''
      if (drag.didMove) {
        persistModelViewport(modelNameRef.current, petModeRef.current ? 'pet' : 'stage')
        if (clickFeedbackRef.current) {
          eventBus.emit('character:interaction', { type: 'drag', phase: 'end', intensity: 0.2 })
        }
      }
    }

    const onDragMove = (e: MouseEvent) => {
      if (petModeRef.current) return
      const drag = dragRef.current
      if (!drag.isDragging) return
      if (!drag.didMove && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) >= 4) {
        drag.didMove = true
        if (clickFeedbackRef.current) {
          eventBus.emit('character:interaction', { type: 'drag', phase: 'start', intensity: 0.25 })
        }
      }
      if (!drag.didMove) return
      const dx = (e.clientX - drag.startX) / canvas.clientWidth * 2
      const dy = (e.clientY - drag.startY) / canvas.clientHeight * 2
      setViewOffset(drag.offsetX + dx, drag.offsetY - dy)
    }

    const onWheel = (e: WheelEvent) => {
      if (petModeRef.current) return
      e.preventDefault()
      const t = getViewTransform()
      const delta = e.deltaY > 0 ? 0.9 : 1.1
      setViewScale(t.scale * delta)
      persistModelViewport(modelNameRef.current, petModeRef.current ? 'pet' : 'stage')
    }

    // Touch support for pinch zoom
    let lastTouchDist = 0
    let touchScaleAtStart = 1
    const onTouchStart = (e: TouchEvent) => {
      if (petModeRef.current) return
      if (e.touches.length === 2) {
        lastTouchDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY,
        )
        touchScaleAtStart = getViewTransform().scale
      }
    }
    const onTouchMove = (e: TouchEvent) => {
      if (petModeRef.current) return
      if (e.touches.length === 2) {
        e.preventDefault()
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY,
        )
        setViewScale(touchScaleAtStart * (dist / lastTouchDist))
      }
    }
    const onTouchEnd = () => {
      if (petModeRef.current) return
      if (lastTouchDist > 0) {
        persistModelViewport(modelNameRef.current, 'stage')
        lastTouchDist = 0
      }
    }

    canvas.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('mousemove', onDragMove)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('touchstart', onTouchStart, { passive: true })
    canvas.addEventListener('touchmove', onTouchMove, { passive: false })
    canvas.addEventListener('touchend', onTouchEnd)
    canvas.addEventListener('touchcancel', onTouchEnd)

    // Listen for accessory toggle from SettingsPanel
    const unsubAccessoryToggle = eventBus.on('accessory:toggle', ({ label }) => {
      ctrl.toggleAccessory(label)
    })

    // Listen for AI-controlled accessory changes (must sync with UI)
    const unsubAccessorySet = eventBus.on('accessory:set', ({ label, enabled }) => {
      ctrl.setAccessoryEnabled(label, enabled)
    })

    // Listen for state refresh request (when settings panel opens)
    const unsubAccessoryRefresh = eventBus.on('accessory:refresh', () => {
      // Re-emit current state to sync UI
      const parts = ctrl.getAccessoryParts()
      const state = ctrl.getAccessoryState()
      if (Object.keys(parts).length > 0) {
        eventBus.emit('accessory:state_changed', {
          label: '', enabled: false, parts, state,
        })
      }
    })

    const unsubViewportReset = eventBus.on('character:viewport_reset', () => {
      const modelName = modelNameRef.current
      if (!modelName) return
      const scope: ViewportScope = petModeRef.current ? 'pet' : 'stage'
      try { window.localStorage.removeItem(getViewportStorageKey(modelName, scope)) } catch (_) {}
      resetView()
      const profiles = (window as any).__INITIAL_MODEL_INFO__?.avatarProfiles as
        | Record<string, {
          viewport?: { x?: number; y?: number; scale?: number }
          petViewport?: { x?: number; y?: number; scale?: number }
        }>
        | undefined
      const profile = profiles?.[modelName]
      const viewport = normalizeAvatarViewport(scope === 'pet' ? profile?.petViewport : profile?.viewport)
      setViewScale(viewport.scale)
      setViewOffset(viewport.x, viewport.y)
    })

    // Listen for model switch
    const unsubModel = eventBus.on('character:switch_model', async ({ name, requestId }) => {
      const url = modelUrl(name)
      setLoadState('loading')

      const result = await modelMgr.load(url)
      if (!alive) return
      if (result.status === 'superseded') {
        if (requestId) eventBus.emit('character:model_load_result', {
          name, requestId, status: 'superseded', message: 'A newer model load replaced this request',
        })
        return
      }
      if (result.status !== 'loaded' || !modelMgr.getModel()) {
        setLoadState('unavailable')
        if (requestId) eventBus.emit('character:model_load_result', {
          name,
          requestId,
          status: 'failed',
          message: result.status === 'failed'
            ? `Cubism could not load ${name}: ${String(result.error)}`
            : `Cubism could not load ${name}`,
        })
        return
      }

      if (!attachCommittedModel(name, result.generation)) {
        if (requestId) eventBus.emit('character:model_load_result', {
          name, requestId, status: 'failed', message: `Cubism could not attach ${name}`,
        })
        return
      }
      eventBus.emit('character:interaction', { type: 'scene', value: `model:${name}`, intensity: 0.28 })
      setLoadState('loaded')
      if (requestId) eventBus.emit('character:model_load_result', {
        name, requestId, status: 'loaded',
      })

      // Persist model name so next session remembers it
      try { localStorage.setItem('live2d_model_name', name) } catch (_) {}

    })

    return () => {
      alive = false
      unsubAccessoryToggle()
      unsubAccessorySet()
      unsubAccessoryRefresh()
      unsubViewportReset()
      unsubModel()
      unsubRenderEnvironmentRequest()
      animRunningRef.current = false
      cancelAnimationFrame(animRef.current)
      if (canvas) {
        canvas.removeEventListener('mouseenter', onMouseEnter)
        canvas.removeEventListener('mousemove', onMouseMove)
        canvas.removeEventListener('mouseleave', onMouseLeave)
        canvas.removeEventListener('mousedown', onMouseDown)
        canvas.removeEventListener('wheel', onWheel)
        canvas.removeEventListener('touchstart', onTouchStart)
        canvas.removeEventListener('touchmove', onTouchMove)
        canvas.removeEventListener('touchend', onTouchEnd)
        canvas.removeEventListener('touchcancel', onTouchEnd)
      }
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('mousemove', onDragMove)
      resetView()
      modelNameRef.current = ''
      if (ctrlRef.current) {
        ctrlRef.current.detach()
        ctrlRef.current = null
      }
      if (modelMgrRef.current) {
        modelMgrRef.current.unload()
        modelMgrRef.current = null
      }
      if (avatarRef.current) {
        avatarRef.current.detach()
        avatarRef.current = null
      }
      if (componentMgrRef.current) {
        componentMgrRef.current.detach()
        componentMgrRef.current = null
      }
      if (adapterRef.current) {
        adapterRef.current.detach()
        adapterRef.current = null
      }
      destroyRenderer()
      disposeCubismFramework()
    }
  }, [getModelUrl])

  // ── Sync Live2D settings to CharacterController ──
  const syncLive2dSettings = useCallback((ctrl: CharacterController | null, s: typeof settings) => {
    if (!ctrl) return
    ctrl.idleCtrl.setBlinking(s.live2dBlink)
    ctrl.idleCtrl.setBreathing(s.live2dBreathe)
    ctrl.lipSync.setEnabled(s.live2dLipSync)
    ctrl.setMouseTracking(s.live2dHeadTracking)
    ctrl.exprCtrl.setEnabled(s.live2dExpression)
    ctrl.idleCtrl.setIdleEnabled(s.live2dIdle)
    clickFeedbackRef.current = s.live2dClickFeedback
  }, [])

  useEffect(() => {
    syncLive2dSettings(ctrlRef.current, settings)
  }, [
    settings.live2dBlink,
    settings.live2dBreathe,
    settings.live2dLipSync,
    settings.live2dHeadTracking,
    settings.live2dExpression,
    settings.live2dIdle,
    settings.live2dClickFeedback,
    syncLive2dSettings,
  ])

  useEffect(() => {
    const modelName = modelNameRef.current
    if (!modelName) return
    applyModelViewport(modelName, settings.windowMode === 'pet' ? 'pet' : 'stage')
  }, [settings.windowMode])

  // ── Pet Mode wiring (guarded against duplicate registration) ──
  useEffect(() => {
    // Guard: if petInitRef is already true, the cleanup from the previous
    // render cycle did NOT run, meaning we have a duplicate registration.
    if (petInitRef.current) {
      console.warn('[PET] Duplicate init detected — skipping (already registered)')
      return
    }
    petInitRef.current = true

    const petCtrl = new PetModeController()
    let browserAudioActive = false
    console.log('[PET] Instance #%d created (windowMode=%s loadState=%s)',
      petCtrl.instanceId, settings.windowMode, loadState)

    // Enable/disable based on windowMode setting
    if (settings.windowMode === 'pet') {
      petCtrl.enable()
    } else {
      petCtrl.disable()
    }

    // Canvas click → pet interaction (single handler, verified)
    // Important: skip if user was dragging (pan/zoom gesture, not a click)
    const canvas = canvasRef.current
    const onPetClick = () => {
      // Ignore click if the user was dragging the canvas
      if (dragRef.current.isDragging || dragRef.current.didMove) {
        dragRef.current.didMove = false
        return
      }
      clickCountRef.current += 1
      if (!clickFeedbackRef.current) return
      eventBus.emit('character:interaction', { type: 'touch', region: 'unknown', intensity: 0.42 })
      console.log('[PET] Click #%d → onInteraction() (ctrl instance #%d)',
        clickCountRef.current, petCtrl.instanceId)
      petCtrl.onInteraction()
    }
    if (canvas) {
      canvas.addEventListener('click', onPetClick)
    }

    // Detect speaking from character:activity
    const unsubActivity = eventBus.on('character:activity', ({ activity }) => {
      if (activity === 'speaking') {
        petCtrl.onSpeakingStart()
      } else if (activity === 'idle' && !browserAudioActive) {
        petCtrl.onSpeakingEnd()
      }
    })
    const unsubAudioStart = eventBus.on('audio:start', () => {
      browserAudioActive = true
      petCtrl.onSpeakingStart()
    })
    const unsubAudioEnd = eventBus.on('audio:end', () => {
      browserAudioActive = false
      petCtrl.onSpeakingEnd()
    })

    return () => {
      console.log('[PET] Cleanup #%d', petCtrl.instanceId)
      petCtrl.disable()
      if (canvas) {
        canvas.removeEventListener('click', onPetClick)
      }
      unsubActivity()
      unsubAudioStart()
      unsubAudioEnd()
      petInitRef.current = false
    }
  }, [settings.windowMode])

  // Resize handler
  useEffect(() => {
    const cvs = canvasRef.current
    if (!cvs) return
    const doResize = () => {
      // During a window drag the window size is pinned, but the reported size
      // still jitters by a pixel or two as the DWM re-measures the frameless
      // frame. Re-fitting the model on every such event makes it flicker and
      // churns the renderer, so skip it while a drag is active.
      if (isWindowDragging()) return
      const parent = cvs.parentElement
      if (!parent) return
      const w = parent.clientWidth
      const h = parent.clientHeight
      if (w <= 0 || h <= 0) return
      const dpr = resolveLive2DRenderDpr(window.devicePixelRatio)
      const pixelWidth = Math.round(w * dpr)
      const pixelHeight = Math.round(h * dpr)
      const cssWidth = `${w}px`
      const cssHeight = `${h}px`
      if (
        cvs.width === pixelWidth
        && cvs.height === pixelHeight
        && cvs.style.width === cssWidth
        && cvs.style.height === cssHeight
      ) return
      cvs.width = pixelWidth
      cvs.height = pixelHeight
      cvs.style.width = cssWidth
      cvs.style.height = cssHeight
      resizeRenderer(pixelWidth, pixelHeight)
      const environment = getRenderEnvironment()
      if (environment) eventBus.emit('character:render_environment', environment)
    }

    doResize()
    window.addEventListener('resize', doResize)
    const stopObserving = containerRef.current
      ? observeElementResize(containerRef.current, doResize)
      : () => {}
    return () => {
      window.removeEventListener('resize', doResize)
      stopObserving()
    }
  }, [])

  const showFallback = loadState === 'unavailable'

  return (
    <div ref={containerRef} style={styles.container}>
      <canvas ref={canvasRef} style={styles.canvas} />
      {showFallback && (
        <div style={styles.fallback}>
          <div style={styles.fallbackEmoji}>🐱</div>
          <div style={styles.emotionLabel}>{emotion}</div>
          <div style={styles.activityLabel}>{activity}</div>
          <div style={styles.hint}>Live2D model not loaded</div>
        </div>
      )}
      {loadState === 'loading' && (
        <div style={styles.loading}>Loading model...</div>
      )}
    </div>
  )
})

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: '100%',
    height: '100%',
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  canvas: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    touchAction: 'none',
    backgroundColor: theme.colors.bg.root,
  },
  fallback: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    zIndex: 1,
    userSelect: 'none',
    pointerEvents: 'none',
  },
  fallbackEmoji: {
    fontSize: '5rem',
    filter: 'drop-shadow(0 4px 8px rgba(0,0,0,0.3))',
  },
  emotionLabel: {
    fontSize: '1.1rem',
    fontWeight: 600,
    color: theme.colors.accent,
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
    textShadow: '0 2px 8px rgba(0,0,0,0.5)',
  },
  activityLabel: {
    fontSize: '0.85rem',
    color: theme.colors.text.secondary,
    fontStyle: 'italic',
  },
  hint: {
    fontSize: '0.75rem',
    color: theme.colors.text.muted,
    marginTop: 8,
  },
  loading: {
    color: theme.colors.text.secondary,
    fontSize: '0.9rem',
    zIndex: 1,
  },
}

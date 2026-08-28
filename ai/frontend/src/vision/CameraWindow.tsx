import { useCallback, useEffect, useRef, useState } from 'react'

import { cameraSession } from './camera-session'

const POSITION_KEY = 'camera-window-position-v1'
const WINDOW_WIDTH = 220
const MIN_VIEWPORT_MARGIN = 8
const MIN_VISIBLE_HEIGHT = 160

interface CameraWindowPosition {
  left?: number
  top?: number
}

function clampPosition(value: CameraWindowPosition): CameraWindowPosition {
  if (typeof window === 'undefined') return value
  const left = value.left ?? MIN_VIEWPORT_MARGIN
  const top = value.top ?? MIN_VIEWPORT_MARGIN
  const maxLeft = Math.max(MIN_VIEWPORT_MARGIN, window.innerWidth - WINDOW_WIDTH - MIN_VIEWPORT_MARGIN)
  const maxTop = Math.max(MIN_VIEWPORT_MARGIN, window.innerHeight - MIN_VISIBLE_HEIGHT - MIN_VIEWPORT_MARGIN)
  return {
    left: Math.min(Math.max(left, MIN_VIEWPORT_MARGIN), maxLeft),
    top: Math.min(Math.max(top, MIN_VIEWPORT_MARGIN), maxTop),
  }
}

function readSavedPosition(): CameraWindowPosition | null {
  try {
    const raw = localStorage.getItem(POSITION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CameraWindowPosition>
    if (typeof parsed.left !== 'number' || typeof parsed.top !== 'number') return null
    return clampPosition({ left: parsed.left, top: parsed.top })
  } catch {
    return null
  }
}

function describeCameraError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return '摄像头权限未授予，请在系统/浏览器设置中允许访问摄像头后重试'
    }
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
      return '未检测到可用摄像头'
    }
    if (error.name === 'NotReadableError') {
      return '摄像头被其他应用占用，请关闭占用后重试'
    }
  }
  return error instanceof Error ? error.message : '摄像头启动失败'
}

export interface CameraWindowProps {
  open: boolean
  onClose: () => void
}

export function CameraWindow({ open, onClose }: CameraWindowProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const dragRef = useRef<{ startX: number; startY: number; left: number; top: number } | null>(null)
  const [position, setPosition] = useState<CameraWindowPosition | null>(readSavedPosition)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)

  const startPreview = useCallback(() => {
    setError('')
    setStarting(true)
    void cameraSession.ensureStarted().then(() => {
      if (videoRef.current) cameraSession.attachPreview(videoRef.current)
    }).catch(reason => {
      setError(describeCameraError(reason))
    }).finally(() => {
      setStarting(false)
    })
  }, [])

  useEffect(() => {
    if (!open) return
    let disposed = false
    // Attach immediately when a stream is already running (e.g. voice sampling
    // opened it); otherwise start one. The catch no longer auto-closes the
    // window: the user still sees the window and a retryable error message.
    if (cameraSession.active) {
      if (videoRef.current) cameraSession.attachPreview(videoRef.current)
      return () => {
        if (videoRef.current) cameraSession.detachPreview(videoRef.current)
      }
    }
    setError('')
    setStarting(true)
    void cameraSession.ensureStarted().then(() => {
      if (!disposed && videoRef.current) {
        cameraSession.attachPreview(videoRef.current)
      }
    }).catch(reason => {
      if (!disposed) setError(describeCameraError(reason))
    }).finally(() => {
      if (!disposed) setStarting(false)
    })
    return () => {
      disposed = true
      if (videoRef.current) cameraSession.detachPreview(videoRef.current)
    }
  }, [open])

  useEffect(() => {
    return () => {
      const drag = dragRef.current
      if (drag) {
        window.removeEventListener('pointermove', moveDrag)
        window.removeEventListener('pointerup', endDrag)
      }
    }
  }, [])

  function moveDrag(event: PointerEvent) {
    const drag = dragRef.current
    if (!drag) return
    setPosition(clampPosition({
      left: drag.left + event.clientX - drag.startX,
      top: drag.top + event.clientY - drag.startY,
    }))
  }

  function endDrag(event: PointerEvent) {
    const drag = dragRef.current
    if (!drag) return
    const next = clampPosition({
      left: drag.left + event.clientX - drag.startX,
      top: drag.top + event.clientY - drag.startY,
    })
    dragRef.current = null
    setPosition(next)
    try {
      localStorage.setItem(POSITION_KEY, JSON.stringify(next))
    } catch {
      // localStorage can be unavailable in private mode; dragging still works.
    }
    window.removeEventListener('pointermove', moveDrag)
    window.removeEventListener('pointerup', endDrag)
  }

  if (!open) return null

  const current = position ?? {}
  const style: React.CSSProperties = {
    position: 'fixed',
    width: WINDOW_WIDTH,
    zIndex: 130,
  }
  if (typeof current.left === 'number' && typeof current.top === 'number') {
    style.left = current.left
    style.top = current.top
  } else {
    style.right = 16
    style.bottom = 16
  }

  return (
    <div className="camera-window" style={style} role="dialog" aria-label="摄像头预览">
      <div className="camera-window-header" onPointerDown={(event) => {
        event.preventDefault()
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
        dragRef.current = {
          startX: event.clientX,
          startY: event.clientY,
          left: current.left ?? rect.left,
          top: current.top ?? rect.top,
        }
        window.addEventListener('pointermove', moveDrag)
        window.addEventListener('pointerup', endDrag)
      }}>
        <span>摄像头预览</span>
        <button
          type="button"
          className="camera-window-close"
          onClick={onClose}
          aria-label="关闭摄像头"
          title="关闭"
        >
          &times;
        </button>
      </div>
      {error
        ? (
          <div className="camera-window-body" role="alert">
            <p>{error}</p>
            <button type="button" className="camera-window-retry" onClick={startPreview} disabled={starting}>
              {starting ? '启动中…' : '重试'}
            </button>
          </div>
        )
        : (
          <video ref={videoRef} autoPlay muted playsInline aria-label="摄像头画面" />
        )}
    </div>
  )
}
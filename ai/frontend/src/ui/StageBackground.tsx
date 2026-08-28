import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppSettings } from '../core/store'
import { eventBus } from '../core/event-bus'
import { electronWindowBridge } from '../session/electron-window-bridge'

/**
 * Wallpaper fusion layer.
 *
 * Renders the selected background as a fixed, window-wide layer sunk below
 * the app frame (z-index -2) with a scrim above it (-1); the glass panels
 * live in CSS keyed off html[data-wallpaper='on']. This replaces the old
 * stage-scoped background so all three columns share one backdrop.
 *
 * Playback control (WE-style occlusion pause):
 *   - pauseOnHidden: window minimized / tab switched away → decode stops.
 *   - pauseOnBlur: another app took focus (wallpaper likely covered).
 *   - pauseOnVision: vision-turn audio sampling + LLM inference in flight —
 *     the freed decode budget goes to the camera/inference pipeline.
 *   - playbackRate: native speed multiplier (muted media, no A/V sync cost).
 *
 * Media kinds:
 *   image → <img>
 *   video → <video> (hardware-decoded loop; scene wallpapers arrive here
 *           too when the host extracted an embedded MP4)
 *   web   → <iframe sandbox="allow-scripts"> (WE API shim injected by host)
 */
export function StageBackground({ settings }: { settings: AppSettings }) {
  const [, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const pausedByRef = useRef<{ hidden: boolean; blur: boolean; vision: boolean }>({
    hidden: false, blur: false, vision: false,
  })

  const url = settings.backgroundUrl
  const kind = settings.backgroundType

  // ── fps-cap transcode upgrade: play the original now, swap when ready ────
  // The transcode runs once on the host (path+mtime+fps cached); switching
  // sources mid-play just replaces the src (muted loop, no continuity cost).
  const [sourceUrl, setSourceUrl] = useState(url)
  useEffect(() => {
    setSourceUrl(url)
    if (kind !== 'video' || !url || !settings.wallpaperFpsCap || !electronWindowBridge.available) return
    if (!settings.backgroundPath) return
    let disposed = false
    void (async () => {
      const info = await electronWindowBridge.wallpaperMediaInfo(settings.backgroundPath)
      if (disposed || !info.ok || !info.info?.fps || info.info.fps <= settings.wallpaperFpsCap + 0.01) return
      const result = await electronWindowBridge.wallpaperTranscode(settings.backgroundPath, settings.wallpaperFpsCap)
      if (!disposed && result.ok && result.url) setSourceUrl(result.url)
    })()
    return () => { disposed = true }
  }, [url, kind, settings.backgroundPath, settings.wallpaperFpsCap])

  useEffect(() => {
    setLoadState('loading')
    eventBus.emit('background:status', { state: 'loading' })
  }, [settings.backgroundUrl, settings.backgroundType])

  // ── Playback controller: pause when ANY active condition holds ──────────
  const syncPlayback = useRef(() => {
    const video = videoRef.current
    if (!video) return
    const pausedBy = pausedByRef.current
    const shouldPause = pausedBy.hidden || pausedBy.blur || pausedBy.vision
    if (shouldPause) {
      if (!video.paused) video.pause()
    } else if (video.paused && !document.hidden) {
      // Resume only via play() promise — autoplay policy needs the catch.
      video.play().catch(() => {})
    }
  }).current

  useEffect(() => {
    const onVisibility = () => {
      pausedByRef.current.hidden = settings.wallpaperPauseOnHidden && document.hidden
      syncPlayback()
    }
    const onBlur = () => {
      pausedByRef.current.blur = settings.wallpaperPauseOnBlur && !document.hasFocus()
      syncPlayback()
    }
    const onFocus = () => {
      pausedByRef.current.blur = false
      syncPlayback()
    }
    let offVisionStart = () => {}
    if (settings.wallpaperPauseOnVision) {
      offVisionStart = eventBus.on('vision:turn', ({ active }) => {
        pausedByRef.current.vision = active
        syncPlayback()
      })
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    // Initial state.
    pausedByRef.current.hidden = settings.wallpaperPauseOnHidden && document.hidden
    pausedByRef.current.blur = settings.wallpaperPauseOnBlur && !document.hasFocus()
    pausedByRef.current.vision = false
    syncPlayback()
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      offVisionStart()
    }
  }, [
    settings.wallpaperPauseOnHidden,
    settings.wallpaperPauseOnBlur,
    settings.wallpaperPauseOnVision,
    settings.backgroundType,
    settings.backgroundUrl,
    syncPlayback,
  ])

  // Playback rate follows settings instantly (no media reload needed).
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const rate = Number(settings.wallpaperPlaybackRate)
    if (Number.isFinite(rate) && rate > 0 && rate <= 4) {
      try { video.playbackRate = rate } catch { /* unsupported value */ }
    }
  }, [settings.wallpaperPlaybackRate, sourceUrl])

  const active = kind !== 'none' && Boolean(url)

  if (!active) return null

  // Media element style: legacy opacity knob + the fit-mode setting wired to
  // the CSS variable the fusion stylesheet reads (--wp-object-fit).
  const fit = settings.backgroundFit === 'cover' || settings.backgroundFit === 'fill'
    ? settings.backgroundFit
    : 'contain'
  const style = {
    opacity: settings.backgroundOpacity,
    ['--wp-object-fit' as string]: fit,
  } as React.CSSProperties

  return createPortal(
    <>
      <div className="wp-layer" aria-hidden="true">
        {kind === 'video' ? (
          <video
            ref={videoRef}
            key={sourceUrl}
            className="wp-media"
            src={sourceUrl}
            style={style}
            autoPlay
            loop
            muted
            playsInline
            onCanPlay={() => {
              setLoadState('ready')
              eventBus.emit('background:status', { state: 'ready' })
            }}
            onError={() => {
              setLoadState('error')
              eventBus.emit('background:status', { state: 'error', message: '视频无法播放，请换用 MP4/WebM 文件。' })
            }}
          />
        ) : kind === 'web' ? (
          <iframe
            key={url}
            className="wp-media wp-iframe"
            src={url}
            style={style}
            title="壁纸"
            frameBorder={0}
            scrolling="no"
            sandbox="allow-scripts"
          />
        ) : (
          <img
            key={url}
            className="wp-media"
            src={url}
            style={style}
            alt=""
            onLoad={() => {
              setLoadState('ready')
              eventBus.emit('background:status', { state: 'ready' })
            }}
            onError={() => {
              setLoadState('error')
              eventBus.emit('background:status', { state: 'error', message: '图片加载失败，请重新选择资源。' })
            }}
          />
        )}
      </div>
      <div className="wp-scrim" aria-hidden="true" style={style} />
    </>,
    document.body,
  )
}

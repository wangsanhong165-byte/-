import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppSettings } from '../core/store'
import { eventBus } from '../core/event-bus'

/**
 * Wallpaper fusion layer.
 *
 * Renders the selected background as a fixed, window-wide layer sunk below
 * the app frame (z-index -2) with a scrim above it (-1); the glass panels
 * live in CSS keyed off html[data-wallpaper='on']. This replaces the old
 * stage-scoped background so all three columns share one backdrop.
 *
 * Media kinds:
 *   image  → <img>
 *   video  → <video> (loop, muted, paused while occluded — Phase 3)
 *   web    → <iframe sandbox="allow-scripts"> + WE API no-op shim (Phase 2)
 *   scene  → embedded MP4 when the host extracted one, else static preview
 */
export function StageBackground({ settings }: { settings: AppSettings }) {
  const [, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')

  useEffect(() => {
    setLoadState('loading')
    eventBus.emit('background:status', { state: 'loading' })
  }, [settings.backgroundUrl, settings.backgroundType])

  const url = settings.backgroundUrl
  const kind = settings.backgroundType
  const active = kind !== 'none' && Boolean(url)

  if (!active) return null

  const style = { opacity: settings.backgroundOpacity } as const

  return createPortal(
    <>
      <div className="wp-layer" aria-hidden="true">
        {kind === 'video' ? (
          <video
            key={url}
            className="wp-media"
            src={url}
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

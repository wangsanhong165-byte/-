import { useEffect, useState } from 'react'
import type { AppSettings } from '../core/store'
import { eventBus } from '../core/event-bus'

export function StageBackground({ settings }: { settings: AppSettings }) {
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')

  useEffect(() => {
    setLoadState('loading')
    eventBus.emit('background:status', { state: 'loading' })
  }, [settings.backgroundUrl, settings.backgroundType])

  if (settings.backgroundType === 'none' || !settings.backgroundUrl) return null

  const style = { opacity: settings.backgroundOpacity } as const

  return (
    <div className={`stage-background is-${loadState} fit-${settings.backgroundFit}`} aria-hidden="true">
      {settings.backgroundType === 'video' ? (
        <video
          key={settings.backgroundUrl}
          className="stage-background-media"
          src={settings.backgroundUrl}
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
      ) : (
        <img
          key={settings.backgroundUrl}
          className="stage-background-media"
          src={settings.backgroundUrl}
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
      <div className="stage-background-shade" style={{ opacity: Math.max(0, 1 - settings.backgroundOpacity) * 0.35 }} />
    </div>
  )
}

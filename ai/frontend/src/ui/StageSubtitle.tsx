import { useEffect, useState } from 'react'

import { stageSubtitleAutoHideDelay, toStageSubtitle } from './stage-subtitle'

export function StageSubtitle({ text, speaking = false }: { text: string; speaking?: boolean }) {
  const [visibleText, setVisibleText] = useState('')

  useEffect(() => {
    const subtitle = toStageSubtitle(text)
    if (!subtitle) return
    setVisibleText(subtitle)
    const delay = stageSubtitleAutoHideDelay(speaking)
    if (delay === null) return
    const timer = window.setTimeout(() => setVisibleText(''), delay)
    return () => window.clearTimeout(timer)
  }, [text, speaking])

  return (
    <div className={`stage-subtitle ${visibleText ? 'is-visible' : ''}`} aria-live="polite">
      {visibleText && <p>{visibleText}</p>}
    </div>
  )
}

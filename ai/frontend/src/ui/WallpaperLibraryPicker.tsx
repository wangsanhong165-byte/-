import { useCallback, useEffect, useMemo, useState } from 'react'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import { theme } from '../core/theme'
import {
  electronWindowBridge,
  type WallpaperInventoryResult,
  type WallpaperLibraryEntry,
  type WallpaperResourceResult,
} from '../session/electron-window-bridge'

/**
 * wallpaper://asset/ URL for a whitelisted file (preview thumbnails). Matches
 * the host's base64url token encoding.
 */
function wallpaperAssetUrl(filePath: string): string {
  const bytes = new TextEncoder().encode(filePath)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const token = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `wallpaper://asset/${token}`
}

/**
 * Wallpaper Engine library picker: a thumbnail grid over the full inventory
 * (playable entries only), with type badges and one-click WE playlist import.
 * Picking delegates to the host (which whitelists + resolves scene media)
 * and surfaces the resource exactly like a manual file selection.
 */

const TYPE_BADGES: Record<WallpaperLibraryEntry['type'], string> = {
  video: '视频',
  web: '网页',
  scene: '场景',
  application: '应用',
}

const styles = {
  container: {
    display: 'flex', flexDirection: 'column', gap: theme.spacing.sm, minHeight: 0,
  } as const,
  toolbar: {
    display: 'flex', alignItems: 'center', gap: theme.spacing.sm, flexWrap: 'wrap' as const,
  } as const,
  refreshButton: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '5px 10px', borderRadius: theme.radius.sm,
    border: `1px solid ${theme.colors.border}`, backgroundColor: 'transparent',
    color: theme.colors.text.secondary, cursor: 'pointer', fontSize: theme.fontSize.xs,
  } as const,
  summary: {
    color: theme.colors.text.muted, fontSize: theme.fontSize.xs,
  } as const,
  grid: {
    display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: theme.spacing.sm, maxHeight: 320, overflowY: 'auto',
    padding: 2,
  } as const,
  card: {
    display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0,
    padding: 8, borderRadius: theme.radius.md,
    border: `1px solid ${theme.colors.border}`, backgroundColor: theme.colors.bg.panel,
    cursor: 'pointer', textAlign: 'left' as const,
  } as const,
  cardActive: {
    borderColor: theme.colors.accent,
  } as const,
  thumb: {
    width: '100%', aspectRatio: '16 / 9', objectFit: 'cover' as const,
    borderRadius: theme.radius.sm, display: 'block',
    backgroundColor: theme.colors.bg.root,
  } as const,
  thumbEmpty: {
    width: '100%', aspectRatio: '16 / 9',
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.bg.root,
    display: 'grid', placeItems: 'center',
    color: theme.colors.text.muted, fontSize: 10,
  } as const,
  title: {
    color: theme.colors.text.primary, fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  } as const,
  badgeRow: {
    display: 'flex', gap: 5, alignItems: 'center',
  } as const,
  badge: {
    padding: '1px 6px', borderRadius: theme.radius.full,
    border: `1px solid ${theme.colors.border}`,
    color: theme.colors.text.muted, fontSize: 10, lineHeight: 1.6,
  } as const,
  playlistRow: {
    display: 'flex', flexDirection: 'column', gap: 6,
    padding: 8, borderRadius: theme.radius.md,
    border: `1px solid ${theme.colors.border}`, backgroundColor: theme.colors.bg.panel,
  } as const,
  playlistButton: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    width: '100%', padding: '6px 8px', borderRadius: theme.radius.sm,
    border: `1px solid ${theme.colors.border}`, backgroundColor: 'transparent',
    color: theme.colors.text.secondary, cursor: 'pointer', fontSize: theme.fontSize.xs,
  } as const,
  status: {
    color: theme.colors.text.muted, fontSize: theme.fontSize.xs, lineHeight: 1.5,
  } as const,
}

export function WallpaperLibraryPicker({ onPicked }: {
  onPicked: (result: WallpaperResourceResult) => void
}) {
  const [loading, setLoading] = useState(true)
  const [inventory, setInventory] = useState<WallpaperInventoryResult['inventory'] | null>(null)
  const [message, setMessage] = useState('')
  const [pickingId, setPickingId] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setMessage('')
    try {
      const result = await electronWindowBridge.wallpaperInventory()
      if (result.ok && result.inventory) {
        setInventory(result.inventory)
        if (!result.inventory.playableCount) {
          setMessage('没有找到可播放的 Wallpaper Engine 壁纸——请确认 Steam 与壁纸引擎已安装且已有壁纸。')
        }
      } else {
        setInventory(null)
        setMessage(result.message || '壁纸库不可用。')
      }
    } catch (error) {
      setInventory(null)
      setMessage(`壁纸库读取失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const playable = useMemo(
    () => (inventory?.wallpapers ?? []).filter(w => w.playable),
    [inventory],
  )

  const pick = useCallback(async (wallpaper: WallpaperLibraryEntry) => {
    setPickingId(wallpaper.id)
    try {
      const result = await electronWindowBridge.wallpaperPick(wallpaper)
      if (result.ok) {
        onPicked(result)
      } else {
        setMessage(result.message || '选择这张壁纸失败。')
      }
    } finally {
      setPickingId('')
    }
  }, [onPicked])

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <button type="button" style={styles.refreshButton} onClick={() => void load()} disabled={loading}>
          {loading
            ? <LoaderCircle size={13} className="is-spinning" aria-hidden="true" />
            : <RefreshCw size={13} aria-hidden="true" />}
          刷新壁纸库
        </button>
        {inventory && (
          <span style={styles.summary}>
            {inventory.playableCount} 个可播放 · 共 {inventory.total} 个
            {inventory.installDir ? '' : ' · 未定位到壁纸引擎安装'}
          </span>
        )}
      </div>

      {message && <div style={styles.status}>{message}</div>}

      {inventory?.playlists?.length ? (
        <div style={styles.playlistRow}>
          <span style={styles.status}>Wallpaper Engine 播放列表（点击按顺序切换）</span>
          {inventory.playlists.map(playlist => (
            <button
              key={playlist.id}
              type="button"
              style={styles.playlistButton}
              onClick={() => {
                const first = playable.find(w => playlist.wallpaperIds.includes(w.id))
                if (first) void pick(first)
                else setMessage('这个播放列表里没有可播放的壁纸。')
              }}
              title={`按顺序切换：${playlist.wallpaperIds.length} 项`}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{playlist.name}</span>
              <span style={{ flexShrink: 0, color: theme.colors.text.muted }}>{playlist.playableCount}/{playlist.total}</span>
            </button>
          ))}
        </div>
      ) : null}

      {playable.length > 0 && (
        <div style={styles.grid} role="listbox" aria-label="Wallpaper Engine 壁纸库">
          {playable.map(wallpaper => (
            <button
              key={wallpaper.id}
              type="button"
              role="option"
              aria-selected={false}
              style={styles.card}
              onClick={() => void pick(wallpaper)}
              disabled={pickingId === wallpaper.id}
              title={`${wallpaper.title}（${TYPE_BADGES[wallpaper.type]}）`}
            >
              {wallpaper.previewPath ? (
                <img
                  style={styles.thumb}
                  src={wallpaperAssetUrl(wallpaper.previewPath)}
                  alt=""
                  loading="lazy"
                  onError={event => { (event.currentTarget as HTMLImageElement).style.display = 'none' }}
                />
              ) : (
                <div style={styles.thumbEmpty}>无预览</div>
              )}
              <span style={styles.title}>{wallpaper.title}</span>
              <span style={styles.badgeRow}>
                <span style={styles.badge}>{TYPE_BADGES[wallpaper.type]}</span>
                {pickingId === wallpaper.id && (
                  <span style={styles.badge}>提取中…</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

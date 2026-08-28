import type { RecorderState } from '../audio/recorder'
import type { AppSettings } from '../core/store'
import type { AiActivity, ChatMessage, ConnectionState } from '../core/types'

export interface PetConversationSnapshot {
  messages: ChatMessage[]
  activity: AiActivity
  connection: ConnectionState
  statusMessage: string
  ttsActive: boolean
  settings: Pick<AppSettings, 'voiceInputEnabled' | 'windowMode'>
  recorderState: RecorderState
  recordingSupported: boolean
}

export type PetSurfaceCommand =
  | { type: 'send'; text: string }
  | { type: 'interrupt' }
  | { type: 'toggle-recording' }

declare global {
  interface Window {
    electronAPI?: {
      platform: string
      minimize: () => void
      maximize: () => Promise<boolean> | boolean
      isMaximized: () => Promise<boolean> | boolean
      close: () => void
      setAlwaysOnTop: (value: boolean) => void
      setPetMode: (enabled: boolean) => void | Promise<unknown>
      startWindowDrag: () => void
      endWindowDrag: () => void
      publishPetSnapshot?: (snapshot: PetConversationSnapshot) => void
      getPetSnapshot?: () => Promise<PetConversationSnapshot | null>
      sendPetCommand?: (command: PetSurfaceCommand) => void
      setPetConversationVisible?: (visible: boolean) => void
      resizePetModel?: (scaleFactor: number) => void
      onPetSnapshot?: (callback: (snapshot: PetConversationSnapshot) => void) => () => void
      onPetCommand?: (callback: (command: PetSurfaceCommand) => void) => () => void
      getSettings: () => Record<string, unknown>
      getElectronPerformanceDiagnostics?: () => Promise<ElectronPerformanceDiagnostics>
      onPetExitRequest?: (callback: () => void) => () => void
      selectCharacterAsset?: (kind: string) => Promise<string>
      selectWallpaper?: (mode: 'file' | 'directory') => Promise<WallpaperResourceResult>
      openWallpaperWorkshop?: () => Promise<{ ok: boolean; path?: string; message?: string }>
      wallpaperInventory?: () => Promise<WallpaperInventoryResult>
      wallpaperPick?: (wallpaper: WallpaperLibraryEntry) => Promise<WallpaperResourceResult>
      getStatus?: () => Promise<{ services?: Array<Record<string, unknown>> }>
      onLifecycleSnapshot?: (callback: (snapshot: {
        availability?: string
        services?: Array<Record<string, unknown>>
      }) => void) => () => void
    }
  }
}

export interface ElectronPerformanceDiagnostics {
  capturedAt: string
  forceHighPerformanceGpu: boolean
  hardwareAccelerationEnabled: boolean | null
  gpuFeatureStatus: Record<string, string>
  gpuInfo: Record<string, unknown> | null
  gpuInfoError: string | null
  display: {
    id: number
    label: string
    displayFrequency: number
    scaleFactor: number
    size: { width: number; height: number }
    workArea: { x: number; y: number; width: number; height: number }
  } | null
  window: {
    visible: boolean
    minimized: boolean
    focused: boolean
    petMode: boolean
    bounds: { x: number; y: number; width: number; height: number }
    backgroundThrottling: boolean
  } | null
}

export interface WallpaperResourceResult {
  ok: boolean
  code?: string
  message?: string
  path?: string
  url?: string
  type?: 'image' | 'video' | 'web'
  sourceType?: string
  label?: string
  previewFallback?: boolean
  warning?: string
}

/** One wallpaper in the Wallpaper Engine library inventory. */
export interface WallpaperLibraryEntry {
  id: string
  title: string
  type: 'scene' | 'video' | 'web' | 'application'
  playable: boolean
  entryPath: string | null
  previewPath: string | null
}

export interface WallpaperPlaylist {
  id: string
  name: string
  order: 'sequence' | 'random'
  delay: number | null
  wallpaperIds: string[]
  total: number
  playableCount: number
}

export interface WallpaperInventoryResult {
  ok: boolean
  message?: string
  inventory?: {
    installDir: string | null
    total: number
    playableCount: number
    wallpapers: WallpaperLibraryEntry[]
    playlists: WallpaperPlaylist[]
  }
}

export class ElectronWindowBridge {
  get available(): boolean {
    return typeof window !== 'undefined' && Boolean(window.electronAPI)
  }

  minimize() { return window.electronAPI?.minimize?.() }
  maximize() { return window.electronAPI?.maximize?.() }
  isMaximized() { return window.electronAPI?.isMaximized?.() }
  close() { return window.electronAPI?.close?.() }
  setAlwaysOnTop(value: boolean) { return window.electronAPI?.setAlwaysOnTop?.(value) }
  setPetMode(value: boolean) { return window.electronAPI?.setPetMode?.(value) }
  onPetExitRequest(callback: () => void) { return window.electronAPI?.onPetExitRequest?.(callback) ?? (() => {}) }
  startWindowDrag() { return window.electronAPI?.startWindowDrag?.() }
  endWindowDrag() { return window.electronAPI?.endWindowDrag?.() }
  publishPetSnapshot(snapshot: PetConversationSnapshot) { return window.electronAPI?.publishPetSnapshot?.(snapshot) }
  getPetSnapshot() { return window.electronAPI?.getPetSnapshot?.() ?? Promise.resolve(null) }
  sendPetCommand(command: PetSurfaceCommand) { return window.electronAPI?.sendPetCommand?.(command) }
  setPetConversationVisible(visible: boolean) { return window.electronAPI?.setPetConversationVisible?.(visible) }
  resizePetModel(scaleFactor: number) { return window.electronAPI?.resizePetModel?.(scaleFactor) }
  onPetSnapshot(callback: (snapshot: PetConversationSnapshot) => void) {
    return window.electronAPI?.onPetSnapshot?.(callback) ?? (() => {})
  }
  onPetCommand(callback: (command: PetSurfaceCommand) => void) {
    return window.electronAPI?.onPetCommand?.(callback) ?? (() => {})
  }
  selectWallpaper(mode: 'file' | 'directory') {
    return window.electronAPI?.selectWallpaper?.(mode) ?? Promise.resolve({ ok: false, code: 'unavailable' })
  }
  openWallpaperWorkshop() {
    return window.electronAPI?.openWallpaperWorkshop?.() ?? Promise.resolve({ ok: false, message: '仅桌面版支持此功能。' })
  }
  wallpaperInventory() {
    return window.electronAPI?.wallpaperInventory?.() ?? Promise.resolve({ ok: false, message: '仅桌面版支持壁纸库。' })
  }
  wallpaperPick(wallpaper: WallpaperLibraryEntry) {
    return window.electronAPI?.wallpaperPick?.(wallpaper)
      ?? Promise.resolve<WallpaperResourceResult>({ ok: false, code: 'unavailable' })
  }
  getStatus() {
    return window.electronAPI?.getStatus?.() ?? Promise.resolve({ ready: false, services: [] })
  }
  getPerformanceDiagnostics() {
    return window.electronAPI?.getElectronPerformanceDiagnostics?.() ?? Promise.resolve(null)
  }
}

export const electronWindowBridge = new ElectronWindowBridge()

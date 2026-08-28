// Electron preload — exposed APIs for the renderer process
// Combines window controls + ProcessManager lifecycle APIs.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,

  // ── Window controls ──
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  close: () => ipcRenderer.invoke('window:close'),
  setAlwaysOnTop: (value) => ipcRenderer.invoke('window:setAlwaysOnTop', value),
  setPetMode: (enabled) => ipcRenderer.invoke('window:setPetMode', enabled),
  startWindowDrag: () => ipcRenderer.send('window:dragStart'),
  endWindowDrag: () => ipcRenderer.send('window:dragEnd'),
  publishPetSnapshot: (snapshot) => ipcRenderer.send('pet:publishSnapshot', snapshot),
  getPetSnapshot: () => ipcRenderer.invoke('pet:getSnapshot'),
  sendPetCommand: (command) => ipcRenderer.send('pet:command', command),
  setPetConversationVisible: (visible) => ipcRenderer.send('pet:setConversationVisible', visible),
  resizePetModel: (scaleFactor) => ipcRenderer.send('pet:resizeModel', scaleFactor),
  onPetSnapshot: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot)
    ipcRenderer.on('pet:snapshot', listener)
    return () => ipcRenderer.removeListener('pet:snapshot', listener)
  },
  onPetCommand: (callback) => {
    const listener = (_event, command) => callback(command)
    ipcRenderer.on('pet:command', listener)
    return () => ipcRenderer.removeListener('pet:command', listener)
  },
  getSettings: () => ipcRenderer.invoke('app:getSettings'),
  getElectronPerformanceDiagnostics: () => ipcRenderer.invoke('performance:getElectronDiagnostics'),
  selectCharacterAsset: (kind) => ipcRenderer.invoke('character:selectAsset', kind),
  selectWallpaper: (mode) => ipcRenderer.invoke('wallpaper:select', mode),
  openWallpaperWorkshop: () => ipcRenderer.invoke('wallpaper:openWorkshop'),
  wallpaperInventory: () => ipcRenderer.invoke('wallpaper:inventory'),
  wallpaperPick: (wallpaper) => ipcRenderer.invoke('wallpaper:pick', wallpaper),
  wallpaperMediaInfo: (filePath) => ipcRenderer.invoke('wallpaper:media-info', filePath),
  wallpaperTranscode: (filePath, fps) => ipcRenderer.invoke('wallpaper:transcode', filePath, fps),
  wallpaperTranscodeProgress: (filePath, fps) => ipcRenderer.invoke('wallpaper:transcode-progress', filePath, fps),

  // ── ProcessManager / backend lifecycle ──
  getStatus: () => ipcRenderer.invoke('get-status'),
  isReady: () => ipcRenderer.invoke('is-ready'),
  restartServices: () => ipcRenderer.invoke('restart-services'),
  getLogsDir: () => ipcRenderer.invoke('get-logs-dir'),
  getServiceLog: (serviceName) => ipcRenderer.invoke('get-service-log', serviceName),
  getLifecycleSnapshot: () => ipcRenderer.invoke('lifecycle:getSnapshot'),
  lifecycleCommand: (command) => ipcRenderer.invoke('lifecycle:command', command),
  openLogs: () => ipcRenderer.invoke('lifecycle:openLogs'),
  onLifecycleSnapshot: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot)
    ipcRenderer.on('lifecycle:snapshot', listener)
    return () => ipcRenderer.removeListener('lifecycle:snapshot', listener)
  },
  onPetExitRequest: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('pet:exit-request', listener)
    return () => ipcRenderer.removeListener('pet:exit-request', listener)
  },
  onLifecycleError: (callback) => {
    const listener = (_event, message) => callback(message)
    ipcRenderer.on('lifecycle:error', listener)
    return () => ipcRenderer.removeListener('lifecycle:error', listener)
  },
})

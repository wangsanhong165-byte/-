// Audio player with queue, interrupt, and volume analysis for lip sync

export type AudioPlaybackHandler = {
  onStart?: (item: AudioPlaybackItem) => void
  onEnd?: (turnId: string) => void
  onVolume?: (volume: number) => void
}

export interface AudioPlaybackItem {
  audio: string // base64 data
  format: string
  turnId: string
  sequence: number
  /** Duration of the decoded buffer; populated before onStart fires. */
  durationMs?: number
}

/** Pure ownership/order module used by AudioPlayer and its tests. */
export class AudioPlaybackQueue {
  private pending = new Map<number, AudioPlaybackItem>()
  private ready: AudioPlaybackItem[] = []
  private expectedSequence = 0
  private _activeTurnId: string | null = null

  get activeTurnId(): string | null {
    return this._activeTurnId
  }

  beginTurn(turnId: string, firstSequence = 0): void {
    if (this._activeTurnId === turnId) return
    this.pending.clear()
    this.ready = []
    this._activeTurnId = turnId
    this.expectedSequence = Math.max(0, Math.floor(firstSequence))
  }

  push(item: AudioPlaybackItem): boolean {
    if (!this._activeTurnId || item.turnId !== this._activeTurnId) return false
    if (item.sequence < this.expectedSequence || this.pending.has(item.sequence)) return false
    if (this.ready.some(ready => ready.sequence === item.sequence)) return false
    this.pending.set(item.sequence, item)
    while (this.pending.has(this.expectedSequence)) {
      this.ready.push(this.pending.get(this.expectedSequence)!)
      this.pending.delete(this.expectedSequence)
      this.expectedSequence += 1
    }
    return true
  }

  drainReady(): AudioPlaybackItem[] {
    return this.ready.splice(0)
  }

  stopTurn(turnId?: string): boolean {
    if (!this._activeTurnId || (turnId && turnId !== this._activeTurnId)) return false
    this.pending.clear()
    this.ready = []
    this._activeTurnId = null
    this.expectedSequence = 0
    return true
  }
}

export class AudioPlayer {
  private audioContext: AudioContext | null = null
  private currentSource: AudioBufferSourceNode | null = null
  private analyserNode: AnalyserNode | null = null
  private analyserBuffer: Uint8Array | null = null
  private handlers: AudioPlaybackHandler = {}
  private animFrameId: number | null = null
  private queue: AudioPlaybackItem[] = []
  private ordering = new AudioPlaybackQueue()
  private currentItem: AudioPlaybackItem | null = null
  private _isPlaying = false
  private playbackGeneration = 0
  private legacySequence = 0



  get isPlaying(): boolean {
    return this._isPlaying
  }

  get queuedCount(): number {
    return this.queue.length
  }

  get activeTurnId(): string | null {
    return this.ordering.activeTurnId
  }

  setHandlers(h: AudioPlaybackHandler): void {
    this.handlers = h
  }

  beginTurn(turnId: string, firstSequence = 0): void {
    if (this.ordering.activeTurnId && this.ordering.activeTurnId !== turnId) {
      this.stop()
    }
    this.ordering.beginTurn(turnId, firstSequence)
  }

  /** Enqueue TTS audio for playback */
  enqueue(base64Audio: string, format: string, turnId = 'legacy', sequence?: number): boolean {
    const resolvedSequence = sequence ?? this.legacySequence++
    if (!this.ordering.activeTurnId) this.ordering.beginTurn(turnId, resolvedSequence)
    const accepted = this.ordering.push({
      audio: base64Audio,
      format,
      turnId,
      sequence: resolvedSequence,
    })
    if (!accepted) return false
    this.queue.push(...this.ordering.drainReady())
    if (!this._isPlaying) {
      void this.playNext()
    }
    return true
  }

  /** Stop current playback and clear queue */
  stop(turnId?: string): boolean {
    if (turnId && this.ordering.activeTurnId !== turnId) return false
    this.playbackGeneration += 1
    this.queue = []
    this.ordering.stopTurn(turnId)
    this.stopCurrent()
    return true
  }

  private stopCurrent(): void {
    const source = this.currentSource
    const owner = this.currentItem?.turnId ?? ''
    const wasActive = this._isPlaying || Boolean(source)
    this.currentSource = null
    this.currentItem = null
    if (source) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // Already stopped
      }
      source.disconnect()
    }
    this.analyserNode = null
    this._isPlaying = false
    this.stopVolumeAnalysis()
    if (wasActive) this.handlers.onEnd?.(owner)
  }

  private async playNext(): Promise<void> {
    if (this.queue.length === 0) return

    const item = this.queue.shift()!
    const generation = this.playbackGeneration
    this._isPlaying = true

    try {
      const ctx = this.getContext()
      const arrayBuffer = this.base64ToArrayBuffer(item.audio)
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
      if (generation !== this.playbackGeneration) return

      const source = ctx.createBufferSource()
      source.buffer = audioBuffer

      const gain = ctx.createGain()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256

      source.connect(gain)
      gain.connect(analyser)
      analyser.connect(ctx.destination)

      this.currentSource = source
      this.currentItem = item
      item.durationMs = audioBuffer.duration * 1000
      this.analyserNode = analyser

      source.onended = () => {
        if (generation !== this.playbackGeneration || this.currentSource !== source) return
        this.currentSource = null
        this.currentItem = null
        this.stopVolumeAnalysis()
        this._isPlaying = false

        // Play next in queue or signal end
        if (this.queue.length > 0) {
          this.playNext()
        } else {
          this.handlers.onEnd?.(item.turnId)
        }
      }

      this.handlers.onStart?.(item)
      source.start()
      this.startVolumeAnalysis()
    } catch {
      if (generation !== this.playbackGeneration) return
      this._isPlaying = false
      // Skip failed audio, try next
      if (this.queue.length > 0) {
        this.playNext()
      } else {
        this.handlers.onEnd?.(item.turnId)
      }
    }
  }

  /** Get current RMS volume 0–1 for lip sync */
  getCurrentVolume(): number {
    if (!this.analyserNode || !this._isPlaying) return 0
    const binCount = this.analyserNode.frequencyBinCount
    if (!this.analyserBuffer || this.analyserBuffer.length !== binCount) {
      this.analyserBuffer = new Uint8Array(binCount)
    }
    const dataArray = this.analyserBuffer
    this.analyserNode.getByteTimeDomainData(dataArray)
    let sum = 0
    for (let i = 0; i < dataArray.length; i++) {
      sum += Math.abs(dataArray[i] - 128)
    }
    return sum / dataArray.length / 128
  }

  /** Resume AudioContext (call on first user gesture to satisfy autoplay policy) */
  async resume(): Promise<void> {
    if (!this.audioContext) {
      this.audioContext = new AudioContext()
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume()
    }
  }

  async dispose(): Promise<void> {
    this.stop()
    this.handlers = {}
    const context = this.audioContext
    this.audioContext = null
    if (context && context.state !== 'closed') await context.close()
  }

  private getContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext()
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(() => {})
    }
    return this.audioContext
  }

  private startVolumeAnalysis(): void {
    this.stopVolumeAnalysis()
    const tick = () => {
      if (!this._isPlaying) return
      const vol = this.getCurrentVolume()
      this.handlers.onVolume?.(vol)
      this.animFrameId = requestAnimationFrame(tick)
    }
    tick()
  }

  private stopVolumeAnalysis(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId)
      this.animFrameId = null
    }
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binaryStr = atob(base64)
    const bytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i)
    }
    return bytes.buffer
  }
}

/**
 * Shared camera session used by the floating camera window and the recorder
 * sampling loop. Only one MediaStream is ever active: the dashboard preview
 * and the sample capturer both read from the same stream.
 */

import { blobToVisualFile, captureVideoFrame } from './camera'

class CameraSession {
  private stream: MediaStream | null = null
  private captureVideo: HTMLVideoElement | null = null
  private previewSink: HTMLVideoElement | null = null
  private starting: Promise<void> | null = null

  get active(): boolean {
    return this.stream !== null
  }

  async ensureStarted(): Promise<void> {
    if (this.stream) return
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null
      })
    }
    await this.starting
  }

  private async start(): Promise<void> {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    })
    this.stream = stream
    video.srcObject = stream
    try {
      await video.play()
    } catch {
      // Capture still works with a paused video in most browsers.
    }
    this.captureVideo = video
    if (this.previewSink) this.attachPreview(this.previewSink)
  }

  attachPreview(sink: HTMLVideoElement): void {
    this.previewSink = sink
    if (this.stream) {
      sink.srcObject = this.stream
      void sink.play().catch(() => {})
    }
  }

  detachPreview(sink: HTMLVideoElement): void {
    if (this.previewSink === sink) this.previewSink = null
    if (sink.srcObject === this.stream) sink.srcObject = null
  }

  stop(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop()
    }
    this.stream = null
    this.captureVideo = null
    this.starting = null
  }

  async captureFrame(): Promise<File | null> {
    await this.ensureStarted()
    if (!this.captureVideo) return null
    const canvas = document.createElement('canvas')
    const blob = await captureVideoFrame(this.captureVideo, canvas)
    if (!blob) return null
    return blobToVisualFile(blob)
  }
}

export const cameraSession = new CameraSession()
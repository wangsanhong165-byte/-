/**
 * Camera capture helpers for visual turns.
 *
 * Deliberately keeps pure sizing math and frame capture testable without a
 * browser: DOM types are only referenced inside functions, so this module can
 * be unit-tested under plain Node.
 */

export const CAMERA_FRAME_MAX_EDGE = 2048
export const CAMERA_FRAME_MIME_TYPE = 'image/jpeg'
export const CAMERA_FRAME_QUALITY = 0.88
export const CAMERA_FRAME_FILENAME = 'camera-frame.jpg'

export interface CaptureSize {
  width: number
  height: number
}

export interface CaptureCanvas {
  width: number
  height: number
  getContext(contextId: '2d'): CanvasRenderingContext2D | null
  toBlob(callback: BlobCallback | null, type?: string, quality?: number): void
}

export function computeScaledCaptureSize(
  width: number,
  height: number,
  maxEdge: number = CAMERA_FRAME_MAX_EDGE,
): CaptureSize {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 0, height: 0 }
  }
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * Draw the current video frame onto a canvas at bounded resolution and encode
 * it as a JPEG Blob. Returns null when the video has no frame or the canvas
 * context is unavailable.
 */
export function captureVideoFrame(
  video: Pick<HTMLVideoElement, 'videoWidth' | 'videoHeight'>,
  canvas: CaptureCanvas,
  options: { mimeType?: string; quality?: number } = {},
): Promise<Blob | null> {
  const size = computeScaledCaptureSize(video.videoWidth, video.videoHeight)
  if (!size.width || !size.height) return Promise.resolve(null)

  const context = canvas.getContext('2d')
  if (!context) return Promise.resolve(null)

  canvas.width = size.width
  canvas.height = size.height
  context.drawImage(video as unknown as CanvasImageSource, 0, 0, size.width, size.height)

  return new Promise(resolve => {
    canvas.toBlob(
      blob => resolve(blob),
      options.mimeType ?? CAMERA_FRAME_MIME_TYPE,
      options.quality ?? CAMERA_FRAME_QUALITY,
    )
  })
}

export function blobToVisualFile(
  blob: Blob,
  name: string = CAMERA_FRAME_FILENAME,
): File {
  return new File([blob], name, { type: blob.type || CAMERA_FRAME_MIME_TYPE })
}

/** Owns the getUserMedia stream for a preview element. */
export class CameraStream {
  private stream: MediaStream | null = null

  get active(): boolean {
    return this.stream !== null
  }

  async start(
    video: HTMLVideoElement,
    mediaDevices: Pick<MediaDevices, 'getUserMedia'> = navigator.mediaDevices,
  ): Promise<void> {
    this.stop()
    const stream = await mediaDevices.getUserMedia({
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
      // Some browsers require a user gesture before play(); the preview is
      // still attached and will start on the next interaction.
    }
  }

  stop(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop()
      this.stream = null
    }
  }
}
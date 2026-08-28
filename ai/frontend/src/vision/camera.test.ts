import assert from 'node:assert/strict'
import test from 'node:test'

import {
  blobToVisualFile,
  CAMERA_FRAME_FILENAME,
  CAMERA_FRAME_MAX_EDGE,
  CAMERA_FRAME_MIME_TYPE,
  captureVideoFrame,
  computeScaledCaptureSize,
} from './camera.ts'

test('computeScaledCaptureSize keeps small frames and bounds large edges', () => {
  assert.deepEqual(computeScaledCaptureSize(640, 480), { width: 640, height: 480 })
  const bounded = computeScaledCaptureSize(4096, 2048)
  assert.deepEqual(bounded, { width: 2048, height: 1024 })
  assert.equal(Math.max(bounded.width, bounded.height), CAMERA_FRAME_MAX_EDGE)
  assert.deepEqual(computeScaledCaptureSize(0, 0), { width: 0, height: 0 })
  assert.deepEqual(computeScaledCaptureSize(Number.NaN, 100), { width: 0, height: 0 })
})

test('captureVideoFrame draws the scaled frame and encodes JPEG', async () => {
  const drawCalls: unknown[] = []
  const context = {
    drawImage: (...args: unknown[]) => {
      drawCalls.push(args)
    },
  }
  const blob = new Blob(['jpeg-bytes'], { type: CAMERA_FRAME_MIME_TYPE })
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    toBlob: (callback: BlobCallback) => {
      callback(blob)
    },
  }

  const result = await captureVideoFrame(
    { videoWidth: 1920, videoHeight: 1080 } as unknown as HTMLVideoElement,
    canvas as unknown as HTMLCanvasElement,
    { quality: 0.9 },
  )

  assert.equal(result, blob)
  assert.equal(canvas.width, 1920)
  assert.equal(canvas.height, 1080)
  assert.equal(drawCalls.length, 1)
})

test('captureVideoFrame returns null when no video frame is ready', async () => {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => undefined }),
    toBlob: (callback: BlobCallback) => {
      callback(new Blob(['x'], { type: CAMERA_FRAME_MIME_TYPE }))
    },
  }
  const result = await captureVideoFrame(
    { videoWidth: 0, videoHeight: 0 } as unknown as HTMLVideoElement,
    canvas as unknown as HTMLCanvasElement,
  )
  assert.equal(result, null)
})

test('blobToVisualFile wraps a JPEG blob as an uploadable File', () => {
  const file = blobToVisualFile(new Blob(['abc'], { type: CAMERA_FRAME_MIME_TYPE }))
  assert.equal(file.type, CAMERA_FRAME_MIME_TYPE)
  assert.equal(file.name, CAMERA_FRAME_FILENAME)
  assert.ok(file.size > 0)
})
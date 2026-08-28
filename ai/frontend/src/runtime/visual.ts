import type { VisualAttachment } from './event-types.ts'

export type VisualAttachmentSource =
  | 'user_upload'
  | 'camera'
  | 'screen_capture'
  | 'screen_watcher'
  | 'screen_chat'

export type VisualPolicy = {
  maxImages: number
  maxImageBytes: number
  maxImagePixels: number
  maxImageEdge: number
  supportedMimeTypes: string[]
  supportedSources?: string[]
  cameraSampleIntervalMs?: number
  cameraMaxFrames?: number
  screenChatMaxAgeSeconds?: number
}

export const DEFAULT_VISUAL_POLICY: VisualPolicy = {
  maxImages: 4,
  maxImageBytes: 4 * 1024 * 1024,
  maxImagePixels: 12_000_000,
  maxImageEdge: 2048,
  supportedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  supportedSources: ['user_upload', 'camera', 'screen_capture', 'screen_watcher', 'screen_chat'],
  cameraSampleIntervalMs: 2000,
  cameraMaxFrames: 4,
  screenChatMaxAgeSeconds: 8,
}

export async function fetchVisualPolicy(): Promise<VisualPolicy> {
  const response = await fetch('/api/visual-policy')
  if (!response.ok) throw new Error('视觉设置不可用')
  const policy = await response.json() as Partial<VisualPolicy>
  return {
    ...DEFAULT_VISUAL_POLICY,
    ...policy,
    supportedMimeTypes: Array.isArray(policy.supportedMimeTypes)
      ? policy.supportedMimeTypes
      : DEFAULT_VISUAL_POLICY.supportedMimeTypes,
    supportedSources: Array.isArray(policy.supportedSources)
      ? policy.supportedSources
      : DEFAULT_VISUAL_POLICY.supportedSources,
  }
}

export async function uploadVisualAttachment(
  file: File,
  source: VisualAttachmentSource = 'user_upload',
): Promise<VisualAttachment> {
  const policy = await fetchVisualPolicy()
  if (file.size > policy.maxImageBytes) {
    throw new Error('图片不能超过 ' + formatMegabytes(policy.maxImageBytes) + ' MB')
  }
  if (!policy.supportedMimeTypes.includes(file.type)) {
    throw new Error('只支持 PNG、JPEG 或 WebP 图片')
  }

  const body = new FormData()
  body.append('file', file)
  body.append('source', source)
  const response = await fetch('/api/visual-attachments', { method: 'POST', body })
  const payload = await response.json().catch(() => ({})) as {
    attachment?: VisualAttachment
    detail?: string
  }
  if (!response.ok || !payload.attachment) {
    throw new Error(payload.detail || '图片上传失败')
  }
  return payload.attachment
}

function formatMegabytes(bytes: number): string {
  return Number.isInteger(bytes / (1024 * 1024))
    ? String(bytes / (1024 * 1024))
    : (bytes / (1024 * 1024)).toFixed(1)
}

import { Camera, ImagePlus, Mic, Send, Square, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent, DragEvent, FormEvent } from 'react'

import { useSelector, selectActivity, selectConnection, selectSettings } from '../core/store'
import { theme } from '../core/theme'
import type { RecorderState } from '../audio/recorder'
import type { VisualAttachment } from '../runtime/event-types'
import { DEFAULT_VISUAL_POLICY, fetchVisualPolicy, uploadVisualAttachment, type VisualPolicy } from '../runtime/visual'

const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

type PendingImage = {
  file: File
  previewUrl: string
}

export type VisualComposerInput = {
  text: string
  images: VisualAttachment[]
}

export interface InputBarProps {
  onSend: (input: VisualComposerInput) => boolean | void | Promise<boolean | void>
  onInterrupt: () => void
  recorderState: RecorderState
  recordingSupported: boolean
  onToggleRecording: () => void | Promise<void>
  cameraWindowOpen?: boolean
  onToggleCameraWindow?: () => void
}

export function InputBar({
  onSend,
  onInterrupt,
  recorderState,
  recordingSupported,
  onToggleRecording,
  cameraWindowOpen = false,
  onToggleCameraWindow,
}: InputBarProps) {
  const [value, setValue] = useState('')
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [visualPolicy, setVisualPolicy] = useState<VisualPolicy>(DEFAULT_VISUAL_POLICY)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pendingImagesRef = useRef<PendingImage[]>([])
  const activity = useSelector(selectActivity)
  const settings = useSelector(selectSettings)
  const connection = useSelector(selectConnection)
  const isBusy = ['thinking', 'speaking', 'processing'].includes(activity)
  const isDisconnected = connection !== 'connected'

  useEffect(() => {
    if (!isBusy && !uploading) inputRef.current?.focus()
  }, [isBusy, uploading])

  useEffect(() => {
    void fetchVisualPolicy().then(setVisualPolicy).catch(() => undefined)
  }, [])

  pendingImagesRef.current = pendingImages
  useEffect(() => () => {
    pendingImagesRef.current.forEach(item => URL.revokeObjectURL(item.previewUrl))
  }, [])

  const removeImage = (index: number) => {
    const item = pendingImages[index]
    if (item) URL.revokeObjectURL(item.previewUrl)
    setPendingImages(current => current.filter((_, itemIndex) => itemIndex !== index))
  }

  const addFiles = async (files: File[]) => {
    if (!files.length) return
    const currentPolicy = await fetchVisualPolicy().catch(() => visualPolicy)
    setVisualPolicy(currentPolicy)
    setUploadError('')
    const next: PendingImage[] = []
    for (const file of files) {
      if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
        setUploadError('只支持 PNG、JPEG 或 WebP 图片')
        continue
      }
      if (file.size > currentPolicy.maxImageBytes) {
        setUploadError('每张图片不能超过 ' + formatLimitMegabytes(currentPolicy.maxImageBytes) + ' MB')
        continue
      }
      if (pendingImages.length + next.length >= currentPolicy.maxImages) {
        setUploadError('一次最多附加 ' + currentPolicy.maxImages + ' 张图片')
        break
      }
      next.push({ file, previewUrl: URL.createObjectURL(file) })
    }
    if (next.length) setPendingImages(current => [...current, ...next].slice(0, currentPolicy.maxImages))
    // The file picker keeps focus on its hidden input. Return it to the text box
    // so attaching an image does not interrupt the normal typing flow.
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const text = value.trim()
    if ((!text && !pendingImages.length) || isBusy || uploading) return
    if (isDisconnected) {
      setUploadError('运行时未连接，草稿和图片已保留，请连接后再发送')
      return
    }
    setUploading(true)
    setUploadError('')
    try {
      const attachments: VisualAttachment[] = []
      for (const item of pendingImages) {
        attachments.push(await uploadVisualAttachment(item.file))
      }
      const sent = await onSend({ text, images: attachments })
      if (sent === false) throw new Error('运行时未连接，草稿和图片已保留')
      setValue('')
      pendingImages.forEach(item => URL.revokeObjectURL(item.previewUrl))
      setPendingImages([])
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : '图片上传失败，草稿已保留')
    } finally {
      setUploading(false)
    }
  }

  const selectFiles = (event: ChangeEvent<HTMLInputElement>) => {
    void addFiles(Array.from(event.target.files ?? []))
    event.target.value = ''
  }

  const handleDrop = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault()
    setDragging(false)
    void addFiles(Array.from(event.dataTransfer.files ?? []))
  }

  const handlePaste = (event: ClipboardEvent<HTMLFormElement>) => {
    const files = Array.from(event.clipboardData.files ?? []).filter(file => SUPPORTED_IMAGE_TYPES.has(file.type))
    if (!files.length) return
    event.preventDefault()
    void addFiles(files)
  }

  return (
    <form
      className={`message-composer${dragging ? ' is-dragging' : ''}`}
      onSubmit={submit}
      onDragOver={event => { event.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onPaste={handlePaste}
    >
      {isBusy ? (
        <button type="button" className="interrupt-button" onClick={onInterrupt}>
          <Square size={theme.icon.compact} strokeWidth={theme.icon.strokeWidth} aria-hidden="true" />
          停止回复
        </button>
      ) : (
        <>
          {pendingImages.length > 0 && (
            <div className="composer-attachments" aria-label={`已选择 ${pendingImages.length} 张图片`}>
              {pendingImages.map((item, index) => (
                <div className="composer-attachment" title={item.file.name} key={`${item.file.name}-${index}`}>
                  <img src={item.previewUrl} alt={item.file.name} />
                  <span>{item.file.name}</span>
                  <small>{formatBytes(item.file.size)}</small>
                  <button
                    type="button"
                    className="composer-action"
                    onClick={() => removeImage(index)}
                    aria-label={`移除图片 ${index + 1}`}
                    disabled={uploading}
                  >
                    <X size={theme.icon.compact} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <input
            ref={inputRef}
            value={value}
            onChange={event => setValue(event.target.value)}
            placeholder={dragging ? '松开以添加图片' : uploading ? '图片上传中…' : '想聊点什么？'}
            aria-label="消息"
            disabled={uploading}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            onChange={selectFiles}
            hidden
          />
          <button
            type="button"
            className="composer-action"
            onClick={() => fileInputRef.current?.click()}
            aria-label="添加图片"
            title={'添加图片（最多 ' + visualPolicy.maxImages + ' 张，每张不超过 ' + formatLimitMegabytes(visualPolicy.maxImageBytes) + ' MB）'}
            disabled={uploading || pendingImages.length >= visualPolicy.maxImages}
          >
            <ImagePlus size={theme.icon.action} strokeWidth={theme.icon.strokeWidth} aria-hidden="true" />
          </button>
          {settings.cameraEnabled && onToggleCameraWindow && (
            <button
              type="button"
              className={`composer-action${cameraWindowOpen ? ' is-active' : ''}`}
              onClick={onToggleCameraWindow}
              aria-label={cameraWindowOpen ? '关闭摄像头' : '打开摄像头'}
              title={cameraWindowOpen ? '关闭摄像头浮动窗' : '在人物模型旁打开摄像头浮动窗'}
              disabled={uploading}
            >
              <Camera size={theme.icon.action} strokeWidth={theme.icon.strokeWidth} aria-hidden="true" />
            </button>
          )}
          {recordingSupported && settings.voiceInputEnabled && (
            <button
              type="button"
              className="composer-action"
              onClick={onToggleRecording}
              aria-label={recorderState === 'recording' ? '停止录音' : '语音输入'}
              title={recorderState === 'recording' ? '停止录音' : '语音输入'}
              disabled={uploading}
            >
              {recorderState === 'recording'
                ? <Square size={theme.icon.action} strokeWidth={theme.icon.strokeWidth} aria-hidden="true" />
                : <Mic size={theme.icon.action} strokeWidth={theme.icon.strokeWidth} aria-hidden="true" />}
            </button>
          )}
          <button type="submit" className="send-button" disabled={(!value.trim() && !pendingImages.length) || uploading} aria-label="发送">
            <Send size={theme.icon.action} strokeWidth={theme.icon.strokeWidth} aria-hidden="true" />
          </button>
          {uploadError && <span role="alert" className="composer-error">{uploadError}</span>}
        </>
      )}
    </form>
  )
}

function formatLimitMegabytes(bytes: number): string {
  return Number.isInteger(bytes / (1024 * 1024))
    ? String(bytes / (1024 * 1024))
    : (bytes / (1024 * 1024)).toFixed(1)
}

function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}
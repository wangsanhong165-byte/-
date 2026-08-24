// WebGL renderer for Live2D Cubism models using CubismWebFramework
// Cached matrices, transparent background, one-pass projection setup.

import type { CubismModelHandle } from './core'
import { CubismRenderer_WebGL } from './framework/rendering/cubismrenderer_webgl'
import { CubismMatrix44 } from './framework/math/cubismmatrix44'
import { CubismModelMatrix } from './framework/math/cubismmodelmatrix'
import { CubismModel } from './framework/model/cubismmodel'
import {
  countClippingMaskGroups,
  requiredMaskRenderTextureCount,
} from './framework/rendering/mask-buffer-layout'

export interface FrameworkRendererState {
  gl: WebGLRenderingContext
  canvasWidth: number
  canvasHeight: number
}

export interface Live2DRenderEnvironment {
  webglVendor: string
  webglRenderer: string
  webglVersion: string
  cssWidth: number
  cssHeight: number
  pixelWidth: number
  pixelHeight: number
  renderDpr: number
}

type ModelLayout = Record<string, number>

let _rs: FrameworkRendererState | null = null

// ── Cached per-model projection resources ──
let _cachedModelW = -1
let _cachedModelH = -1
let _cachedModel: CubismModel | null = null
let _modelMatrix: CubismModelMatrix | null = null
let _baseProjection: CubismMatrix44 | null = null   // base projection WITHOUT viewport transform
let _projection: CubismMatrix44 | null = null       // final projection WITH viewport
let _viewportMatrix: CubismMatrix44 | null = null
let _projectionDirty = true
const _modelLayouts = new WeakMap<CubismModel, Map<string, number>>()

// ── Viewport transform (drag + zoom) ──
let _viewOffsetX = 0
let _viewOffsetY = 0
let _viewScale = 1

// ── Public API ──

export function initRenderer(canvas: HTMLCanvasElement): boolean {
  const gl = canvas.getContext('webgl', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: true,
  })
  if (!gl) {
    console.error('[Cubism] WebGL not supported')
    return false
  }

  _rs = {
    gl,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
  }

  gl.viewport(0, 0, canvas.width, canvas.height)
  gl.enable(gl.BLEND)
  gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.clearColor(0, 0, 0, 0) // transparent

  return true
}

export function createFrameworkRenderer(model: CubismModel, layout?: ModelLayout): CubismRenderer_WebGL | null {
  if (!_rs?.gl) return null

  const renderer = new CubismRenderer_WebGL(
    model.getCanvasWidth(),
    model.getCanvasHeight(),
  )
  const maskGroupCount = countClippingMaskGroups(
    model.getDrawableMasks(),
    model.getDrawableMaskCounts(),
  )
  renderer.initialize(model, requiredMaskRenderTextureCount(maskGroupCount))
  renderer.startUp(_rs.gl)
  renderer.setIsPremultipliedAlpha(true)
  // This canvas is dedicated to Cubism. The render entry point below resets
  // the small set of shared WebGL state that Cubism changes, so avoid the
  // expensive and incomplete external-state snapshot on every frame.
  renderer.setPreserveExternalState(false)
  if (layout) {
    const normalized = new Map<string, number>()
    for (const [key, value] of Object.entries(layout)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        normalized.set(key.toLowerCase(), value)
      }
    }
    if (normalized.size > 0) _modelLayouts.set(model, normalized)
  }

  return renderer
}

export function resizeRenderer(width: number, height: number): void {
  if (!_rs) return
  _rs.canvasWidth = width
  _rs.canvasHeight = height
  _rs.gl.viewport(0, 0, width, height)
  // Invalidate cached matrices on resize
  _cachedModelW = -1
  _projectionDirty = true
}

/** Low-frequency, read-only renderer diagnostics for the settings monitor. */
export function getRenderEnvironment(): Live2DRenderEnvironment | null {
  if (!_rs) return null
  const { gl } = _rs
  const canvas = gl.canvas as HTMLCanvasElement
  const extension = gl.getExtension('WEBGL_debug_renderer_info')
  const vendor = extension
    ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL)
    : gl.getParameter(gl.VENDOR)
  const renderer = extension
    ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER)
  const cssWidth = canvas.clientWidth || 0
  const cssHeight = canvas.clientHeight || 0
  const widthRatio = cssWidth > 0 ? canvas.width / cssWidth : 0
  const heightRatio = cssHeight > 0 ? canvas.height / cssHeight : 0
  const ratios = [widthRatio, heightRatio].filter(value => Number.isFinite(value) && value > 0)
  return {
    webglVendor: typeof vendor === 'string' ? vendor : String(vendor ?? ''),
    webglRenderer: typeof renderer === 'string' ? renderer : String(renderer ?? ''),
    webglVersion: String(gl.getParameter(gl.VERSION) ?? ''),
    cssWidth,
    cssHeight,
    pixelWidth: canvas.width,
    pixelHeight: canvas.height,
    renderDpr: ratios.length ? ratios.reduce((sum, value) => sum + value, 0) / ratios.length : 0,
  }
}

// ── Texture helpers ──

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

  // Premultiply RGB by A/255 — Cubism WebGL shader assumes premultiplied textures
function createTexture(gl: WebGLRenderingContext, image: HTMLImageElement): WebGLTexture {
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  // Cubism's shaders and blend modes operate on premultiplied-alpha pixels.
  // Let WebGL perform the upload conversion, matching the official Web SDK
  // texture path instead of a 2D-canvas/readback/CPU conversion.
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  const isPowerOfTwo = (value: number) => (value & (value - 1)) === 0
  const useMipmaps = isPowerOfTwo(image.width) && isPowerOfTwo(image.height)
  if (useMipmaps) gl.generateMipmap(gl.TEXTURE_2D)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER,
    useMipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.bindTexture(gl.TEXTURE_2D, null)
  return tex
}

export async function loadTextures(
  renderer: CubismRenderer_WebGL,
  texturePaths: string[],
): Promise<void> {
  for (let i = 0; i < texturePaths.length; i++) {
    try {
      const img = await loadImage(texturePaths[i])
      const tex = createTexture(renderer['gl'] as WebGLRenderingContext, img)
      renderer.bindTexture(i, tex)
    } catch (e) {
      console.warn(`[Cubism] Failed to load texture: ${texturePaths[i]}`, e)
    }
  }
}

// ── Projection matrix (cached per model + canvas size) ──

function _buildBaseProjection(model: CubismModel): void {
  if (!_rs) return

  const modelW = model.getCanvasWidth()
  const modelH = model.getCanvasHeight()

  // Reuse cached base projection when model + canvas haven't changed
  if (model === _cachedModel && modelW === _cachedModelW && modelH === _cachedModelH && _modelMatrix && _baseProjection) {
    return
  }

  _cachedModelW = modelW
  _cachedModelH = modelH
  _cachedModel = model

  const cw = _rs.canvasWidth
  const ch = _rs.canvasHeight

  _baseProjection = new CubismMatrix44() // identity
  _modelMatrix = new CubismModelMatrix(modelW, modelH)

  const layout = _modelLayouts.get(model)
  if (layout) _modelMatrix.setupFromLayout(layout)

  if (cw < ch) {
    // Portrait
    _modelMatrix.setWidth(2)
    _baseProjection.scale(1, cw / ch)
  } else {
    // Landscape / square
    _baseProjection.scale(ch / cw, 1)
  }

  // Do not add a second centering transform here. The official SDK applies
  // only the model3 layout (when present) and the view matrix. With no layout
  // entry, the model matrix remains at the asset's authored origin.
  _baseProjection.multiplyByMatrix(_modelMatrix)
  _projectionDirty = true
}

/** Invalidate projection cache so next render picks up viewport changes */
function _invalidateProjection(): void {
  _cachedModelW = -1
  _cachedModel = null
  _projectionDirty = true
}

// ── Main render ──

let _rendererMissingLogged = false

export function render(handle: CubismModelHandle, renderer: CubismRenderer_WebGL | null): void {
  if (!_rs || !renderer) {
    if (!_rendererMissingLogged) {
      console.error('[Live2D] render() skipped: _rs.renderer is null')
      _rendererMissingLogged = true
    }
    return
  }
  _rendererMissingLogged = false

  const model = handle.frameworkModel

  // Establish the application-owned target before Cubism starts its mask
  // passes. This matters when the previous frame ended in a mask or offscreen
  // target: binding the default framebuffer here prevents the next model
  // from inheriting that target.
  const gl = _rs.gl
  renderer.setRenderState(
    null as unknown as WebGLFramebuffer,
    [0, 0, _rs.canvasWidth, _rs.canvasHeight],
  )

  // Cubism's mask pass changes these states while rendering. Reset them at
  // the frame boundary, rather than relying on a previous drawable to leave
  // the context in a usable state. A stale scissor/stencil or blend function
  // produces exactly the detached blocks and ghost fragments seen on models
  // with dense masks such as Shirone.
  gl.disable(gl.SCISSOR_TEST)
  gl.disable(gl.STENCIL_TEST)
  gl.disable(gl.DEPTH_TEST)
  gl.disable(gl.CULL_FACE)
  gl.enable(gl.BLEND)
  gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD)
  gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.colorMask(true, true, true, true)
  gl.bindBuffer(gl.ARRAY_BUFFER, null)
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)

  // The default framebuffer is transparent. Clear the stencil bit as well
  // when the context provides one; this is harmless on the default context
  // used here and prevents stale mask state on contexts that do provide it.
  gl.clearColor(0, 0, 0, 0)
  gl.clearStencil(0)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)

  // Build / reuse base projection (cached by model dimensions)
  _buildBaseProjection(model)

  // The viewport only changes on resize, drag or zoom. Reuse both matrices
  // between frames so idle rendering does not create garbage every rAF.
  if (!_projection) _projection = new CubismMatrix44()
  if (!_viewportMatrix) _viewportMatrix = new CubismMatrix44()
  if (_projectionDirty) {
    if (_baseProjection) {
      const baseTr = _baseProjection.getArray()
      const finalTr = _projection.getArray()
      for (let i = 0; i < 16; i++) finalTr[i] = baseTr[i]
    } else {
      _projection.loadIdentity()
    }
    _viewportMatrix.loadIdentity()
    _viewportMatrix.scale(_viewScale, _viewScale)
    _viewportMatrix.translate(_viewOffsetX, _viewOffsetY)
    // _projection = viewport * base projection.
    _projection.multiplyByMatrix(_viewportMatrix)
    _projectionDirty = false
  }
  renderer.setMvpMatrix(_projection!)

  renderer.drawModel()
}

// ── Accessors ──

export function getGL(): WebGLRenderingContext | null {
  return _rs?.gl ?? null
}

/** Set viewport pan offset (normalized -1..1 coordinates) */
export function setViewOffset(x: number, y: number): void {
  _viewOffsetX = x
  _viewOffsetY = y
  _invalidateProjection()
}

/** Set viewport zoom scale (1 = default, >1 = zoom in, <1 = zoom out) */
export function setViewScale(scale: number): void {
  _viewScale = Math.max(0.1, Math.min(5, scale))
  _invalidateProjection()
}

/** Get current viewport transform */
export function getViewTransform(): { x: number; y: number; scale: number } {
  return { x: _viewOffsetX, y: _viewOffsetY, scale: _viewScale }
}

/** Reset viewport to default */
export function resetView(): void {
  _viewOffsetX = 0
  _viewOffsetY = 0
  _viewScale = 1
  _invalidateProjection()
}

export function destroyRenderer(): void {
  if (!_rs) return
  _rs = null
  _modelMatrix = null
  _baseProjection = null
  _projection = null
  _viewportMatrix = null
  _projectionDirty = true
  _cachedModelW = -1
  _cachedModel = null
}

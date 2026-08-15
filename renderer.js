// renderer.js — GlassRenderer: one shared WebGL device for all glass elements.
//
// Performance architecture (Phase 1):
//  1. Single GL context for the whole page (was: one context per element,
//     which hits browser context limits and multiplies GPU state overhead).
//  2. Every element renders into its own FBO; the result is blitted to the
//     element's DOM <canvas> (now a 2D canvas) through the master drawing
//     buffer. Nested glass (buttons inside containers) samples the parent's
//     FBO texture directly on the GPU — no per-frame canvas readback.
//  3. The 13x13 / 9x9 inline Gaussian blur is replaced by Dual Kawase:
//     a half-res downsample + 4 expanding 4-tap passes. ~110x fewer
//     texture fetches for the same visual radius.
//  4. Page capture is viewport-only and uploaded straight from the
//     html2canvas canvas (no toDataURL -> Image round-trip). Re-captured
//     only when the page scrolls outside the captured window or on resize.
//  5. Dirty-flag rendering: nothing is drawn when nothing changed.

class GlassRenderer {
  static instance = null

  static get() {
    if (!GlassRenderer.instance) GlassRenderer.instance = new GlassRenderer()
    return GlassRenderer.instance
  }

  constructor() {
    this.elements = [] // registered glass elements (Container / Button)
    this.byElement = new Map() // element -> { fbo, tex, w, h }

    this.master = null
    this.gl = null
    this.isGL2 = false

    this.quadBuffer = null
    this.programs = {}

    this.pageTexture = null
    this.pageSize = { w: 1, h: 1 }
    this.scrollAtCapture = { x: 0, y: 0 }
    this.capturing = false
    this.capturePending = false

    this.ping = { a: null, b: null, w: 0, h: 0 } // shared half-res ping-pong

    this.dirty = false
    this.frameQueued = false
    this._scrollFrame = 0
    this._resizeTimer = 0

    this.viewportW = window.innerWidth
    this.viewportH = window.innerHeight
    this.scrollX = 0
    this.scrollY = 0

    this._resizeObserver = null
    this._mutationObserver = null

    this.initGL()
    this.setupGlobalListeners()
    this.capturePage()
  }

  // ---------------------------------------------------------------- setup

  initGL() {
    this.master = document.createElement('canvas')
    this.master.className = 'glass-master'
    this.master.width = Math.max(1, this.viewportW)
    this.master.height = Math.max(1, this.viewportH)
    this.master.style.cssText =
      'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-9999'
    document.body.appendChild(this.master)

    const opts = { preserveDrawingBuffer: true, antialias: false, alpha: true }
    this.gl =
      this.master.getContext('webgl2', opts) ||
      this.master.getContext('webgl', opts) ||
      this.master.getContext('experimental-webgl', opts)

    if (!this.gl) {
      console.error('LiquidGlass: WebGL not supported')
      return
    }
    this.isGL2 = typeof this.gl.blitFramebuffer === 'function'

    this.master.addEventListener('webglcontextlost', e => {
      e.preventDefault()
      this.gl = null
    })
    this.master.addEventListener('webglcontextrestored', () => {
      // Re-create lazily-created resources; page texture re-captured.
      this.gl = this.master.getContext(
        this.isGL2 ? 'webgl2' : 'webgl',
        opts
      )
      this.programs = {}
      this.quadBuffer = null
      this.ping = { a: null, b: null, w: 0, h: 0 }
      this.byElement.clear()
      this.pageTexture = null
      this.capturePage()
      this.markDirty()
    })
  }

  setupGlobalListeners() {
    window.addEventListener(
      'scroll',
      () => {
        if (!this._scrollFrame) {
          this._scrollFrame = requestAnimationFrame(() => {
            this._scrollFrame = 0
            this.onScroll()
          })
        }
      },
      { passive: true }
    )

    window.addEventListener('resize', () => {
      clearTimeout(this._resizeTimer)
      this._resizeTimer = setTimeout(() => {
        this.viewportW = window.innerWidth
        this.viewportH = window.innerHeight
        if (this.master) {
          this.master.width = Math.max(1, this.viewportW)
          this.master.height = Math.max(1, this.viewportH)
        }
        this.capturePage()
      }, 300)
    })

    // Re-render (cheap) when the DOM changes; the texture is only
    // re-captured on scroll-out / resize to avoid expensive churn.
    this._mutationObserver = new MutationObserver(() => this.markDirty())
    this._mutationObserver.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })

    this._resizeObserver = new ResizeObserver(entries => {
      for (const e of entries) {
        const el = this.byElementKey.get(e.target)
        if (el) el.updateSizeFromDOM()
      }
      this.markDirty()
    })
    this.byElementKey = new Map()
  }

  onScroll() {
    this.scrollX = window.scrollX || document.documentElement.scrollLeft || 0
    this.scrollY = window.scrollY || document.documentElement.scrollTop || 0
    if (Math.abs(this.scrollY - this.scrollAtCapture.y) > this.viewportH * 0.5) {
      this.capturePage()
    }
    this.markDirty()
  }

  // -------------------------------------------------------------- registry

  register(el) {
    this.elements.push(el)
    if (this._resizeObserver) {
      this.byElementKey.set(el.element, el)
      this._resizeObserver.observe(el.element)
    }
    this.markDirty()
  }

  // ---------------------------------------------------------------- capture

  capturePage() {
    if (!this.gl) return
    if (this.capturing) {
      this.capturePending = true
      return
    }
    this.capturing = true

    const sx = window.scrollX || document.documentElement.scrollLeft || 0
    const sy = window.scrollY || document.documentElement.scrollTop || 0
    const vw = window.innerWidth
    const vh = window.innerHeight

    html2canvas(document.body, {
      x: sx,
      y: sy,
      width: vw,
      height: vh,
      scale: 1,
      useCORS: true,
      allowTaint: true,
      backgroundColor: null,
      ignoreElements: el =>
        el.classList.contains('glass-container') ||
        el.classList.contains('glass-button') ||
        el.classList.contains('glass-button-text') ||
        el.classList.contains('glass-master')
    })
      .then(canvas => {
        this.capturing = false
        const gl = this.gl
        if (!gl) return
        this.pageTexture = this.pageTexture || gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, this.pageTexture)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        this.pageSize = { w: canvas.width, h: canvas.height }
        this.scrollAtCapture = { x: sx, y: sy }
        this.markDirty()
        if (this.capturePending) {
          this.capturePending = false
          this.capturePage()
        }
      })
      .catch(err => {
        console.error('LiquidGlass: page capture failed', err)
        this.capturing = false
        if (this.capturePending) {
          this.capturePending = false
          this.capturePage()
        }
      })
  }

  // ----------------------------------------------------------- dirty flags

  markDirty() {
    this.dirty = true
    if (!this.frameQueued && this.gl) {
      this.frameQueued = true
      requestAnimationFrame(() => this.renderFrame())
    }
  }

  // --------------------------------------------------------------- render

  renderFrame() {
    this.frameQueued = false
    if (!this.gl || !this.pageTexture) return
    if (!this.dirty) return

    const gl = this.gl
    const ctrl = window.glassControls || {}

    const list = this.elements.filter(el => el.width > 0 && el.height > 0)
    if (!list.length) {
      this.dirty = false
      return
    }

    // Parents must render before nested children sample their FBO texture.
    list.sort((a, b) => (a.depth || 0) - (b.depth || 0))

    for (const el of list) {
      const entry = this.ensureEntry(el)
      if (!entry) continue
      const w = entry.w
      const h = entry.h

      const nested = el.parent && el.isNestedGlass
      const sourceTex = nested ? this.byElement.get(el.parent)?.tex : this.pageTexture
      if (!sourceTex) continue
      const sourceSize = nested
        ? { w: el.parent.width, h: el.parent.height }
        : this.pageSize

      // Bleed margin so rim displacement never samples past the blurred region
      const margin = 28
      const rw = w + margin * 2
      const rh = h + margin * 2
      const halfW = Math.max(1, Math.ceil(rw / 2))
      const halfH = Math.max(1, Math.ceil(rh / 2))
      this.ensurePing(halfW, halfH)

      // Pass 1: plain downsample of the source region (element + margin) → ping.a
      this.drawSample(el, sourceTex, sourceSize, nested, this.ping.a, halfW, halfH, rw, rh)

      // Dual Kawase ping-pong (frost BEFORE displacement, matching the reference)
      const radius = Math.max(0, Math.min(30, ctrl.blurRadius ?? 2))
      const blurScale = el.isButton
        ? ctrl.buttonBlurScale ?? 0.67
        : ctrl.containerBlurScale ?? 1.0
      const passes = radius < 0.5 ? 0 : radius < 3 ? 2 : 4
      let src = this.ping.a
      let dst = this.ping.b
      for (let i = 0; i < passes; i++) {
        const px = (0.5 + i) * radius * 0.3 * blurScale
        this.drawKawase(src, dst, (px * halfW) / rw, (px * halfH) / rh)
        const tmp = src
        src = dst
        dst = tmp
      }

      // Final: composite — lens refraction on the blurred region, then
      // tint + gradient + mask, into the element FBO
      this.drawComposite(el, src.tex, sourceTex, sourceSize, nested, entry, w, h, margin, rw, rh)
    }

    // Blit every element FBO to its DOM canvas through the master buffer
    for (const el of list) {
      const entry = this.byElement.get(el)
      if (entry && el.ctx2d) this.blitToCanvas(el, entry)
    }

    this.dirty = false
  }

  // --------------------------------------------------------------- FBO mgmt

  ensureEntry(el) {
    const gl = this.gl
    const w = Math.max(1, Math.ceil(el.width))
    const h = Math.max(1, Math.ceil(el.height))

    if (el.canvas.width !== w || el.canvas.height !== h) {
      el.canvas.width = w
      el.canvas.height = h
    }

    let entry = this.byElement.get(el)
    if (!entry) {
      const tex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      const fbo = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      entry = { fbo, tex, w, h }
      this.byElement.set(el, entry)
    } else if (entry.w !== w || entry.h !== h) {
      gl.bindTexture(gl.TEXTURE_2D, entry.tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      entry.w = w
      entry.h = h
    }
    return entry
  }

  ensurePing(w, h) {
    if (this.ping.w >= w && this.ping.h >= h) return
    this.ping.w = Math.max(this.ping.w, w)
    this.ping.h = Math.max(this.ping.h, h)
    for (const key of ['a', 'b']) {
      const fbo = glCreateHalfFBO(this.gl, this.ping.w, this.ping.h)
      if (this.ping[key]) this.gl.deleteFramebuffer(this.ping[key].fbo)
      this.ping[key] = fbo
    }
  }

  // ------------------------------------------------------------- GL helpers

  quad() {
    if (!this.quadBuffer) {
      const gl = this.gl
      this.quadBuffer = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer)
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([
          -1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0,
          -1, 1, 0, 0, 1, -1, 1, 1, 1, 1, 1, 0,
        ]),
        gl.STATIC_DRAW
      )
    }
    return this.quadBuffer
  }

  bindQuad(program) {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad())
    const aPos = program.aPos !== undefined ? program.aPos : gl.getAttribLocation(program, 'a_position')
    const aTex = program.aTex !== undefined ? program.aTex : gl.getAttribLocation(program, 'a_texcoord')
    program.aPos = aPos
    program.aTex = aTex
    if (aPos >= 0) {
      gl.enableVertexAttribArray(aPos)
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0)
    }
    if (aTex >= 0) {
      gl.enableVertexAttribArray(aTex)
      gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 16, 8)
    }
  }

  program(name, vs, fs) {
    if (!this.programs[name]) {
      const gl = this.gl
      const v = gl.createShader(gl.VERTEX_SHADER)
      gl.shaderSource(v, vs)
      gl.compileShader(v)
      if (!gl.getShaderParameter(v, gl.COMPILE_STATUS)) {
        console.error(`LiquidGlass: vertex shader ${name} failed:`, gl.getShaderInfoLog(v))
      }
      const f = gl.createShader(gl.FRAGMENT_SHADER)
      gl.shaderSource(f, fs)
      gl.compileShader(f)
      if (!gl.getShaderParameter(f, gl.COMPILE_STATUS)) {
        console.error(`LiquidGlass: fragment shader ${name} failed:`, gl.getShaderInfoLog(f))
      }
      const p = gl.createProgram()
      gl.attachShader(p, v)
      gl.attachShader(p, f)
      gl.linkProgram(p)
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        console.error(`LiquidGlass: program ${name} link failed:`, gl.getProgramInfoLog(p))
      }
      this.programs[name] = p
    }
    return this.programs[name]
  }

  drawInto(fbo, w, h) {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.viewport(0, 0, w, h)
  }

  // ---------------------------------------------------------------- shaders

  // Pass 1 — plain downsample of the source region (element + bleed margin)
  // into half resolution. Refraction happens in the composite AFTER the blur
  // (reference ordering: blur → displacement, so chroma stays crisp).
  drawSample(el, sourceTex, sourceSize, nested, target, w, h, rw, rh) {
    const gl = this.gl
    const program = this.program('sample', this.vs(), this.fsSample())
    this.drawInto(target.fbo, w, h)
    gl.useProgram(program)
    this.bindQuad(program)

    const p = el.getPosition()
    let cx, cy
    if (nested) {
      const pp = el.parent.getPosition()
      cx = p.x - pp.x + el.parent.width / 2
      cy = p.y - pp.y + el.parent.height / 2
    } else {
      cx = p.x + this.scrollX - this.scrollAtCapture.x
      cy = p.y + this.scrollY - this.scrollAtCapture.y
    }
    // Region top-left in source space (element center − half region)
    const ox = cx - rw / 2
    const oy = cy - rh / 2

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, sourceTex)
    gl.uniform1i(gl.getUniformLocation(program, 'u_source'), 0)
    gl.uniform2f(gl.getUniformLocation(program, 'u_sourceSize'), sourceSize.w, sourceSize.h)
    gl.uniform2f(gl.getUniformLocation(program, 'u_origin'), ox, oy)
    gl.uniform2f(gl.getUniformLocation(program, 'u_regionSize'), rw, rh)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  // Pass 2 — single Dual Kawase iteration (4 taps, expanding offset).
  // WARNING: ox/oy are in UV units [0..1] (the shader adds them straight to
  // v_texcoord). Convert pixel radii first: offset = px / textureWidth.
  drawKawase(src, dst, ox, oy) {
    const gl = this.gl
    const program = this.program('kawase', this.vs(), this.fsKawase())
    this.drawInto(dst.fbo, dst.w, dst.h)
    gl.useProgram(program)
    this.bindQuad(program)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, src.tex)
    gl.uniform1i(gl.getUniformLocation(program, 'u_texture'), 0)
    gl.uniform2f(gl.getUniformLocation(program, 'u_offset'), ox, oy)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  // Pass 3 — composite: lens refraction on the blurred region + tint +
  // sampled gradient + shape mask. Chroma split happens here, AFTER the
  // blur, so the fringing stays crisp (reference ordering).
  drawComposite(el, blurredTex, gradientTex, sourceSize, nested, entry, w, h, margin, rw, rh) {
    const gl = this.gl
    const ctrl = window.glassControls || {}
    const program = this.program('composite', this.vs(), this.fsComposite())
    this.drawInto(entry.fbo, w, h)
    gl.useProgram(program)
    this.bindQuad(program)

    const tint =
      el === window.controlsContainer ? el.tintOpacity : ctrl.tintOpacity ?? el.tintOpacity

    let gradOriginX, gradOriginY, gradSizeW, gradSizeH
    const p = el.getPosition()
    if (nested) {
      // Faithful to the original button shader: viewport-space position
      // divided by parent size (CLAMP_TO_EDGE handles out-of-range rows).
      gradOriginX = p.x
      gradOriginY = p.y
      gradSizeW = el.parent.width
      gradSizeH = el.parent.height
    } else {
      gradOriginX = p.x + this.scrollX - this.scrollAtCapture.x
      gradOriginY = p.y + this.scrollY - this.scrollAtCapture.y
      gradSizeW = sourceSize.w
      gradSizeH = sourceSize.h
    }

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, blurredTex)
    gl.uniform1i(gl.getUniformLocation(program, 'u_blurred'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, gradientTex)
    gl.uniform1i(gl.getUniformLocation(program, 'u_gradientSource'), 1)
    gl.uniform2f(gl.getUniformLocation(program, 'u_sourceSize'), sourceSize.w, sourceSize.h)
    gl.uniform2f(gl.getUniformLocation(program, 'u_gradOrigin'), gradOriginX, gradOriginY)
    gl.uniform2f(gl.getUniformLocation(program, 'u_gradSize'), gradSizeW, gradSizeH)
    gl.uniform2f(gl.getUniformLocation(program, 'u_resolution'), el.width, el.height)
    gl.uniform2f(gl.getUniformLocation(program, 'u_regionSize'), rw, rh)
    gl.uniform1f(gl.getUniformLocation(program, 'u_margin'), margin)
    gl.uniform1f(gl.getUniformLocation(program, 'u_borderRadius'), el.borderRadius)
    gl.uniform1f(gl.getUniformLocation(program, 'u_tintOpacity'), tint)
    gl.uniform1f(gl.getUniformLocation(program, 'u_isButton'), el.isButton ? 1.0 : 0.0)
    gl.uniform1f(gl.getUniformLocation(program, 'u_gradientMode'), el.isButton ? 0.0 : 1.0)
    // Lens model (Aave-style)
    gl.uniform1f(gl.getUniformLocation(program, 'u_warp'), ctrl.warp || el.warp ? 1.0 : 0.0)
    gl.uniform1f(gl.getUniformLocation(program, 'u_edgeIntensity'), ctrl.edgeIntensity ?? 1.0)
    gl.uniform1f(gl.getUniformLocation(program, 'u_baseIntensity'), ctrl.baseIntensity ?? 0.6)
    gl.uniform1f(gl.getUniformLocation(program, 'u_strength'), ctrl.lensStrength ?? 16)
    gl.uniform1f(gl.getUniformLocation(program, 'u_chroma'), ctrl.chroma ?? 0.3)
    gl.uniform1f(gl.getUniformLocation(program, 'u_edgeWidth'), ctrl.edgeDistance ?? 20)
    gl.uniform1f(gl.getUniformLocation(program, 'u_domeRadius'), ctrl.baseDistance ?? 1.2)
    gl.uniform1f(gl.getUniformLocation(program, 'u_glint'), ctrl.rimIntensity ?? 0.9)
    gl.uniform1f(gl.getUniformLocation(program, 'u_glintSharp'), ctrl.rimDistance ?? 2)
    gl.uniform1f(gl.getUniformLocation(program, 'u_cornerBoost'), ctrl.cornerBoost ?? 0.2)
    gl.uniform1f(gl.getUniformLocation(program, 'u_rippleEffect'), ctrl.rippleEffect ?? 0)
    gl.uniform1f(gl.getUniformLocation(program, 'u_rippleFrequency'), el.isButton ? 30.0 : 25.0)
    gl.uniform1f(gl.getUniformLocation(program, 'u_vibrancy'), ctrl.vibrancy ?? 0.15)

    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  // Blit element FBO -> master drawing buffer -> element's DOM 2D canvas.
  blitToCanvas(el, entry) {
    const gl = this.gl
    const w = entry.w
    const h = entry.h

    if (this.master.width < w || this.master.height < h) {
      this.master.width = Math.max(this.master.width, w)
      this.master.height = Math.max(this.master.height, h)
    }

    if (this.isGL2) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, entry.fbo)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
      gl.viewport(0, 0, w, h)
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST)
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
    } else {
      const program = this.program('copy', this.vs(), this.fsCopy())
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, w, h)
      gl.useProgram(program)
      this.bindQuad(program)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, entry.tex)
      gl.uniform1i(gl.getUniformLocation(program, 'u_texture'), 0)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }

    el.ctx2d.drawImage(this.master, 0, 0, w, h, 0, 0, w, h)
  }

  // ------------------------------------------------------------------ GLSL

  vs() {
    return `
    attribute vec2 a_position;
    attribute vec2 a_texcoord;
    varying vec2 v_texcoord;
    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
      v_texcoord = a_texcoord;
    }
  `
  }

  fsSample() {
    return `
    precision mediump float;
    uniform sampler2D u_source;
    uniform vec2 u_sourceSize;
    uniform vec2 u_origin;
    uniform vec2 u_regionSize;
    varying vec2 v_texcoord;
    void main() {
      vec2 uv = (u_origin + v_texcoord * u_regionSize) / u_sourceSize;
      gl_FragColor = texture2D(u_source, uv);
    }
  `
  }

  fsKawase() {
    return `
    precision mediump float;
    uniform sampler2D u_texture;
    uniform vec2 u_offset;
    varying vec2 v_texcoord;
    void main() {
      vec2 o = u_offset;
      vec4 c = texture2D(u_texture, v_texcoord + o)
             + texture2D(u_texture, v_texcoord - o)
             + texture2D(u_texture, v_texcoord + vec2(o.x, -o.y))
             + texture2D(u_texture, v_texcoord + vec2(-o.x, o.y));
      gl_FragColor = c * 0.25;
    }
  `
  }

  fsComposite() {
    return `
    precision mediump float;
    uniform sampler2D u_blurred;
    uniform sampler2D u_gradientSource;
    uniform vec2 u_sourceSize;
    uniform vec2 u_gradOrigin;
    uniform vec2 u_gradSize;
    uniform vec2 u_resolution;
    uniform vec2 u_regionSize;
    uniform float u_margin;
    uniform float u_borderRadius;
    uniform float u_tintOpacity;
    uniform float u_isButton;
    uniform float u_gradientMode;
    uniform float u_warp;
    uniform float u_edgeIntensity;
    uniform float u_baseIntensity;
    uniform float u_strength;
    uniform float u_chroma;
    uniform float u_edgeWidth;
    uniform float u_domeRadius;
    uniform float u_glint;
    uniform float u_glintSharp;
    uniform float u_cornerBoost;
    uniform float u_rippleEffect;
    uniform float u_rippleFrequency;
    uniform float u_vibrancy;
    varying vec2 v_texcoord;

    // Aave's erf approximation: tanh(sqrt(pi) * x); tanh via exp (GLSL ES 1.00 has no tanh)
    float erfApprox(float x) {
      float t = exp(2.0 * 1.7724538509 * x);
      return (t - 1.0) / (t + 1.0);
    }

    float roundedRectDistance(vec2 coord, vec2 size, float radius) {
      vec2 center = size * 0.5;
      vec2 pixelCoord = coord * size;
      vec2 toCorner = abs(pixelCoord - center) - (center - radius);
      float outsideCorner = length(max(toCorner, 0.0));
      float insideCorner = min(max(toCorner.x, toCorner.y), 0.0);
      return (outsideCorner + insideCorner - radius);
    }

    float circleDistance(vec2 coord, vec2 size, float radius) {
      vec2 center = vec2(0.5, 0.5);
      vec2 pixelCoord = coord * size;
      vec2 centerPixel = center * size;
      float distFromCenter = length(pixelCoord - centerPixel);
      return distFromCenter - radius;
    }

    bool isPill(vec2 size, float radius) {
      float heightRatioDiff = abs(radius - size.y * 0.5);
      bool radiusMatchesHeight = heightRatioDiff < 2.0;
      bool isWiderThanTall = size.x > size.y + 4.0;
      return radiusMatchesHeight && isWiderThanTall;
    }

    bool isCircle(vec2 size, float radius) {
      float minDim = min(size.x, size.y);
      bool radiusMatchesMinDim = abs(radius - minDim * 0.5) < 1.0;
      bool isRoughlySquare = abs(size.x - size.y) < 4.0;
      return radiusMatchesMinDim && isRoughlySquare;
    }

    float pillDistance(vec2 coord, vec2 size, float radius) {
      vec2 center = size * 0.5;
      vec2 pixelCoord = coord * size;
      vec2 capsuleStart = vec2(radius, center.y);
      vec2 capsuleEnd = vec2(size.x - radius, center.y);
      vec2 capsuleAxis = capsuleEnd - capsuleStart;
      float capsuleLength = length(capsuleAxis);
      if (capsuleLength > 0.0) {
        vec2 toPoint = pixelCoord - capsuleStart;
        float t = clamp(dot(toPoint, capsuleAxis) / dot(capsuleAxis, capsuleAxis), 0.0, 1.0);
        vec2 closestPointOnAxis = capsuleStart + t * capsuleAxis;
        return length(pixelCoord - closestPointOnAxis) - radius;
      } else {
        return length(pixelCoord - center) - radius;
      }
    }

    void main() {
      vec2 coord = v_texcoord;
      float gradientPosition = coord.y;

      // Signed shape SDF distance (negative inside)
      float distShape;
      if (isPill(u_resolution, u_borderRadius)) {
        distShape = pillDistance(coord, u_resolution, u_borderRadius);
      } else if (isCircle(u_resolution, u_borderRadius)) {
        distShape = circleDistance(coord, u_resolution, u_borderRadius);
      } else {
        distShape = roundedRectDistance(coord, u_resolution, u_borderRadius);
      }

      // ---- lens displacement (Aave-style), applied to the blurred region ----
      vec2 pxFromCenter = (coord - 0.5) * u_resolution;
      float r = length(pxFromCenter);
      float minDim = min(u_resolution.x, u_resolution.y);

      // Inward direction (magnification): zero at center, unit at rim
      vec2 dir = r > 1.0 ? -pxFromCenter / r : vec2(0.0);

      float edgeI = 0.5 * (1.0 + erfApprox(distShape / max(u_edgeWidth, 0.5)));
      float domeMag = 0.0;
      if (u_warp > 0.5) {
        float R = minDim * 0.5 * max(u_domeRadius, 0.1);
        float rr = clamp(r, 0.0, R * 0.999);
        domeMag = rr / sqrt(max(R * R - rr * rr, 1e-6));
        domeMag = min(domeMag, 6.0);
      }

      vec2 disp = dir * u_strength * (u_edgeIntensity * edgeI + u_baseIntensity * domeMag);

      // Corner enhancement
      float cornerProximityX = min(coord.x, 1.0 - coord.x);
      float cornerProximityY = min(coord.y, 1.0 - coord.y);
      float cornerDistance = max(cornerProximityX, cornerProximityY);
      float cornerBoost = exp(-cornerDistance * minDim * 0.08) * u_cornerBoost;
      disp += dir * u_strength * cornerBoost;

      // Ripple texture along the rim
      vec2 perpendicular = vec2(-dir.y, dir.x);
      float rippleAmt = sin(-distShape / minDim * u_rippleFrequency) * u_rippleEffect * edgeI;
      disp += perpendicular * u_strength * rippleAmt;

      // Sample the BLURRED region with lens displacement + chroma split.
      // Blur happens before displacement (reference ordering), so the RGB
      // fringing stays crisp instead of being smeared by the frost.
      vec2 regionUV = (coord * u_resolution + u_margin) / u_regionSize;
      vec2 dispUV = disp / u_regionSize;
      vec2 uvR = regionUV + dispUV * (1.0 + u_chroma * 0.2);
      vec2 uvG = regionUV + dispUV * (1.0 + u_chroma * 0.1);
      vec2 uvB = regionUV + dispUV;
      vec4 color = vec4(
        texture2D(u_blurred, uvR).r,
        texture2D(u_blurred, uvG).g,
        texture2D(u_blurred, uvB).b,
        1.0
      );

      // Simple vertical gradient
      vec3 topTint = vec3(1.0, 1.0, 1.0);
      vec3 bottomTint = vec3(0.7, 0.7, 0.7);
      vec3 gradientTint = mix(topTint, bottomTint, gradientPosition);
      vec3 tintedColor = mix(color.rgb, gradientTint, u_tintOpacity);
      color = vec4(tintedColor, color.a);

      // Sampled gradient bands (raw source)
      float bandOffset = 0.4 * u_resolution.y;
      float topY = (u_gradOrigin.y - bandOffset) / u_gradSize.y;
      float midY = u_gradOrigin.y / u_gradSize.y;
      float bottomY = (u_gradOrigin.y + bandOffset) / u_gradSize.y;

      vec3 topColor = vec3(0.0);
      vec3 midColor = vec3(0.0);
      vec3 bottomColor = vec3(0.0);

      if (u_gradientMode > 0.5) {
        vec2 texelSize = 1.0 / u_gradSize;
        float sampleCount = 0.0;
        for (float x = 0.0; x < 1.0; x += 0.1) {
          for (float yOffset = -5.0; yOffset <= 5.0; yOffset += 1.0) {
            topColor += texture2D(u_gradientSource, vec2(x, topY + yOffset * texelSize.y)).rgb;
            midColor += texture2D(u_gradientSource, vec2(x, midY + yOffset * texelSize.y)).rgb;
            bottomColor += texture2D(u_gradientSource, vec2(x, bottomY + yOffset * texelSize.y)).rgb;
            sampleCount += 1.0;
          }
        }
        topColor /= sampleCount;
        midColor /= sampleCount;
        bottomColor /= sampleCount;
      } else {
        topColor = texture2D(u_gradientSource, vec2(0.5, topY)).rgb;
        midColor = texture2D(u_gradientSource, vec2(0.5, midY)).rgb;
        bottomColor = texture2D(u_gradientSource, vec2(0.5, bottomY)).rgb;
      }

      vec3 sampledGradient;
      if (gradientPosition < 0.1) {
        sampledGradient = topColor;
      } else if (gradientPosition > 0.9) {
        sampledGradient = bottomColor;
      } else {
        float transitionPos = (gradientPosition - 0.1) / 0.8;
        if (transitionPos < 0.5) {
          sampledGradient = mix(topColor, midColor, transitionPos * 2.0);
        } else {
          sampledGradient = mix(midColor, bottomColor, (transitionPos - 0.5) * 2.0);
        }
      }

      vec3 finalTinted = mix(color.rgb, sampledGradient, u_tintOpacity * 0.3);
      color = vec4(finalTinted, color.a);

      if (u_isButton > 0.5) {
        vec3 secondTinted = mix(color.rgb, sampledGradient, u_tintOpacity * 0.4);
        vec3 buttonTopTint = vec3(1.08, 1.08, 1.08);
        vec3 buttonBottomTint = vec3(0.92, 0.92, 0.92);
        vec3 buttonGradient = mix(buttonTopTint, buttonBottomTint, gradientPosition);
        color = vec4(secondTinted * buttonGradient, color.a);
      }

      // Shape mask
      float mask = 1.0 - smoothstep(-1.5, 1.5, distShape);

      // Adaptive specular glint (Aave): additive on dark backdrops,
      // multiplicative on bright ones. Direction from the lens vector.
      vec2 lightDir = normalize(vec2(-0.707, -0.707));
      float glintAmt = pow(max(dot(-dir, lightDir), 0.0), u_glintSharp) * edgeI * u_glint;
      float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
      float darkBlend = smoothstep(0.25, 0.65, luma);
      color.rgb = mix(
        color.rgb + glintAmt,
        color.rgb * (1.0 - glintAmt * 0.5),
        darkBlend
      );

      // Adaptive brightness pull for legibility through the glass
      color.rgb += (0.5 - luma) * u_vibrancy;

      gl_FragColor = vec4(color.rgb, mask);
    }
  `
  }

  fsCopy() {
    return `
    precision mediump float;
    uniform sampler2D u_texture;
    varying vec2 v_texcoord;
    void main() {
      gl_FragColor = texture2D(u_texture, v_texcoord);
    }
  `
  }
}

// Small helper: half-res FBO pair factory
function glCreateHalfFBO(gl, w, h) {
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  const fbo = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  return { fbo, tex, w, h }
}

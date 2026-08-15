// gooey.js — transparent "liquid gooey" glass (experiment).
//
// Idea (from Jakubantalik/liquid-gooey + our liquid-glass-js renderer):
// the classic goo filter (blur + alpha contrast) only cares about ALPHA, so
// instead of filling the merged silhouette with a solid colour we fill it
// with GLASS — frosted page sampling + lens refraction + glint. The result
// is gooey liquid you can see through.
//
// Pipeline (per frame, on the shared GlassRenderer context):
//   1. mask:  draw each blob as a soft SDF circle (additive alpha) -> maskTex
//   2. goo:   Dual Kawase blur the mask, then alpha-contrast in the material
//             pass — touching blobs bridge into one gooey silhouette
//   3. frost: sample the page region (container + bleed margin) -> frostTex,
//             Kawase blur it (glass frost)
//   4. glass: material pass — sample frostTex with lens displacement + chroma
//             split + tint + glint, multiplied by the gooey mask alpha
//   5. blit the group FBO to the container's DOM canvas (behind content)

class GooeyGlass {
  static MAX_BLOBS = 8

  constructor(container, options = {}) {
    this.container = container
    this.blobs = (options.blobs || []).map(b => ({ x: b.x, y: b.y, r: b.r }))
    this.margin = options.margin ?? 24

    // Glass material
    this.frost = options.frost ?? 2.0 // frost blur px
    this.tint = options.tint ?? 0.1
    this.strength = options.strength ?? 4 // lens displacement px
    this.chroma = options.chroma ?? 0.2
    this.dome = options.dome ?? 0.5
    this.edgeBand = options.edgeBand ?? 0.8
    this.edgeWidth = options.edgeWidth ?? 10
    this.glint = options.glint ?? 0.35

    // Goo merge
    this.blur = options.blur ?? 8 // goo blur px
    this.threshold = options.threshold ?? 0.4
    this.gooContrast = options.gooContrast ?? 14

    this.canvas = document.createElement('canvas')
    this.canvas.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;z-index:0;pointer-events:none'
    this.ctx2d = this.canvas.getContext('2d')
    container.appendChild(this.canvas)

    this.renderer = GlassRenderer.get()
    this.gl = this.renderer.gl

    this.w = 0
    this.h = 0
    this.regionW = 0
    this.regionH = 0
    this.fbos = {} // mask, frost ping-pong
    this.dirty = true
    this._raf = 0

    this.resize()
    this._loop = this._loop.bind(this)
    this._loop()
  }

  // ------------------------------------------------------------- public API

  setBlobs(blobs) {
    this.blobs = blobs.map(b => ({ x: b.x, y: b.y, r: b.r }))
    this.dirty = true
  }

  resize() {
    const rect = this.container.getBoundingClientRect()
    this.w = Math.max(1, Math.ceil(rect.width))
    this.h = Math.max(1, Math.ceil(rect.height))
    this.canvas.width = this.w
    this.canvas.height = this.h
    this.regionW = this.w + this.margin * 2
    this.regionH = this.h + this.margin * 2
    this.dirty = true
  }

  // ---------------------------------------------------------------- render

  _loop() {
    this._raf = requestAnimationFrame(this._loop)
    if (!this.dirty) return
    if (!this.renderer.pageTexture) return // capture not ready yet
    this.dirty = false
    this._render()
  }

  _ensureFBO(key, w, h) {
    const gl = this.gl
    let f = this.fbos[key]
    if (f && f.w >= w && f.h >= h) return f
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
    f = { fbo, tex, w, h }
    this.fbos[key] = f
    return f
  }

  _render() {
    const R = this.renderer
    const gl = this.gl
    const w = this.w
    const h = this.h
    if (!this.blobs.length) return

    const mask = this._ensureFBO('mask', w, h)
    const mBlur = { a: this._ensureFBO('mBlurA', w, h), b: this._ensureFBO('mBlurB', w, h) }
    const frost = this._ensureFBO('frost', this.regionW, this.regionH)

    // ---- 1) mask: draw blobs (additive alpha) ----------------------------
    const maskProg = R.program('gooey-mask', R.vs(), this.fsMask())
    gl.bindFramebuffer(gl.FRAMEBUFFER, mask.fbo)
    gl.viewport(0, 0, w, h)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE)
    gl.useProgram(maskProg)
    R.bindQuad(maskProg)
    gl.uniform2f(gl.getUniformLocation(maskProg, 'u_resolution'), w, h)
    for (const b of this.blobs.slice(0, GooeyGlass.MAX_BLOBS)) {
      gl.uniform2f(gl.getUniformLocation(maskProg, 'u_center'), b.x, b.y)
      gl.uniform1f(gl.getUniformLocation(maskProg, 'u_radius'), b.r)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
    gl.disable(gl.BLEND)

    // ---- 2) goo: Kawase blur the mask ------------------------------------
    // NOTE: drawKawase's offset is in UV units (the shader adds it to
    // v_texcoord directly), so full-res pixel radii must be divided by the
    // texture size.
    const radius = Math.max(0, Math.min(30, this.blur))
    const passes = radius < 0.5 ? 0 : radius < 3 ? 2 : 3
    let src = mask
    let dst = mBlur.a
    for (let i = 0; i < passes; i++) {
      const px = (0.5 + i) * radius * 0.3
      R.drawKawase(src, dst, px / w, px / h)
      const tmp = src
      src = dst
      dst = src === mBlur.a ? mBlur.b : mBlur.a
    }

    // ---- 3) frost: sample page region + Kawase blur -----------------------
    const p = this.containerCenter()
    const sampleProg = R.program('sample', R.vs(), R.fsSample())
    gl.bindFramebuffer(gl.FRAMEBUFFER, frost.fbo)
    gl.viewport(0, 0, frost.w, frost.h)
    gl.useProgram(sampleProg)
    R.bindQuad(sampleProg)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, R.pageTexture)
    gl.uniform1i(gl.getUniformLocation(sampleProg, 'u_source'), 0)
    gl.uniform2f(gl.getUniformLocation(sampleProg, 'u_sourceSize'), R.pageSize.w, R.pageSize.h)
    gl.uniform2f(
      gl.getUniformLocation(sampleProg, 'u_origin'),
      p.x + R.scrollX - R.scrollAtCapture.x - this.regionW / 2,
      p.y + R.scrollY - R.scrollAtCapture.y - this.regionH / 2
    )
    gl.uniform2f(gl.getUniformLocation(sampleProg, 'u_regionSize'), this.regionW, this.regionH)
    gl.drawArrays(gl.TRIANGLES, 0, 6)

    const fBlur = { a: this._ensureFBO('fBlurA', this.regionW, this.regionH), b: this._ensureFBO('fBlurB', this.regionW, this.regionH) }
    const fpasses = this.frost < 0.5 ? 0 : 2
    let fsrc = frost
    let fdst = fBlur.a
    for (let i = 0; i < fpasses; i++) {
      const px = (0.5 + i) * this.frost * 0.3
      R.drawKawase(fsrc, fdst, px / this.regionW, px / this.regionH)
      const tmp = fsrc
      fsrc = fdst
      fdst = fsrc === fBlur.a ? fBlur.b : fBlur.a
    }

    // ---- 4) glass: material x gooey mask ----------------------------------
    const matProg = R.program('gooey-glass', R.vs(), this.fsGlass())
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._ensureFBO('out', w, h).fbo)
    gl.viewport(0, 0, w, h)
    gl.useProgram(matProg)
    R.bindQuad(matProg)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, fsrc.tex)
    gl.uniform1i(gl.getUniformLocation(matProg, 'u_frost'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, src.tex)
    gl.uniform1i(gl.getUniformLocation(matProg, 'u_mask'), 1)
    gl.uniform2f(gl.getUniformLocation(matProg, 'u_resolution'), w, h)
    gl.uniform2f(gl.getUniformLocation(matProg, 'u_regionSize'), this.regionW, this.regionH)
    gl.uniform1f(gl.getUniformLocation(matProg, 'u_margin'), this.margin)
    gl.uniform1f(gl.getUniformLocation(matProg, 'u_threshold'), this.threshold)
    gl.uniform1f(gl.getUniformLocation(matProg, 'u_gooContrast'), this.gooContrast)
    gl.uniform1f(gl.getUniformLocation(matProg, 'u_strength'), this.strength)
    gl.uniform1f(gl.getUniformLocation(matProg, 'u_chroma'), this.chroma)
    gl.uniform1f(gl.getUniformLocation(matProg, 'u_dome'), this.dome)
    gl.uniform1f(gl.getUniformLocation(matProg, 'u_edgeBand'), this.edgeBand)
    gl.uniform1f(gl.getUniformLocation(matProg, 'u_edgeWidth'), this.edgeWidth)
    gl.uniform1f(gl.getUniformLocation(matProg, 'u_tint'), this.tint)
    gl.uniform1f(gl.getUniformLocation(matProg, 'u_glint'), this.glint)
    // blob centers (container px) as uniform arrays
    const centers = new Float32Array(GooeyGlass.MAX_BLOBS * 2)
    const radii = new Float32Array(GooeyGlass.MAX_BLOBS)
    this.blobs.slice(0, GooeyGlass.MAX_BLOBS).forEach((b, i) => {
      centers[i * 2] = b.x
      centers[i * 2 + 1] = b.y
      radii[i] = b.r
    })
    gl.uniform2fv(gl.getUniformLocation(matProg, 'u_blobCenters'), centers)
    gl.uniform1fv(gl.getUniformLocation(matProg, 'u_blobRadii'), radii)
    gl.drawArrays(gl.TRIANGLES, 0, 6)

    // ---- 5) blit to the DOM canvas ----------------------------------------
    const out = this.fbos.out
    R.blitToCanvas(
      { canvas: this.canvas, ctx2d: this.ctx2d },
      { fbo: out.fbo, tex: out.tex, w, h }
    )
  }

  containerCenter() {
    const rect = this.canvas.getBoundingClientRect()
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    }
  }

  // ---------------------------------------------------------------- shaders

  fsMask() {
    return `
    precision mediump float;
    uniform vec2 u_resolution;
    uniform vec2 u_center;
    uniform float u_radius;
    varying vec2 v_texcoord;
    void main() {
      vec2 px = v_texcoord * u_resolution;
      float d = length(px - u_center) - u_radius;
      float a = 1.0 - smoothstep(-1.0, 1.0, d);
      gl_FragColor = vec4(1.0, 1.0, 1.0, a);
    }
  `
  }

  fsGlass() {
    return `
    precision mediump float;
    uniform sampler2D u_frost;
    uniform sampler2D u_mask;
    uniform vec2 u_resolution;
    uniform vec2 u_regionSize;
    uniform float u_margin;
    uniform float u_threshold;
    uniform float u_gooContrast;
    uniform float u_strength;
    uniform float u_chroma;
    uniform float u_dome;
    uniform float u_edgeBand;
    uniform float u_edgeWidth;
    uniform float u_tint;
    uniform float u_glint;
    uniform vec2 u_blobCenters[8];
    uniform float u_blobRadii[8];
    varying vec2 v_texcoord;

    void main() {
      vec2 px = v_texcoord * u_resolution;

      // Gooey silhouette: blurred mask alpha -> contrast
      float m = texture2D(u_mask, v_texcoord).a;
      float goo = clamp((m - u_threshold) * u_gooContrast, 0.0, 1.0);
      if (goo < 0.003) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
        return;
      }

      // Nearest blob center drives the dome lens
      vec2 nearest = vec2(u_resolution * 0.5);
      float nearR = 1e5;
      for (int i = 0; i < 8; i++) {
        float r = u_blobRadii[i];
        if (r > 0.5) {
          vec2 c = u_blobCenters[i];
          float d = distance(px, c);
          if (d < nearR) { nearR = d; nearest = c; }
        }
      }

      vec2 fromCenter = px - nearest;
      float distC = length(fromCenter);
      vec2 dir = distC > 1.0 ? -fromCenter / distC : vec2(0.0);

      // Per-blob dome magnification (the liquid lens)
      float R = nearR * 1.1;
      float rr = clamp(distC, 0.0, R * 0.999);
      float domeMag = rr / sqrt(max(R * R - rr * rr, 1e-6));
      domeMag = min(domeMag, 4.0);

      // MERGED-shape edge: a soft band where the gooey mask crosses the
      // threshold. This is the glass rim — one continuous rim around the
      // whole merged blob, not per-disc outlines.
      float band = exp(-abs(m - u_threshold) * 14.0);

      vec2 disp = dir * u_strength * (u_edgeBand * band * 0.5 + u_dome * domeMag);

      // Frosted page sample with chroma split
      vec2 regionUV = (px + u_margin) / u_regionSize;
      vec2 dispUV = disp / u_regionSize;
      vec3 col = vec3(
        texture2D(u_frost, regionUV + dispUV * (1.0 + u_chroma * 0.2)).r,
        texture2D(u_frost, regionUV + dispUV * (1.0 + u_chroma * 0.1)).g,
        texture2D(u_frost, regionUV + dispUV).b
      );

      // Tint
      col = mix(col, vec3(1.0, 1.0, 1.0), u_tint);

      // Specular glint on the merged rim, lit from the top-left
      float lit = 0.5 + 0.5 * (1.0 - v_texcoord.x) * (1.0 - v_texcoord.y) * 2.0;
      col += band * u_glint * lit * 0.6;

      gl_FragColor = vec4(col, goo);
    }
  `
  }
}

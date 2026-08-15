// button.js — glass button element (extends Container).
//
// Nested buttons (added to a Container via addChild) sample the parent's
// rendered FBO texture directly on the GPU — no per-frame canvas readback.
// Standalone buttons sample the shared viewport page texture like containers.

class Button extends Container {
  constructor(options = {}) {
    const text = options.text || 'Button'
    const fontSize = parseInt(options.size) || 48
    const onClick = options.onClick || null
    const type = options.type || 'rounded' // "rounded", "circle", or "pill"
    const warp = options.warp !== undefined ? options.warp : false // Center warping disabled by default
    const tintOpacity = options.tintOpacity !== undefined ? options.tintOpacity : 0.2

    // Call parent constructor (border radius will be set in setSizeFromText)
    super({
      borderRadius: fontSize,
      type: type,
      tintOpacity: tintOpacity
    })

    this.isButton = true
    this.text = text
    this.fontSize = fontSize
    this.onClick = onClick
    this.type = type
    this.warp = warp
    this.parent = null // Will be set if added to container
    this.isNestedGlass = false

    // Add button-specific styling and content
    this.element.classList.add('glass-button')
    if (this.type === 'circle') {
      this.element.classList.add('glass-button-circle')
    }
    this.createTextElement()
    this.setupClickHandler()
    this.setSizeFromText()
  }

  setSizeFromText() {
    let width, height

    // Handle different button types
    if (this.type === 'circle') {
      // For circles, use 2.5x the fontSize for both dimensions
      const circleSize = this.fontSize * 2.5
      width = circleSize
      height = circleSize
      this.borderRadius = circleSize / 2 // 50% for perfect circle

      // Force exact square dimensions for circles
      this.element.style.width = width + 'px'
      this.element.style.height = height + 'px'
      this.element.style.minWidth = width + 'px'
      this.element.style.minHeight = height + 'px'
      this.element.style.maxWidth = width + 'px'
      this.element.style.maxHeight = height + 'px'

      this.element.style.borderRadius = this.borderRadius + 'px'
      this.setSize(width, height)
    } else if (this.type === 'pill') {
      // For pill buttons, calculate height first, then set border radius to half height
      const textMetrics = Button.measureText(this.text, this.fontSize)
      width = Math.ceil(textMetrics.width + this.fontSize * 2)
      height = Math.ceil(this.fontSize + this.fontSize * 1.2) // Slightly less padding for pills
      this.borderRadius = height / 2 // Half height for perfect capsule proportions
      this.element.style.minWidth = width + 'px'
      this.element.style.minHeight = height + 'px'

      // Force exact pill dimensions for perfect capsule rendering
      this.element.style.width = width + 'px'
      this.element.style.height = height + 'px'
      this.element.style.maxWidth = width + 'px'
      this.element.style.maxHeight = height + 'px'

      this.element.style.borderRadius = this.borderRadius + 'px'
      this.setSize(width, height)
    } else {
      // For rounded buttons, calculate dimensions from text
      const textMetrics = Button.measureText(this.text, this.fontSize)
      width = Math.ceil(textMetrics.width + this.fontSize * 2)
      height = Math.ceil(this.fontSize + this.fontSize * 1.5)
      this.borderRadius = this.fontSize
      this.element.style.minWidth = width + 'px'
      this.element.style.minHeight = height + 'px'

      // Apply border radius to element
      this.element.style.borderRadius = this.borderRadius + 'px'

      // Update size from DOM after CSS applies
      this.updateSizeFromDOM()
    }

    if (this.canvas) {
      this.canvas.style.borderRadius = this.borderRadius + 'px'
    }
  }

  setupAsNestedGlass() {
    if (this.parent && !this.isNestedGlass) {
      this.isNestedGlass = true
      // No GL re-init needed: GlassRenderer reads parent/source at draw time.
      GlassRenderer.get().markDirty()
    }
  }

  static measureText(text, fontSize) {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    ctx.font = `${fontSize}px system-ui, -apple-system, sans-serif`
    return ctx.measureText(text)
  }

  createTextElement() {
    this.textElement = document.createElement('div')
    this.textElement.className = 'glass-button-text'
    this.textElement.textContent = this.text
    this.textElement.style.fontSize = this.fontSize + 'px'

    this.element.appendChild(this.textElement)
  }

  setupClickHandler() {
    if (this.onClick && this.element) {
      this.element.addEventListener('click', e => {
        e.preventDefault()
        this.onClick(this.text)
      })
    }
  }
}

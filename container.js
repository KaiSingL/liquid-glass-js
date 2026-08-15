// container.js — glass container element.
//
// Rendering lives in GlassRenderer (renderer.js): one shared WebGL context,
// per-element FBOs, Dual Kawase blur, viewport-only page capture and
// dirty-flag rendering. This class handles DOM structure, sizing and the
// public API only.

class Container {
  static instances = []

  constructor(options = {}) {
    this.width = 0 // Will be set from DOM
    this.height = 0 // Will be set from DOM
    this.borderRadius = options.borderRadius || 48
    this.type = options.type || 'rounded' // "rounded", "circle", or "pill"
    this.tintOpacity = options.tintOpacity !== undefined ? options.tintOpacity : 0.2
    this.warp = options.warp !== undefined ? options.warp : false

    this.canvas = null
    this.ctx2d = null
    this.element = null
    this.children = [] // Child buttons/components
    this.parent = null // Set when added to another container
    this.depth = 0 // Nesting depth (render order: parents first)
    this.isNestedGlass = false
    this.isButton = false

    // Add to instances
    Container.instances.push(this)

    // Initialize
    this.createElement()
    this.setupCanvas()
    GlassRenderer.get().register(this)
    this.updateSizeFromDOM()
  }

  addChild(child) {
    this.children.push(child)
    child.parent = this
    child.depth = this.depth + 1

    // Add child's element to container
    if (child.element && this.element) {
      this.element.appendChild(child.element)
    }

    // If child is a button, set up nested glass
    if (child instanceof Button) {
      child.setupAsNestedGlass()
    }

    // Update container size based on actual DOM size
    this.updateSizeFromDOM()

    return child
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index > -1) {
      this.children.splice(index, 1)
      child.parent = null
      child.isNestedGlass = false

      if (child.element && this.element.contains(child.element)) {
        this.element.removeChild(child.element)
      }

      // Update container size after removing child
      this.updateSizeFromDOM()
    }
  }

  updateSizeFromDOM() {
    // Wait for next frame to ensure DOM layout is complete
    requestAnimationFrame(() => {
      const rect = this.element.getBoundingClientRect()
      let newWidth = Math.ceil(rect.width)
      let newHeight = Math.ceil(rect.height)

      // Apply type-specific sizing logic
      if (this.type === 'circle') {
        // For circles, ensure perfect square
        const size = Math.max(newWidth, newHeight)
        newWidth = size
        newHeight = size
        this.borderRadius = size / 2 // 50% for perfect circle

        // Force exact square dimensions
        this.element.style.width = size + 'px'
        this.element.style.height = size + 'px'
        this.element.style.borderRadius = this.borderRadius + 'px'
      } else if (this.type === 'pill') {
        // For pills, border radius is half the height
        this.borderRadius = newHeight / 2
        this.element.style.borderRadius = this.borderRadius + 'px'
      }

      this.canvas.style.borderRadius = this.borderRadius + 'px'

      if (newWidth !== this.width || newHeight !== this.height) {
        this.setSize(newWidth, newHeight)
      }
    })
  }

  // Apply a new pixel size to the element and its canvas, then re-render.
  setSize(newWidth, newHeight) {
    this.width = newWidth
    this.height = newHeight

    this.canvas.width = newWidth
    this.canvas.height = newHeight
    this.canvas.style.width = newWidth + 'px'
    this.canvas.style.height = newHeight + 'px'

    GlassRenderer.get().markDirty()
  }

  createElement() {
    // Create wrapper element with CSS class
    this.element = document.createElement('div')
    this.element.className = 'glass-container'

    // Add type-specific classes
    if (this.type === 'circle') {
      this.element.classList.add('glass-container-circle')
    } else if (this.type === 'pill') {
      this.element.classList.add('glass-container-pill')
    }

    this.element.style.borderRadius = this.borderRadius + 'px'

    // Create canvas (will be sized after DOM layout)
    this.canvas = document.createElement('canvas')
    this.canvas.style.borderRadius = this.borderRadius + 'px'
    this.canvas.style.position = 'absolute'
    this.canvas.style.top = '0'
    this.canvas.style.left = '0'
    this.canvas.style.width = '100%'
    this.canvas.style.height = '100%'
    this.canvas.style.boxShadow = '0 25px 50px rgba(0, 0, 0, 0.25)'
    this.canvas.style.zIndex = '-1' // Canvas behind children

    this.element.appendChild(this.canvas)
  }

  setupCanvas() {
    // 2D context: the shared GlassRenderer renders this element into its FBO
    // and composites the result here via drawImage each frame.
    this.ctx2d = this.canvas.getContext('2d')
  }

  getPosition() {
    // Get actual screen position using getBoundingClientRect
    const rect = this.canvas.getBoundingClientRect()
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    }
  }

  // Public: request a re-render on the next frame (no-op if nothing changed).
  render() {
    GlassRenderer.get().markDirty()
  }

  // Compatibility shim: page capture now lives on GlassRenderer.
  capturePageSnapshot() {
    GlassRenderer.get().capturePage()
  }
}

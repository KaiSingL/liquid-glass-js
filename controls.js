// Glass Controls System
window.glassControls = {
  edgeIntensity: 0.8, // edge band refraction strength
  rimIntensity: 0.5, // specular glint strength
  baseIntensity: 0.5, // dome magnification strength
  edgeDistance: 6, // edge band width (px)
  rimDistance: 4, // glint sharpness
  baseDistance: 1.2, // dome radius scale
  cornerBoost: 0.3,
  rippleEffect: 0.08,
  blurRadius: 5.0,
  tintOpacity: 0.2,
  warp: true, // dome lens enabled by default
  lensStrength: 14, // overall displacement (px)
  chroma: 0.4, // chromatic aberration
  vibrancy: 0.12, // adaptive brightness pull
  hideButtons: false
}

// Update all glass instances with new parameters.
// GlassRenderer reads window.glassControls fresh on every frame, so a single
// dirty flag is all that's needed.
function updateAllGlassInstances() {
  GlassRenderer.get().markDirty()
}

// Set up slider event listeners
function setupControlSliders() {
  const sliders = [
    { id: 'edgeIntensity', prop: 'edgeIntensity', valueId: 'edgeValue' },
    { id: 'rimIntensity', prop: 'rimIntensity', valueId: 'rimValue' },
    { id: 'baseIntensity', prop: 'baseIntensity', valueId: 'baseValue' },
    { id: 'edgeDistance', prop: 'edgeDistance', valueId: 'edgeDistValue' },
    { id: 'rimDistance', prop: 'rimDistance', valueId: 'rimDistValue' },
    { id: 'baseDistance', prop: 'baseDistance', valueId: 'baseDistValue' },
    { id: 'cornerBoost', prop: 'cornerBoost', valueId: 'cornerValue' },
    { id: 'rippleEffect', prop: 'rippleEffect', valueId: 'rippleValue' },
    { id: 'blurRadius', prop: 'blurRadius', valueId: 'blurValue' },
    { id: 'tintOpacity', prop: 'tintOpacity', valueId: 'tintValue' },
    { id: 'lensStrength', prop: 'lensStrength', valueId: 'lensValue' },
    { id: 'chroma', prop: 'chroma', valueId: 'chromaValue' }
  ]

  sliders.forEach(({ id, prop, valueId }) => {
    const slider = document.getElementById(id)
    const valueDisplay = document.getElementById(valueId)

    if (slider && valueDisplay) {
      slider.addEventListener('input', e => {
        const value = parseFloat(e.target.value)
        window.glassControls[prop] = value
        valueDisplay.textContent = value.toFixed(3)
        updateAllGlassInstances()
      })
    }
  })

  // Set up warp toggle checkbox
  const warpToggle = document.getElementById('warpToggle')
  if (warpToggle) {
    warpToggle.addEventListener('change', e => {
      window.glassControls.warp = e.target.checked
      updateAllGlassInstances()
    })
  }

  // Set up hide buttons toggle checkbox
  const hideButtonsToggle = document.getElementById('hideButtonsToggle')
  if (hideButtonsToggle) {
    hideButtonsToggle.addEventListener('change', e => {
      window.glassControls.hideButtons = e.target.checked
      toggleButtonsVisibility()
    })
  }

  // Set up randomize button
  const randomizeButton = document.getElementById('randomizeButton')
  if (randomizeButton) {
    randomizeButton.addEventListener('click', () => {
      randomizeGlassEffects()
    })
  }
}

// Function to randomize glass effect values for creative exploration
function randomizeGlassEffects() {
  // Generate random values within creative ranges (avoiding extremes)
  const randomValues = {
    edgeIntensity: 0.2 + Math.random() * 0.8, // edge band 0.2-1.0
    rimIntensity: 0.1 + Math.random() * 0.9, // glint 0.1-1.0
    baseIntensity: 0.1 + Math.random() * 0.9, // dome 0.1-1.0
    edgeDistance: 2 + Math.random() * 14, // edge width 2-16px
    rimDistance: 1 + Math.random() * 8, // glint sharpness 1-9
    baseDistance: 0.6 + Math.random() * 1.4, // dome radius 0.6-2.0
    cornerBoost: Math.random(), // 0-1
    rippleEffect: Math.random() * 0.5, // 0-0.5
    blurRadius: 2 + Math.random() * 10, // 2-12
    tintOpacity: 0.1 + Math.random() * 0.7, // 0.1-0.8
    lensStrength: 4 + Math.random() * 20, // 4-24
    chroma: Math.random(), // 0-1
    warp: Math.random() < 0.7 // 70% chance
  }

  // Update global controls
  Object.assign(window.glassControls, randomValues)

  // Update all sliders and their display values
  Object.entries(randomValues).forEach(([key, value]) => {
    if (key === 'warp') {
      const checkbox = document.getElementById('warpToggle')
      if (checkbox) {
        checkbox.checked = value
      }
    } else {
      // Find corresponding slider and value display
      const sliderConfig = [
        { prop: 'edgeIntensity', id: 'edgeIntensity', valueId: 'edgeValue' },
        { prop: 'rimIntensity', id: 'rimIntensity', valueId: 'rimValue' },
        { prop: 'baseIntensity', id: 'baseIntensity', valueId: 'baseValue' },
        { prop: 'edgeDistance', id: 'edgeDistance', valueId: 'edgeDistValue' },
        { prop: 'rimDistance', id: 'rimDistance', valueId: 'rimDistValue' },
        { prop: 'baseDistance', id: 'baseDistance', valueId: 'baseDistValue' },
        { prop: 'cornerBoost', id: 'cornerBoost', valueId: 'cornerValue' },
        { prop: 'rippleEffect', id: 'rippleEffect', valueId: 'rippleValue' },
        { prop: 'blurRadius', id: 'blurRadius', valueId: 'blurValue' },
        { prop: 'tintOpacity', id: 'tintOpacity', valueId: 'tintValue' },
        { prop: 'lensStrength', id: 'lensStrength', valueId: 'lensValue' },
        { prop: 'chroma', id: 'chroma', valueId: 'chromaValue' }
      ].find(config => config.prop === key)

      if (sliderConfig) {
        const slider = document.getElementById(sliderConfig.id)
        const valueDisplay = document.getElementById(sliderConfig.valueId)

        if (slider) {
          slider.value = value
        }
        if (valueDisplay) {
          valueDisplay.textContent = value.toFixed(3)
        }
      }
    }
  })

  // Apply the randomized values to all glass instances
  updateAllGlassInstances()

  console.log('🎲 Glass effects randomized!', randomValues)
}

// Function to toggle visibility of all glass buttons/containers
function toggleButtonsVisibility() {
  const demoLayout = document.getElementById('demo-layout')
  if (demoLayout) {
    demoLayout.style.display = window.glassControls.hideButtons ? 'none' : 'flex'
  }
}

// Create glass container for controls panel
function initializeControlsContainer() {
  window.controlsContainer = new Container({
    borderRadius: 12,
    type: 'rounded',
    tintOpacity: 0.7
  })

  // Get the existing controls wrapper and move existing content behind the glass
  const controlsWrapper = document.getElementById('glass-controls-container')
  const controlsContent = document.getElementById('controls-content')

  // Remove controls content from wrapper temporarily
  controlsWrapper.removeChild(controlsContent)

  // Add glass container to wrapper
  controlsWrapper.appendChild(window.controlsContainer.element)

  // Add controls content back on top of glass
  window.controlsContainer.element.appendChild(controlsContent)

  // Force the container to update its size based on CSS
  setTimeout(() => {
    window.controlsContainer.updateSizeFromDOM()
  }, 100)
}

// Mobile controls toggle functionality
function setupMobileToggle() {
  const toggleButton = document.getElementById('mobile-controls-toggle')
  const controlsContainer = document.getElementById('glass-controls-container')

  if (toggleButton && controlsContainer) {
    toggleButton.addEventListener('click', () => {
      const isVisible = controlsContainer.classList.contains('mobile-visible')

      if (isVisible) {
        // Hide controls
        controlsContainer.classList.remove('mobile-visible')
        toggleButton.classList.remove('active')
        toggleButton.setAttribute('aria-expanded', 'false')
      } else {
        // Show controls
        controlsContainer.classList.add('mobile-visible')
        toggleButton.classList.add('active')
        toggleButton.setAttribute('aria-expanded', 'true')
      }
    })

    // Close controls when clicking outside on mobile
    document.addEventListener('click', event => {
      // Only on mobile screens
      if (window.innerWidth <= 768) {
        const isVisible = controlsContainer.classList.contains('mobile-visible')
        const clickedInsideControls = controlsContainer.contains(event.target)
        const clickedToggleButton = toggleButton.contains(event.target)

        if (isVisible && !clickedInsideControls && !clickedToggleButton) {
          controlsContainer.classList.remove('mobile-visible')
          toggleButton.classList.remove('active')
          toggleButton.setAttribute('aria-expanded', 'false')
        }
      }
    })

    // Initialize toggle button accessibility
    toggleButton.setAttribute('aria-expanded', 'false')
  }
}

// Initialize controls system
function initializeControls() {
  initializeControlsContainer()
  setupControlSliders()
  setupMobileToggle()
}

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeControls)
} else {
  initializeControls()
}

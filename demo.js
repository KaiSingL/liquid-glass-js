// Get demo layout containers from HTML
const helloRow = document.querySelector('#hello-row')
const controlsRow = document.querySelector('#controls-row')
const containerRow = document.querySelector('#container-row')
const standaloneRow = document.querySelector('#standalone-row')

// Row 1: Hello button
const helloButton = new Button({
  text: 'Hello 🍏',
  size: '36',
  type: 'rounded',
  onClick: text => alert(`You clicked: ${text}`)
})
helloRow.appendChild(helloButton.element)

// Row 3: Control buttons (play, record, next)
const playButton = new Button({
  text: '▶',
  size: '32',
  type: 'circle',
  onClick: text => alert(`Play clicked!`)
})

const recordButton = new Button({
  text: '⏺',
  size: '32',
  type: 'circle',
  onClick: text => alert(`Record clicked!`)
})

const nextButton = new Button({
  text: '⏭',
  size: '32',
  type: 'circle',
  onClick: text => alert(`Next clicked!`)
})

controlsRow.appendChild(playButton.element)
controlsRow.appendChild(recordButton.element)
controlsRow.appendChild(nextButton.element)

// Row 4: Container with nested glass buttons (pill shape)
const buttonContainer = new Container({
  borderRadius: 24,
  type: 'pill'
})

const button1 = new Button({
  text: 'Click Me!',
  size: '24',
  type: 'pill',
  onClick: text => alert(`Button pressed: ${text}`)
})

const button2 = new Button({
  text: '✓',
  size: '24',
  type: 'circle',
  onClick: text => alert(`Glass button clicked: ${text}`)
})

// Add buttons to container (sets up nested glass automatically)
buttonContainer.addChild(button1)
buttonContainer.addChild(button2)
containerRow.appendChild(buttonContainer.element)

// Row 5: Standalone button
const standaloneButton = new Button({
  text: 'Standalone',
  size: '24',
  type: 'pill',
  onClick: text => alert(`Standalone button: ${text}`)
})
standaloneRow.appendChild(standaloneButton.element)

// Window resize is handled by GlassRenderer (debounced viewport recapture).

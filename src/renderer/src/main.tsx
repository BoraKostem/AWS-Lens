import React from 'react'
import ReactDOM from 'react-dom/client'

import { App } from './App'
import 'xterm/css/xterm.css'
import './styles.css'
import './console-shared.css'

// In web mode (no Electron preload), inject the fetch-based bridge
if (!window.awsLens) {
  const { webBridge } = await import('./webBridge')
  window.awsLens = webBridge
}
if (!window.terraformWorkspace) {
  const { terraformBridge } = await import('./webBridge')
  // @ts-expect-error
  window.terraformWorkspace = terraformBridge
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

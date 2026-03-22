import React from 'react'
import ReactDOM from 'react-dom/client'

import { App } from './App'
import 'xterm/css/xterm.css'
import './styles.css'
import './console-shared.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

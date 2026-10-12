import { Buffer } from 'buffer'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// @solana/web3.js reaches for Node globals that browsers do not define.
const globals = globalThis as { Buffer?: unknown }
if (!globals.Buffer) globals.Buffer = Buffer

import App from './App'
import './styles/global.css'
import './styles/sections.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

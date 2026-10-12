import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The site is a static SPA: no backend required.
// `allowedHosts: true` keeps the Vite dev server reachable through sandbox /
// tunnel previews (the browser origin is a proxy host, not localhost).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // @solana/web3.js is written for Node; expose the globals it expects.
  define: {
    global: 'globalThis',
    'process.env': {},
  },
  // NOTE: no `optimizeDeps` override — Vite 8 pre-bundles with Rolldown and
  // propagates the top-level `define` into the dep graph.
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
})

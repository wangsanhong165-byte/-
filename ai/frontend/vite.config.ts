import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import services from '../config/services.json'

const bridgeTarget = process.env.BRIDGE_URL
  ?? `http://${services.bridge.host}:${services.bridge.port}`
const bridgeWsTarget = bridgeTarget.replace(/^http/, 'ws')
const frontendPort = Number(process.env.PORT ?? process.env.FRONTEND_PORT ?? services.frontend.port)

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: frontendPort,
    // PORT/FRONTEND_PORT pin the port explicitly (Bridge proxy targets,
    // Electron VITE_URL); a bare dev start may drift +1 when the port is
    // taken rather than failing.
    strictPort: Boolean(process.env.PORT || process.env.FRONTEND_PORT),
    proxy: {
      '/api': {
        target: bridgeTarget,
        changeOrigin: true,
      },
      '/client-ws': {
        target: bridgeWsTarget,
        ws: true,
      },
      '/live2d-models': {
        target: bridgeTarget,
        changeOrigin: true,
      },
    },
  },
})
